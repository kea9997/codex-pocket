import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Engine, item } from '../server/engine.mjs';
import { BridgeError } from '../server/rpc.mjs';
import { fixture, temp, MockDesktop, waitFor } from './helpers.mjs';
import { saveJson } from '../server/security.mjs';
import { join } from 'node:path';

const session = { id: 'fixture-session' };
const input = () => ({ threadId: 'thread-fixture', requestId: randomUUID(), text: '같은 대화에서 이어서 작업' });
const rejects = (p, code) => assert.rejects(p, e => e.code === code);

test('all stored cursor pages use read-only app-server and merge desktop title/status without rewriting title', async t => {
  const { engine, calls } = await fixture(t);
  const first = await engine.list({ search: '제목' });
  assert.equal(first.data[0].id, 'thread-fixture'); assert.equal(first.data[0].title, 'PC 실시간 제목');
  assert.equal(first.scope, 'all-stored'); assert.equal(first.nextCursor, 'list-2');
  assert.equal((await engine.list({ cursor: first.nextCursor })).data.length, 0);
  assert.deepEqual(calls[0].params.sourceKinds, ['cli', 'vscode', 'appServer']);
  assert.equal(calls[0].params.searchTerm, '제목'); assert.equal(calls[0].params.useStateDbOnly, true);
  assert.ok(calls.every(c => c.method === 'thread/list'));
});
test('native fallback explicitly labels recent50 limit; stored cursor never silently ignored', async t => {
  const engine = new Engine(new MockDesktop(), temp(t));
  const list = await engine.list(); assert.equal(list.scope, 'recent-desktop'); assert.match(list.warning, /50/);
  await rejects(engine.list({ cursor: 'next' }), 'HISTORY_PAGINATION_UNAVAILABLE');
});
test('desktop read/poll returns actual selected ID, status and history cursors, omits reasoning', async t => {
  const { engine, desktop } = await fixture(t);
  const meta = await engine.read('thread-fixture'); assert.equal(meta.thread.id, 'thread-fixture');
  assert.equal(meta.capability.ownership, 'desktop-owner'); assert.equal(meta.capability.approvalsOnPc, true);
  assert.equal(meta.capability.interruptSupported, false);
  desktop.status = 'active'; assert.equal((await engine.read('thread-fixture')).thread.status, 'active');
  const first = await engine.history('thread-fixture'); assert.equal(first.data[0].items.length, 2);
  assert.equal(first.data[0].items[0].text, '한글 질문'); assert.equal(first.outputLimit, 1500); // Bounded single-turn history keeps large existing chats readable.
  const next = await engine.history('thread-fixture', first.nextCursor); assert.equal(next.nextCursor, null);
  assert.equal(next.data[0].id, 'turn-old');
});
test('exact existing desktop ID send preserves settings and deduplicates UUID without resume/fork/create', async t => {
  const { engine, desktop, dir } = await fixture(t); const msg = input(); desktop.status = 'active';
  desktop.hook = async tool => { if (tool === 'send_message_to_thread') {
    assert.equal(JSON.parse(readFileSync(join(dir, 'requests.json')))[0].state, 'reserved');
  } };
  const sent = await engine.send(session, msg); assert.equal(sent.state, 'delivered'); assert.equal(sent.threadId, msg.threadId);
  assert.deepEqual(await engine.send(session, msg), sent);
  const sends = desktop.calls.filter(c => c.tool === 'send_message_to_thread'); assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].args, { threadId: msg.threadId, hostId: 'local', prompt: msg.text });
  assert.equal(sends[0].callId, msg.requestId);
  await rejects(engine.send(session, { ...msg, text: 'changed' }), 'REQUEST_ID_CONFLICT');
  await rejects(engine.send({ id: 'other' }, msg), 'REQUEST_ID_CONFLICT');
  assert.throws(() => engine.receipt({ id: 'other' }, msg.requestId), e => e.code === 'REQUEST_NOT_FOUND');
  const disk = readFileSync(join(dir, 'requests.json'), 'utf8'); assert.ok(!disk.includes(msg.text));
  assert.ok(desktop.calls.every(c => ['read_thread', 'send_message_to_thread'].includes(c.tool)));
});
test('input rejects old desktopClosed and malformed model choices; invalid UUID/path/oversize never dispatched', async t => {
  const { engine, desktop } = await fixture(t);
  await rejects(engine.send(session, { ...input(), desktopClosed: true }), 'INVALID_FIELDS');
  for (const field of [{ model: '../override' }, { thinking: 'high' }, { model: null }]) await rejects(engine.send(session, { ...input(), ...field }), 'INVALID_MODEL_CHOICE');
  await rejects(engine.send(session, { ...input(), requestId: 'bad' }), 'INVALID_REQUEST_ID');
  await rejects(engine.send(session, { ...input(), threadId: '../secret' }), 'INVALID_THREAD_ID');
  await rejects(engine.send(session, { ...input(), text: 'x'.repeat(16001) }), 'INVALID_INPUT');
  assert.equal(desktop.calls.length, 0);
});
test('wrong or remote thread ID fails closed before dispatch; missing tool is rejected, not fake delivery', async t => {
  for (const [thread, code] of [[{ id: 'wrong' }, 'THREAD_ID_MISMATCH'],
    [{ id: 'thread-fixture', kind: 'codex', hostId: 'remote' }, 'LOCAL_CODEX_THREAD_REQUIRED']]) {
    const { engine, desktop } = await fixture(t);
    desktop.hook = async () => ({ thread, turns: [] });
    await rejects(engine.send(session, input()), code);
    assert.ok(!desktop.calls.some(c => c.tool === 'send_message_to_thread'));
  }
  const { engine, desktop } = await fixture(t); desktop.catalog = [];
  await rejects(engine.send(session, input()), 'DESKTOP_TOOL_UNSUPPORTED');
});
test('send dispatch error is uncertain and survives restart; same UUID returns receipt with no replay', async t => {
  const { engine, desktop, dir } = await fixture(t); const msg = input();
  desktop.hook = async tool => { if (tool === 'send_message_to_thread') throw new BridgeError('DESKTOP_TIMEOUT'); };
  await rejects(engine.send(session, msg), 'SEND_UNCERTAIN');
  assert.equal((await engine.send(session, msg)).state, 'uncertain');
  const restored = new Engine(desktop, dir);
  assert.equal((await restored.send(session, msg)).state, 'uncertain');
  await rejects(restored.send(session, input()), 'PREVIOUS_SEND_UNCERTAIN');
  assert.equal(desktop.calls.filter(c => c.tool === 'send_message_to_thread').length, 1);
});
test('concurrent same UUID sees reservation; second UUID on same thread is rejected and never queued', async t => {
  const { engine, desktop } = await fixture(t); let release;
  desktop.hook = async tool => { if (tool === 'send_message_to_thread') await new Promise(r => { release = r; }); };
  const msg = input(), sending = engine.send(session, msg);
  try {
    await waitFor(() => release); assert.equal((await engine.send(session, msg)).state, 'reserved');
    await rejects(engine.send(session, input()), 'SEND_IN_PROGRESS');
  } finally { release?.(); }
  assert.equal((await sending).state, 'delivered');
});
test('crash reservation becomes uncertain on restart; journal bound does not prune dedup records', async t => {
  const dir = temp(t), msg = input();
  saveJson(join(dir, 'requests.json'), [{ ...msg, state: 'reserved', owner: session.id }]);
  const engine = new Engine(new MockDesktop(), dir);
  assert.equal(engine.receipt(session, msg.requestId).state, 'uncertain');
  engine.records = Array.from({ length: 1000 }, (_, n) => ({ requestId: String(n), state: 'delivered' }));
  await rejects(engine.send(session, input()), 'REQUEST_JOURNAL_FULL');
});
test('only own exact uncertain request can be acknowledged after current history; no send and draft payload not needed', async t => {
  const { engine, desktop } = await fixture(t); const msg = input();
  desktop.hook = async tool => { if (tool === 'send_message_to_thread') throw new BridgeError('DESKTOP_TIMEOUT'); };
  await rejects(engine.send(session, msg), 'SEND_UNCERTAIN');
  const calls = desktop.calls.length;
  const ack = (owner = session, id = msg.threadId, confirmed = true) => engine.acknowledge(owner, msg.requestId, { threadId: id, confirmed });
  assert.throws(() => ack(), e => e.code === 'READ_CURRENT_THREAD_FIRST');
  await engine.history(msg.threadId, undefined, session);
  assert.equal((await engine.read(msg.threadId, session)).uncertainRequest, msg.requestId);
  assert.equal((await engine.read(msg.threadId, { id: 'other' })).uncertainRequest, null);
  assert.throws(() => ack({ id: 'other' }), e => e.code === 'REQUEST_NOT_FOUND');
  assert.throws(() => ack(session, 'another-thread'), e => e.code === 'REQUEST_NOT_FOUND');
  assert.throws(() => ack(session, msg.threadId, false), e => e.code === 'CONFIRMATION_REQUIRED');
  const beforeAck = desktop.calls.length;
  assert.equal(ack().state, 'acknowledged'); assert.equal(ack().state, 'acknowledged');
  assert.equal(desktop.calls.length, beforeAck); assert.equal(beforeAck, calls + 3);
  assert.equal((await engine.send(session, msg)).state, 'acknowledged');
  assert.ok(engine.records[0].acknowledgedAfterReadAt); assert.equal(desktop.calls.length, beforeAck);
  assert.equal((await engine.read(msg.threadId, session)).uncertain, false);
});
test('acknowledgement refuses inflight, stale history and another session history', async t => {
  let now = 1000; const desktop = new MockDesktop(), engine = new Engine(desktop, temp(t), { now: () => now });
  const msg = input(); engine.records.push({ ...msg, owner: session.id, state: 'uncertain', createdAt: now, uncertainAt: now });
  await engine.history(msg.threadId, undefined, { id: 'other' });
  const ack = () => engine.acknowledge(session, msg.requestId, { threadId: msg.threadId, confirmed: true });
  assert.throws(ack, e => e.code === 'READ_CURRENT_THREAD_FIRST');
  await engine.history(msg.threadId, undefined, session); now += 300001;
  assert.throws(ack, e => e.code === 'READ_CURRENT_THREAD_FIRST');
  engine.records[0].state = 'reserved'; assert.throws(ack, e => e.code === 'REQUEST_NOT_UNCERTAIN');
});
test('journal prunes only final receipts older than seven days, preserving all uncertain/inflight and recent dedup', async t => {
  let now = 10 * 86400000;
  const engine = new Engine(new MockDesktop(), temp(t), { now: () => now });
  engine.records = ['delivered', 'rejected', 'acknowledged', 'uncertain', 'reserved', 'active'].map((state, i) => ({ requestId: String(i), state, createdAt: 1 }));
  engine.records.push({ requestId: 'recent', state: 'delivered', createdAt: now - 6 * 86400000 });
  engine.records.push({ requestId: 'fresh-ack', state: 'acknowledged', createdAt: 1, acknowledgedAt: now });
  engine.prune();
  assert.deepEqual(engine.records.map(r => r.requestId), ['3', '4', '5', 'recent', 'fresh-ack']);
  engine.records = Array.from({ length: 1000 }, (_, i) => ({ requestId: String(i), state: 'delivered', createdAt: 1 }));
  assert.equal((await engine.send(session, input())).state, 'delivered'); assert.equal(engine.records.length, 1);
  engine.records = Array.from({ length: 1000 }, (_, i) => ({ requestId: String(i), threadId: 'other', state: 'uncertain', createdAt: 1 }));
  await rejects(engine.send(session, input()), 'REQUEST_JOURNAL_FULL'); assert.equal(engine.records.length, 1000);
});
test('reasoning fields never inspected; HTML plain text and output bounded', () => {
  assert.equal(item({ type: 'reasoning', get content() { throw new Error(); } }), null);
  assert.equal(item({ type: 'agentMessage', text: '<script>bad</script>' }).text, '<script>bad</script>');
  assert.equal(item({ type: 'commandExecution', aggregatedOutput: 'x'.repeat(100000) }).detail.length, 64000);
});
