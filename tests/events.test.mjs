import test from 'node:test';
import assert from 'node:assert/strict';
import { Events, storageScope } from '../server/events.mjs';
import { fixture, httpCall } from './helpers.mjs';
import { createBridge } from '../server/http.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source() {
  let now = 1, reads = 0, questionReads = 0, questions = { state: 'ready', data: [] };
  const row = { id: 'original', title: '대화 제목', status: 'idle', stale: false, previewState: 'ready', latestTurn: { id: 'first', status: 'completed' }, preview: null };
  const result = { available: true, data: [row] };
  const engine = { now: () => now, activity: { async snapshot() { reads++; return result; } }, questions: { async get() { questionReads++; return questions; } }, async stored() { return null; } };
  const events = new Events(engine), session = { id: 'owner' };
  return { events, session, row, result, engine, advance: () => { now += 15001; }, questions: value => { questions = value; }, reads: () => reads, questionReads: () => questionReads };
}
test('event baseline suppresses old idle/waiting/questions; completion requires actually observed active same turn then completed+idle, including tool-only turns', async () => {
  const f = source(); let feed = await f.events.feed(f.session);
  assert.equal(feed.reset, true); assert.deepEqual(feed.events, []);
  f.row.latestTurn = { id: 'second', status: 'completed' }; f.advance(); feed = await f.events.feed(f.session, feed.cursor); assert.deepEqual(feed.events, []);
  f.row.status = 'active'; f.row.latestTurn = { id: 'working', status: 'inProgress' }; f.advance(); feed = await f.events.feed(f.session, feed.cursor);
  f.row.status = 'idle'; f.row.latestTurn = { id: 'different', status: 'completed' }; f.advance(); feed = await f.events.feed(f.session, feed.cursor); assert.deepEqual(feed.events, []);
  f.row.status = 'active'; f.row.latestTurn = { id: 'tool-only', status: 'inProgress' }; f.advance(); feed = await f.events.feed(f.session, feed.cursor);
  f.row.status = 'idle'; f.row.latestTurn.status = 'completed'; f.advance(); const cursor = feed.cursor; feed = await f.events.feed(f.session, cursor);
  assert.deepEqual(feed.events.map(e => [e.type, e.threadId]), [['completed', 'original']]);
  assert.equal(feed.storageScope, storageScope(f.session)); assert.ok(!JSON.stringify(feed).includes('owner'));
  assert.equal((await f.events.feed(f.session, feed.cursor)).events.length, 0);
  assert.deepEqual(await f.events.feed(f.session, cursor), feed); // Stable IDs/fingerprints on replay.
  assert.notEqual(storageScope({ id: 'other' }), feed.storageScope);
});
test('failed/stale/unavailable observations and long gaps cannot fabricate completion or punctuation-based questions', async () => {
  const f = source(); f.row.status = 'active'; f.row.latestTurn = { id: 't', status: 'inProgress' }; let feed = await f.events.feed(f.session);
  f.row.status = 'idle'; f.row.latestTurn.status = 'completed'; f.row.previewState = 'stale'; f.row.preview = { text: '질문인가요? private/path', version: 'not-an-event' }; f.advance();
  feed = await f.events.feed(f.session, feed.cursor); assert.equal(feed.events.length, 0);
  for (let n = 0; n < 10; n++) f.advance(); f.row.previewState = 'ready'; feed = await f.events.feed(f.session, feed.cursor); assert.equal(feed.events.length, 0);
  f.result.available = false; f.advance(); feed = await f.events.feed(f.session, feed.cursor); assert.equal(feed.available, false); assert.equal(feed.events.length, 0);
});
test('questions notify only new genuine current-turn async records after first complete ready baseline; waiting is actual native status, not question wording', async () => {
  const f = source(); f.row.status = 'active'; f.row.latestTurn = { id: 'work', status: 'inProgress' };
  const q = (id, state = 'unconfirmed', turnId = 'work') => ({ id, state, turnId, title: 'not copied to lock screen' });
  f.questions({ state: 'loading', data: [q('partial')] }); let feed = await f.events.feed(f.session);
  f.questions({ state: 'ready', data: [q('old'), q('answered', 'answered')] }); f.advance(); feed = await f.events.feed(f.session, feed.cursor); assert.equal(feed.events.length, 0);
  f.questions({ state: 'ready', data: [q('old'), q('new'), q('historic', 'historical'), q('foreign', 'unconfirmed', 'old-turn'), q('blocking', 'pc-only')] });
  f.row.status = 'waiting'; f.advance(); feed = await f.events.feed(f.session, feed.cursor);
  assert.deepEqual(feed.events.map(e => e.type), ['waiting', 'question']); assert.ok(!JSON.stringify(feed).includes('not copied'));
  f.advance(); assert.equal((await f.events.feed(f.session, feed.cursor)).events.length, 0);
});
test('recent-only/loading/failed question snapshots cannot produce a historical flood or reuse a stale complete baseline', async () => {
  const f = source(); f.row.status = 'active'; f.row.latestTurn = { id: 'work', status: 'inProgress' };
  const q = id => ({ id, state: 'unconfirmed', turnId: 'work' });
  let feed = await f.events.feed(f.session);
  for (const snapshot of [{ state: 'ready', coverage: 'recent', data: [q('old'), q('tail')] }, { state: 'loading', coverage: 'recent', data: [] }, { state: 'unavailable', data: [] }, { state: 'ready', data: [q('old'), q('tail')] }]) {
    f.questions(snapshot); f.advance(); feed = await f.events.feed(f.session, feed.cursor); assert.deepEqual(feed.events, []);
  }
  f.questions({ state: 'ready', data: [q('old'), q('tail'), q('genuine-new')] }); f.advance(); feed = await f.events.feed(f.session, feed.cursor);
  assert.deepEqual(feed.events.map(e => e.type), ['question']);
});
test('event collector is shared single-flight/15s cached, bounded two question sources and ledger; malformed/expired/server-restart cursors rebaseline without flood', async () => {
  const f = source(); f.row.status = 'active'; f.row.latestTurn.status = 'inProgress';
  f.result.data = Array.from({ length: 50 }, (_, n) => ({ ...f.row, id: `thread-${n}` }));
  const feeds = await Promise.all(Array.from({ length: 20 }, () => f.events.feed(f.session)));
  assert.equal(f.reads(), 1); assert.equal(f.questionReads(), 2); assert.ok(feeds.every(r => r.reset && !r.events.length));
  for (let n = 0; n < 200; n++) f.events.push(f.row, 'question', String(n), '새 질문 기록');
  assert.equal(f.events.ledger.length, 128);
  for (const cursor of [null, 'bad', `${f.events.epoch}.0`, `${f.events.epoch}.999999999999`, 'f'.repeat(24) + '.1']) {
    const result = await f.events.feed(f.session, cursor); assert.equal(result.reset, true); assert.deepEqual(result.events, []);
  }
  const restarted = new Events(f.engine); assert.equal((await restarted.feed(f.session, feeds[0].cursor)).reset, true);
});
test('events/session are authenticated readonly exact-query DTO routes, no arbitrary source/thread lookup or mutation', async t => {
  const f = await fixture(t), server = createBridge(f); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, options) => httpCall(server.address().port, path, options);
  assert.equal((await call('/api/events')).status, 401);
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1'), headers = { Cookie: `codex_phone=${paired.token}` };
  const session = await call('/api/session', { headers }); assert.match(session.json.storageScope, /^[a-f0-9]{64}$/); assert.notEqual(session.json.storageScope, session.json.csrf);
  assert.equal((await call('/api/events', { headers })).json.reset, true);
  for (const suffix of ['?path=secret', '?threadId=other', '?cursor=x&cursor=y']) assert.equal((await call('/api/events' + suffix, { headers })).status, 400);
  assert.equal((await call('/api/events', { method: 'POST', headers })).status, 403);
  assert.ok(f.desktop.calls.every(c => ['list_threads', 'read_thread'].includes(c.tool))); assert.equal(f.engine.records.length, 0);
});
