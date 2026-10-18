import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs';
import { Questions } from '../server/questions.mjs';
import { createBridge } from '../server/http.mjs';
import { ORIGIN } from '../server/security.mjs';
import { fixture, httpCall } from './helpers.mjs';
import { questionFixture, thread, turnId, record, question, reply, replyText, ordinalLines } from './questions-fixture.mjs';

const current = { id: turnId, status: 'inProgress' };
const rows = () => [record('session_meta', { id: thread }), record('turn_context', { turn_id: turnId }), question(), reply(), question('call_second'),
  record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: replyText('두 번째 답변', '어떻게 진행할까요?', 'call_second') }] })];
// Real Windows path semantics + bounded JSONL parser on every host, without changing process.platform.
// The explicit in-memory filesystem contains only synthetic fixtures, never actual Windows user paths.
function windowsSource(mode = {}) {
  const root = 'C:\\Users\\Fixture\\.codex\\sessions', file = root + `\\2026\\10\\16\\rollout-2026-10-16T01-00-00-${thread}.jsonl`;
  const bytes = Buffer.from(ordinalLines(rows())), nodes = new Map();
  let parent = path.win32.parse(file).root;
  for (const part of path.win32.relative(parent, file).split('\\')) {
    parent = path.win32.join(parent, part); const name = parent, isFile = name === file;
    nodes.set(name, { dev: 1, ino: nodes.size + 1, size: isFile ? mode.size ?? bytes.length : 0, mtimeMs: 1, ctimeMs: 1, nlink: isFile && mode.hardlink ? 2 : 1,
      isSymbolicLink: () => Boolean(mode.link && name === (mode.link === 'file' ? file : root)), isDirectory: () => !isFile, isFile: () => isFile });
  }
  const stats = [], opened = [], lengths = []; let active = 0, total = 0;
  const io = {
    lstatSync(name) { stats.push(name); assert.ok(nodes.has(name), 'Only exact fixture paths may be inspected'); return nodes.get(name); },
    realpathSync(name) { assert.ok(nodes.has(name)); return mode.redirect && name === root ? root + '-redirect' : name; },
    openSync(name) { assert.equal(name, file); opened.push(name); active++; return 1; },
    fstatSync(fd) { assert.equal(fd, 1); return { ...nodes.get(file), ...(mode.swap ? { ino: 999 } : {}) }; },
    readSync(fd, buffer, offset, length, position) { assert.equal(fd, 1); assert.equal(active, 1); lengths.push(length); const n = bytes.copy(buffer, offset, position, position + length); total += n; return n; },
    closeSync(fd) { assert.equal(fd, 1); active--; }
  };
  return { root, file, extended: '\\\\?\\' + file, io, stats, opened, lengths, bytes, active: () => active, total: () => total,
    metadata: async (name = '\\\\?\\' + file) => ({ thread: { id: thread, path: name } }) };
}

test('Questions.get accepts native Windows extended ordinary drive metadata, parses two answered questions and uses standard paths for every filesystem operation', async () => {
  const f = windowsSource(), platform = process.platform;
  const source = new Questions({ root: f.root, io: f.io, paths: path.win32 });
  const result = await source.get(thread, () => f.metadata(), current);
  assert.equal(result.state, 'ready'); assert.deepEqual(result.data.map(q => q.state), ['answered', 'answered']);
  assert.deepEqual(result.data.map(q => q.answer), ['기본 유지', '두 번째 답변']);
  assert.equal(source.cache.get(thread).file, f.file); assert.deepEqual(f.opened, [f.file]); assert.ok(f.stats.length > 0);
  assert.ok(f.stats.every(name => !name.startsWith('\\\\'))); assert.equal(f.active(), 0); assert.equal(f.total(), f.bytes.length); assert.ok(f.lengths.every(n => n <= 65536));
  assert.equal(process.platform, platform);
  for (const forbidden of [f.root, f.file, '\\\\?\\', 'session_meta', 'source_thread_id']) assert.ok(!JSON.stringify(result).includes(forbidden));
  const ordinary = await new Questions({ root: f.root, io: f.io, paths: path.win32 }).get(thread, () => f.metadata(f.file), current);
  assert.deepEqual(ordinary, result);
});
test('native extended metadata normalization rejects UNC/device/globalroot, relative, ADS, traversal and nonordinary drive variants before filesystem access', async () => {
  const f = windowsSource(), wrong = '33333333-3333-4333-8333-333333333333';
  const rejected = [
    '\\\\server\\share\\file.jsonl', '\\\\?\\UNC\\server\\share\\file.jsonl', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\file.jsonl',
    '\\\\.\\C:\\file.jsonl', '\\??\\C:\\file.jsonl', '\\\\?\\Volume{fixture}\\file.jsonl', '\\\\?\\C:relative.jsonl', '\\\\?\\relative.jsonl',
    '//?/C:/Users/Fixture/file.jsonl', '\\\\?\\C:/Users/Fixture/file.jsonl', '\\\\?\\' + f.file.replace('\\sessions\\', '\\sessions/'),
    f.extended + ':stream', f.extended.replace('\\sessions\\', '\\sessions:stream\\'), f.extended.replace('\\2026\\', '\\..\\2026\\'),
    f.extended.replace('\\2026\\', '\\.\\2026\\'), f.extended.replace('\\2026\\', '\\\\2026\\'),
    f.extended.replace('\\sessions\\', '\\sessions.\\'), f.extended.replace('\\sessions\\', '\\sessions \\'),
    f.extended.replace('\\Fixture\\', '\\NUL\\'), f.extended.replace('\\Fixture\\', '\\COM1.txt\\'),
    f.extended.replace('\\2026\\', '\\%32%30%32%36\\'), f.extended + '\0', f.extended + 'x'.repeat(4096),
    f.extended.replace(thread, wrong), f.extended.replace('\\sessions\\', '\\other-root\\'), f.extended.replace('\\2026\\10\\16\\', '\\2026\\10\\'),
    f.extended.replace('\\2026\\', '\\year\\'), 'C:relative.jsonl', 'relative.jsonl', 'file:///' + f.file
  ];
  for (const name of rejected) {
    const result = await new Questions({ root: f.root, io: f.io, paths: path.win32 }).get(thread, () => f.metadata(name), current);
    assert.deepEqual(result, { state: 'unavailable', data: [] }, name);
  }
  const mismatched = await new Questions({ root: f.root, io: f.io, paths: path.win32 }).get(thread, async () => ({ thread: { id: wrong, path: f.extended } }), current);
  assert.deepEqual(mismatched, { state: 'unavailable', data: [] }); assert.equal(f.stats.length, 0); assert.equal(f.opened.length, 0); assert.equal(f.total(), 0);
});
test('extended metadata still rejects symlink/junction, hardlink, canonical redirect and swapped open identity without reading log contents', async () => {
  // Oversized regular sources now have their own bounded recent-window tests, not a blanket size rejection.
  for (const mode of [{ link: 'file' }, { link: 'directory' }, { hardlink: true }, { redirect: true }, { swap: true }]) {
    const f = windowsSource(mode), source = new Questions({ root: f.root, io: f.io, paths: path.win32 });
    assert.deepEqual(await source.get(thread, () => f.metadata(), current), { state: 'unavailable', data: [] });
    assert.equal(f.total(), 0); assert.equal(f.active(), 0);
    assert.equal(f.opened.length, mode.swap ? 1 : 0);
  }
});
test('real host filesystem preserves standard path support and native Windows extended metadata shares the incremental cache with its ordinary spelling', async t => {
  const f = questionFixture(t); fs.writeFileSync(f.file, ordinalLines(rows()));
  let now = 1, total = 0;
  const io = { ...fs, readSync(...args) { const n = fs.readSync(...args); total += n; return n; } };
  const source = new Questions({ root: f.root, io, now: () => now });
  const first = await source.get(thread, f.metadata, current); assert.deepEqual(first.data.map(q => q.state), ['answered', 'answered']);
  const initial = total; now += 30001;
  const name = path.sep === '\\' ? '\\\\?\\' + f.file : f.file;
  assert.deepEqual(await source.get(thread, async () => ({ thread: { id: thread, path: name } }), current), first);
  assert.equal(source.cache.get(thread).file, f.file); assert.ok(total - initial <= 64);
});
test('authenticated Questions HTTP uses extended readonly metadata only after own recent history, returning answered DTO without paths or raw logs', async t => {
  const f = await fixture(t), logs = windowsSource(); f.engine.questions = new Questions({ root: logs.root, io: logs.io, paths: path.win32 });
  f.desktop.hook = async (_tool, args) => ({ thread: f.desktop.thread(args.threadId), turns: [{ id: turnId, status: 'inProgress', items: [] }] });
  let metadataCalls = 0;
  f.engine.historyRpcFactory = async () => ({ closed: false, close() {}, async request(method, params) {
    metadataCalls++; assert.equal(method, 'thread/read'); assert.deepEqual(params, { threadId: thread, includeTurns: false }); return logs.metadata();
  } });
  const server = createBridge(f); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (route, options) => httpCall(server.address().port, route, options), route = `/api/threads/${thread}/questions`;
  assert.equal((await call(route)).status, 401); assert.equal(metadataCalls, 0);
  const code = JSON.parse(fs.readFileSync(path.join(f.dir, 'pairing.json'), 'utf8')).code;
  const paired = await call('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: { code } });
  const headers = { Cookie: paired.headers['set-cookie'][0].split(';')[0] };
  assert.equal((await call(route, { headers })).json.state, 'unavailable'); assert.equal(metadataCalls, 0);
  await call(`/api/threads/${thread}/history`, { headers });
  const result = await call(route, { headers }); assert.equal(result.status, 200); assert.equal(result.json.state, 'ready');
  assert.deepEqual(result.json.data.map(q => q.state), ['answered', 'answered']); assert.equal(metadataCalls, 1);
  for (const hidden of [logs.file, logs.root, 'session_meta', 'thread.path']) assert.ok(!result.text.includes(hidden));
  assert.equal((await call(route + '?path=' + encodeURIComponent(logs.extended), { headers })).status, 400);
  assert.equal((await f.engine.questionState(thread, { id: 'other-session' })).state, 'unavailable');
  assert.equal(f.engine.records.length, 0); assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread'));
});
