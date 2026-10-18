import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.mjs';
import { BridgeError } from '../server/rpc.mjs';
import { fixture, temp, MockDesktop } from './helpers.mjs';
import { imageFixture } from './media-fixture.mjs';

const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);
test('adaptive readonly history reduces multiple turns then omits outputs, keeping exact ID/cursor; successful downgrade remembered', async t => {
  const { engine, desktop } = await fixture(t);
  desktop.hook = async (tool, args) => { if (tool === 'read_thread' && (args.turnLimit > 1 || args.includeOutputs)) throw new BridgeError('HISTORY_SIZE_LIMIT', 502); };
  const page = await engine.desktopRead('thread-fixture', 'actual + cursor/한글', 5);
  assert.deepEqual(desktop.calls.map(c => [c.args.turnLimit, c.args.includeOutputs]), [[5, true], [1, true], [1, false]]);
  assert.ok(desktop.calls.every(c => c.tool === 'read_thread' && c.args.threadId === 'thread-fixture' && c.args.cursor === 'actual + cursor/한글' && c.args.maxOutputCharsPerItem === 1500));
  assert.equal(page.readOptions.outputsOmitted, true); assert.equal(page.readOptions.outputLimit, 0);
  desktop.calls.length = 0; await engine.desktopRead('thread-fixture', 'next-real-cursor', 5);
  assert.equal(desktop.calls.length, 1); assert.equal(desktop.calls[0].args.includeOutputs, false); assert.equal(desktop.calls[0].args.cursor, 'next-real-cursor');
  assert.equal(engine.records.length, 0);
});
test('default one-turn history retains real previous-page cursor and output fallback never alters metadata/send routes', async t => {
  const { engine, desktop } = await fixture(t);
  desktop.hook = async (tool, args) => { if (tool === 'read_thread' && args.includeOutputs) throw new BridgeError('HISTORY_SIZE_LIMIT', 502); };
  const first = await engine.history('thread-fixture', null, { id: 'own' });
  assert.equal(first.nextCursor, 'history-2'); assert.equal(first.order, 'newest_first'); assert.equal(first.outputsOmitted, true);
  const older = await engine.history('thread-fixture', first.nextCursor, { id: 'own' }); assert.equal(older.data[0].id, 'turn-old'); assert.equal(older.nextCursor, null);
  await engine.read('thread-fixture'); assert.ok(desktop.calls.every(c => c.tool === 'read_thread' && c.args.turnLimit === 1));
  assert.ok(desktop.calls.slice(1).every(c => !c.args.includeOutputs));
});
test('minimal oversized turn has explicit bounded failure; ordinary errors/timeouts/disconnect do not cause adaptive retries', async t => {
  for (const code of ['HISTORY_SIZE_LIMIT', 'DESKTOP_TOOL_FAILED', 'DESKTOP_TIMEOUT', 'DESKTOP_DISCONNECTED']) {
    const { engine, desktop } = await fixture(t); desktop.hook = async () => { throw new BridgeError(code, 502); };
    await rejects(engine.history('thread-fixture'), code);
    assert.equal(desktop.calls.length, code === 'HISTORY_SIZE_LIMIT' ? 2 : 1);
    await rejects(engine.history('thread-fixture'), code);
    assert.equal(desktop.calls.length, code === 'HISTORY_SIZE_LIMIT' ? 3 : 2);
    assert.equal(engine.records.length, 0); assert.equal(engine.readChecks.size, 0);
  }
});
test('adaptive mode expires and has a strict thread bound', async t => {
  let now = 1; const desktop = new MockDesktop(), engine = new Engine(desktop, temp(t), { now: () => now });
  desktop.hook = async (_tool, args) => { if (args.includeOutputs) throw new BridgeError('HISTORY_SIZE_LIMIT'); };
  for (let n = 0; n < 70; n++) await engine.history('fixture-' + n);
  assert.equal(engine.readModes.size, 64);
  desktop.calls.length = 0; now += 30 * 60000 + 1; await engine.history('fixture-69');
  assert.deepEqual(desktop.calls.map(c => c.args.includeOutputs), [true, false]);
});
test('only fetched authorized history registers bounded images, not metadata/activity/reasoning; bad image does not hide other messages', async t => {
  const { engine, desktop } = await fixture(t), { file } = imageFixture(t);
  desktop.hook = async (tool, args) => tool === 'read_thread' ? { thread: desktop.thread(args.threadId), turns: [{ id: 'turn', status: 'completed', items: [
    { type: 'reasoning', get content() { throw new Error(); }, get path() { throw new Error(); } },
    { type: 'agentMessage', text: '답변 ![로컬](<' + file.replaceAll('\\', '/') + '>)' },
    { type: 'imageView', path: file }, { type: 'imageView', path: file + '.webm' },
    ...Array.from({ length: 70 }, () => ({ type: 'imageView', path: file }))
  ] }] } : undefined;
  await engine.read('thread-fixture', { id: 'own' }); assert.equal(engine.media.entries.size, 0);
  const page = await engine.history('thread-fixture', null, { id: 'own' });
  assert.equal(page.data[0].items[0].images[0].media.state, 'ready'); assert.equal(page.data[0].items[1].media.state, 'ready');
  assert.equal(page.data[0].items[2].media.error, 'MEDIA_TYPE_UNSUPPORTED'); assert.equal(page.data[0].items.at(-1).media.error, 'MEDIA_LIMIT');
  assert.equal(engine.media.entries.size, 1); assert.ok(!JSON.stringify(page.data[0].items[1]).includes(file));
});
