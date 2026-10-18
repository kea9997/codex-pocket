import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { Questions, QUESTION_LINE_LIMIT, QUESTION_FILE_LIMIT, QUESTION_RECENT_LIMIT } from '../server/questions.mjs';
import { questionFixture, thread, turnId, record, question, replyText, lines, ordinalLines } from './questions-fixture.mjs';
import { fixture, httpCall } from './helpers.mjs';
import { createBridge } from '../server/http.mjs';
import { join } from 'node:path';

const current = { id: turnId, status: 'inProgress' }, MiB = 1024 * 1024;
// A sparse 40MiB owned temporary file. Its unread middle is deliberately not JSONL.
// Only the head and seven MiB of tail have generated records; production may never scan the hole.
function largeSource(t, { head, tail } = {}) {
  const f = questionFixture(t), size = QUESTION_FILE_LIMIT + 8 * MiB;
  const noise = Buffer.from('{"timestamp":"fixture","ordinal":5,"type":"response_item","payload":{"type":"reasoning","content":not-json,' + 'x'.repeat(59900) + '}\n');
  const bytes = tail ?? Buffer.concat([Buffer.concat(Array(123).fill(noise)), Buffer.from(ordinalLines([
    record('turn_context', { turn_id: turnId }), question('recent'),
    record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: replyText('최근 답변', '어떻게 진행할까요?', 'recent') }] })
  ]))]);
  fs.writeFileSync(f.file, head ?? ordinalLines(f.initial)); fs.truncateSync(f.file, size);
  const fd = fs.openSync(f.file, 'r+'); fs.writeSync(fd, bytes, 0, bytes.length, size - bytes.length); fs.closeSync(fd);
  let total = 0, opened = 0, now = 1; const positions = [];
  const io = { ...fs, readFileSync() { throw new Error('Whole source read forbidden'); },
    openSync(...args) { opened++; return fs.openSync(...args); }, closeSync(fd) { opened--; fs.closeSync(fd); },
    readSync(fd, buffer, offset, length, position) {
      assert.ok(length <= 65536); assert.ok(position < QUESTION_LINE_LIMIT + 65536 || position >= size - QUESTION_RECENT_LIMIT - 64, 'No middle scan');
      positions.push(position); const n = fs.readSync(fd, buffer, offset, length, position); total += n; return n;
    } };
  const source = new Questions({ root: f.root, io, now: () => now });
  return { ...f, source, positions, size, noise, total: () => total, opened: () => opened, advance: () => { now += 2001; } };
}
async function ready(f) {
  for (let n = 0; n < 4; n++) {
    const total = f.total(), result = await f.source.get(thread, f.metadata, current);
    assert.ok(f.total() - total <= 4 * MiB + 64); assert.equal(f.opened(), 0);
    if (result.state !== 'loading') return result;
    assert.equal(result.coverage, 'recent'); assert.equal(result.reason, 'scan-in-progress'); assert.deepEqual(result.data, []); f.advance();
  }
  assert.fail('Bounded recent scan did not finish');
}
test('oversized source verifies its first session_meta then scans only bounded tail, omits historical questions and opaque reasoning without parsing it', async t => {
  const f = largeSource(t), result = await ready(f);
  assert.equal(result.state, 'ready'); assert.equal(result.coverage, 'recent'); assert.equal(result.reason, 'recent-window');
  assert.equal(result.data.length, 1); assert.equal(result.data[0].state, 'answered'); assert.equal(result.data[0].answer, '최근 답변');
  assert.ok(!JSON.stringify(result).includes('call_first')); assert.ok(f.total() <= QUESTION_RECENT_LIMIT + QUESTION_LINE_LIMIT);
  assert.ok(f.positions.some(n => n === 0)); assert.ok(f.positions.some(n => n > QUESTION_FILE_LIMIT));
  for (const value of [f.file, f.root, 'not-json', 'session_meta', 'reasoning', 'source_thread_id']) assert.ok(!JSON.stringify(result).includes(value));
  const total = f.total(); assert.deepEqual(await f.source.get(thread, f.metadata, current), result); assert.equal(f.total(), total);
});
test('recent cache incrementally reads appended question/reply and split UTF8, validates boundary, then recovers from truncation without stale cards', async t => {
  const f = largeSource(t); await ready(f); let total = f.total();
  const append = Buffer.from(lines([question('appended')])); fs.appendFileSync(f.file, append); f.advance();
  let result = await f.source.get(thread, f.metadata, current); assert.equal(result.state, 'ready'); assert.equal(result.data.at(-1).state, 'unconfirmed');
  assert.ok(f.total() - total <= append.length + 64); total = f.total();
  const reply = Buffer.from(lines([record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: replyText('한글 분할 답변', '어떻게 진행할까요?', 'appended') }] })]));
  const split = reply.indexOf(Buffer.from('한글')) + 1;
  fs.appendFileSync(f.file, reply.subarray(0, split)); f.advance(); result = await f.source.get(thread, f.metadata, current);
  assert.equal(result.state, 'loading'); assert.deepEqual(result.data, []);
  fs.appendFileSync(f.file, reply.subarray(split)); f.advance(); result = await f.source.get(thread, f.metadata, current);
  assert.equal(result.data.at(-1).state, 'answered'); assert.equal(result.data.at(-1).answer, '한글 분할 답변'); assert.ok(f.total() - total <= reply.length + 128);
  fs.writeFileSync(f.file, lines(f.initial)); f.advance(); result = await f.source.get(thread, f.metadata, current);
  assert.equal(result.state, 'ready'); assert.equal(result.coverage, undefined); assert.equal(result.data.length, 1); assert.ok(result.data[0].id.includes('call_first')); assert.equal(f.opened(), 0);
});
test('recent scan rejects wrong/missing first session metadata despite matching metadata in the tail; oversized lines have a sanitized recovery reason', async t => {
  for (const head of [lines([record('session_meta', { id: turnId })]), lines([record('turn_context', { turn_id: turnId })])]) {
    const f = largeSource(t, { head });
    assert.equal((await ready(f)).state, 'unavailable'); assert.ok(f.total() <= 65536);
  }
  const f = largeSource(t, { tail: Buffer.from('x'.repeat(7 * MiB)) }), result = await ready(f);
  assert.deepEqual(result, { state: 'unavailable', data: [], reason: 'line-too-large' }); assert.ok(f.total() < MiB); assert.equal(f.opened(), 0);
});
test('reply-only recent windows are explicitly empty/partial, and missing turn_context is never guessed from the current native turn', async t => {
  const noise = Buffer.from(lines([record('response_item', { type: 'reasoning', content: 'x'.repeat(60000) })]));
  for (const row of [record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: replyText() }] }), question('unknown-turn')]) {
    const f = largeSource(t, { tail: Buffer.concat([Buffer.concat(Array(123).fill(noise)), Buffer.from(lines([row]))]) }), result = await ready(f);
    assert.equal(result.state, 'ready'); assert.equal(result.coverage, 'recent');
    if (row.payload.type === 'message') assert.deepEqual(result.data, []);
    else { assert.equal(result.data.length, 1); assert.equal(result.data[0].turnId, null); assert.equal(result.data[0].state, 'unconfirmed'); }
  }
});
test('authenticated recent Questions HTTP still requires own current history, exposes bounded scope without raw source and never sends', async t => {
  const f = await fixture(t), logs = largeSource(t); f.engine.questions = logs.source;
  f.desktop.hook = async (_tool, args) => ({ thread: f.desktop.thread(args.threadId), turns: [{ id: turnId, status: 'inProgress', items: [] }] });
  f.engine.historyRpcFactory = async () => ({ closed: false, close() {}, async request(method, params) { assert.equal(method, 'thread/read'); assert.deepEqual(params, { threadId: thread, includeTurns: false }); return logs.metadata(); } });
  const server = createBridge(f); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (route, options) => httpCall(server.address().port, route, options), route = `/api/threads/${thread}/questions`;
  assert.equal((await call(route)).status, 401);
  const paired = f.auth.pair(JSON.parse(fs.readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1'), headers = { Cookie: `codex_phone=${paired.token}` };
  assert.equal((await call(route, { headers })).json.state, 'unavailable'); assert.equal(logs.total(), 0);
  await call(`/api/threads/${thread}/history`, { headers }); let result;
  for (let n = 0; n < 3; n++) { result = await call(route, { headers }); if (result.json.state !== 'loading') break; logs.advance(); }
  assert.equal(result.status, 200); assert.equal(result.json.state, 'ready'); assert.equal(result.json.coverage, 'recent'); assert.equal(result.json.data[0].state, 'answered');
  for (const hidden of [logs.file, 'reasoning', 'not-json', 'session_meta', 'call_first']) assert.ok(!result.text.includes(hidden));
  assert.equal((await call(route + '?path=other', { headers })).status, 400); assert.equal(f.engine.records.length, 0); assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread'));
});
test('recent scan rebases after its bounded append slack and handles checkpoint rewrites and file rotation without retaining old parser state', async t => {
  const f = largeSource(t); await ready(f);
  fs.appendFileSync(f.file, Buffer.concat(Array(37).fill(f.noise))); f.advance();
  const result = await ready(f); assert.equal(result.state, 'ready'); assert.equal(result.coverage, 'recent');
  assert.ok(f.source.cache.get(thread).stat.size - f.source.cache.get(thread).windowStart <= QUESTION_RECENT_LIMIT);
  // A different final boundary must cause a fresh owned head + tail verification, not expose stale data.
  f.source.cache.get(thread).parser.record(question('cache-only-sentinel'));
  const fd = fs.openSync(f.file, 'r+'), size = fs.statSync(f.file).size;
  fs.writeSync(fd, Buffer.from('BROKEN\n'), 0, 7, size - 7); fs.closeSync(fd); f.advance();
  const rewritten = await ready(f); assert.equal(rewritten.state, 'ready'); assert.ok(!JSON.stringify(rewritten).includes('cache-only-sentinel'));
  fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, lines(f.initial)); f.advance();
  const rotated = await f.source.get(thread, f.metadata, current); assert.equal(rotated.state, 'ready'); assert.equal(rotated.coverage, undefined); assert.equal(f.opened(), 0);
});
