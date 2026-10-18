// Read-only desktop probe: tool catalog, list, read, wait. Never sends, creates, resumes or interrupts.
import { Desktop, DESKTOP_TOOLS } from '../server/desktop.mjs';
import { loadConfig } from '../server/config.mjs';
const config = loadConfig(process.argv[2]);
const desktop = new Desktop({ controllerId: config.controllerThreadId });
const report = { service: 'codex-phone-desktop-probe', readOnly: true };
try {
  const tools = await desktop.tools();
  report.catalog = { count: tools.length, supported: DESKTOP_TOOLS.filter(n => tools.some(t => t.name === n)),
    stopApprovalTools: tools.filter(t => /interrupt|approval|approve|stop_turn/.test(t.name)).map(t => t.name) };
  const list = await desktop.call('list_threads', { limit: 3 });
  report.list = { keys: Object.keys(list), schemaVersion: list.schemaVersion,
    pinnedCount: list.pinnedThreads?.length ?? 0, threadCount: list.threads?.length ?? 0 };
  const rows = [...(list.pinnedThreads ?? []), ...(list.threads ?? [])];
  const local = rows.filter(t => t.kind === 'codex' && t.hostId === 'local');
  const selected = local.find(t => t.status?.type === 'active') ?? local.find(t => t.status?.type === 'idle') ?? local[0];
  report.localCodexCount = rows.filter(t => t.kind === 'codex' && t.hostId === 'local').length;
  if (selected) {
    report.threadShape = { keys: Object.keys(selected), status: selected.status?.type ?? selected.status };
    const read = await desktop.call('read_thread', { threadId: selected.id, hostId: 'local', turnLimit: 2,
      includeOutputs: true, maxOutputCharsPerItem: 6000 });
    report.read = { keys: Object.keys(read), sameId: read.thread?.id === selected.id,
      status: read.thread?.status?.type, turnCount: read.turns?.length, hasMore: read.page?.hasMore,
      pageKeys: Object.keys(read.page ?? {}), turnKeys: Object.keys(read.turns?.[0] ?? {}),
      hasNextCursor: typeof read.page?.nextCursor === 'string', order: read.page?.order,
      newestFirstByTime: read.turns?.length >= 2 ? read.turns[0].startedAt >= read.turns[1].startedAt : null,
      itemTypes: [...new Set((read.turns ?? []).flatMap(t => (t.items ?? []).map(i => i.type)))] };
    try {
      const wait = await desktop.call('wait_threads', { targets: [{ threadId: selected.id, hostId: 'local' }], timeoutMs: 0 });
      report.wait = { keys: Object.keys(wait), schemaVersion: wait.schemaVersion };
    } catch (e) {
      report.wait = { supportedInCatalog: true, runtimeVerified: false, error: e.code ?? 'WAIT_FAILED',
        fallback: 'visibility-aware read_thread polling; production does not depend on wait_threads' };
      process.exitCode = 1;
    }
  }
  report.sending = 'NOT_TESTED';
} catch (e) { report.error = e.code ?? 'DESKTOP_PROBE_FAILED'; process.exitCode = 1; }
finally { desktop.close(); }
console.log(JSON.stringify(report, null, 2));
