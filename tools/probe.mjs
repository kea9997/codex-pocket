// Read-only protocol probe. No resume, start, fork, login, config or filesystem RPC.
import { Rpc } from '../server/rpc.mjs';

const rpc = new Rpc({ timeoutMs: 20000 });
const report = { service: 'codex-phone-probe', readOnly: true };
rpc.on('request', msg => rpc.reject(msg.id));
try {
  await rpc.start();
  report.initialize = 'ok';
  const account = await rpc.request('account/read', { refreshToken: false });
  report.account = { type: account.account?.type ?? 'none', planType: account.account?.planType ?? null,
    companyIdentityVerified: false };
  const list = await rpc.request('thread/list', { limit: 10, sortKey: 'updated_at',
    sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true });
  report.list = { count: list.data.length, hasMore: Boolean(list.nextCursor),
    sources: [...new Set(list.data.map(t => typeof t.source === 'string' ? t.source : 'other'))],
    statuses: list.data.map(t => t.status?.type ?? 'absent') };
  const desktopSources = await rpc.request('thread/list', { limit: 3, sortKey: 'updated_at',
    sourceKinds: ['appServer'], useStateDbOnly: true });
  report.appServerSource = { count: desktopSources.data.length, hasMore: Boolean(desktopSources.nextCursor) };
  const selected = desktopSources.data[0] ?? list.data[0];
  if (selected) {
    const read = await rpc.request('thread/read', { threadId: selected.id, includeTurns: false });
    report.read = { sameId: read.thread.id === selected.id, status: read.thread.status?.type,
      source: typeof read.thread.source === 'string' ? read.thread.source : 'other' };
    try {
      const page = await rpc.request('thread/turns/list', { threadId: selected.id,
        limit: 2, sortDirection: 'desc', itemsView: 'full' });
      report.history = { count: page.data.length, hasMore: Boolean(page.nextCursor),
        itemTypes: [...new Set(page.data.flatMap(t => (t.items ?? []).map(i => i.type)))] };
      if (page.nextCursor) {
        const older = await rpc.request('thread/turns/list', { threadId: selected.id,
          limit: 2, cursor: page.nextCursor, sortDirection: 'desc', itemsView: 'full' });
        report.history.nextPageCount = older.data.length;
      }
    } catch (e) { report.history = { error: e.code, rpcCode: e.rpcCode ?? null }; }
  }
  report.continuation = 'NOT_TESTED: read-only probe cannot establish cross-process ownership, same-thread resume, retained desktop tools or busy locks';
} catch (e) {
  report.error = { code: e.code ?? 'PROBE_FAILED', rpcCode: e.rpcCode ?? null };
  process.exitCode = 1;
} finally {
  rpc.close();
}
console.log(JSON.stringify(report, null, 2));
