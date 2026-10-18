import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { Questions, questionParser, questionReplies, QUESTION_FILE_LIMIT, QUESTION_LINE_LIMIT } from '../server/questions.mjs';
import { questionFixture, thread, turnId, key, record, question, reply, replyText, lines, ordinalLines } from './questions-fixture.mjs';
import { fixture } from './helpers.mjs';
import { item } from '../server/engine.mjs';

const current = { id: turnId, status: 'inProgress' };
test('authentic async call/reply records resolve already-answered questions; prose, wrong role/id/title and reasoning cannot act as replies', () => {
  const p = questionParser(thread); p.record(record('session_meta', { id: thread })); p.record(record('turn_context', { turn_id: turnId })); p.record(question());
  p.record(record('response_item', { type: 'reasoning', get content() { throw new Error('reasoning inspected'); }, get arguments() { throw new Error('reasoning inspected'); } }));
  p.record(record('response_item', { type: 'function_call_output', get output() { throw new Error('opaque output inspected'); } }));
  p.record(record('response_item', { type: 'message', role: 'assistant', get content() { throw new Error('assistant inspected'); } }));
  assert.equal(p.result(current).data[0].state, 'unconfirmed'); assert.deepEqual(questionReplies('설명\n' + replyText()), []);
  p.record(record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: replyText('무관', '다른 제목') }] }));
  assert.equal(p.result(current).data[0].state, 'unconfirmed');
  p.record(reply()); p.record(question()); assert.equal(p.result(current).data[0].state, 'answered'); assert.equal(p.result(current).data[0].answer, '기본 유지');
  p.record(question('call_second')); assert.equal(p.result({ id: 'other', status: 'completed' }).data[1].state, 'historical');
  p.record(record('event_msg', { type: 'turn_aborted', turn_id: turnId })); assert.equal(p.result(current).data[1].state, 'historical');
  assert.throws(() => p.record(record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<send_user_message_question_reply>\nmalformed\n</send_user_message_question_reply>' }] })));
});
test('blocking questions stay PC-only by tool identity; incidental permission/token words do not hide asynchronous preferences', () => {
  const p = questionParser(thread); p.record(record('session_meta', { id: thread }));
  p.record(record('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'call_blocking', get arguments() { throw new Error('blocking args inspected'); } }));
  p.record(record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'call_other', get arguments() { throw new Error('other tool args inspected'); } }));
  assert.deepEqual(p.result(current).data.map(q => [q.state, q.title, q.options]), [['pc-only', 'PC에서 질문 확인', []]]);
  p.record(question('call_preference', '권한 설정 화면과 token 표시 디자인은 어떻게 할까요?'));
  const preference = p.result(current).data[1]; assert.equal(preference.state, 'unconfirmed'); assert.equal(preference.options.length, 2); assert.match(preference.title, /권한/);
  p.record(record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: replyText('기본 유지', preference.title, 'call_preference') }] }));
  assert.equal(p.result(current).data[1].state, 'answered'); assert.equal(p.result(current).data[0].state, 'pc-only');
  const invalid = question(); invalid.payload.arguments = '{'; assert.throws(() => p.record(invalid));
  const tooMany = question(); tooMany.payload.arguments = JSON.stringify({ questions: Array(9).fill({ title: 'x', options: [] }) }); assert.throws(() => p.record(tooMany));
  p.record(question('call_plain', '<script> literal ‮text')); const q = p.result(current).data.at(-1); assert.ok(q.title.includes('<script>')); assert.ok(!q.title.includes('‮'));
});
test('reply envelopes allow only surrounding whitespace, retaining exact row/id/title validation and ordinary user role', () => {
  const p = questionParser(thread); p.record(record('session_meta', { id: thread })); p.record(question());
  const wrapped = '\t \r\n' + replyText() + '\n \t';
  assert.equal(questionReplies(wrapped).length, 1);
  const visible = item({ type: 'userMessage', content: [{ type: 'text', text: wrapped }] });
  assert.equal(visible.text, '질문 답변\n어떻게 진행할까요?\n기본 유지'); assert.ok(!visible.text.includes('send_user_message_question_reply'));
  assert.deepEqual(questionReplies(wrapped + '설명'), []);
  for (const value of ['관련 설명\n' + wrapped, replyText().replace('call_first', 'call_wrong'), replyText().replace('어떻게 진행할까요?', '다른 질문')]) {
    p.record(record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] }));
    assert.equal(p.result(current).data[0].state, 'unconfirmed');
  }
  p.record(record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: wrapped }] })); assert.equal(p.result(current).data[0].state, 'unconfirmed');
  const rows = JSON.parse(replyText().split('\n')[1]);
  for (const invalid of [{ ...rows[0], extra: 'not accepted' }, { ...rows[0], questionItemId: '["request_user_input_async", "call_first", 0]' }, { ...rows[0], answer: '' }]) {
    const value = ' \n<send_user_message_question_reply>\n' + JSON.stringify([rows[0], invalid]) + '\n</send_user_message_question_reply>\n';
    assert.deepEqual(questionReplies(value), []); assert.throws(() => p.record(record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] })));
  }
  p.record(record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: wrapped }] }));
  assert.equal(p.result(current).data[0].state, 'answered'); assert.equal(p.result(current).data[0].answer, '기본 유지');
});
test('ordinal JSONL resolves two answered questions including title-only free text without duplicate or fresh pending cards', async t => {
  const f = questionFixture(t), title = '다른 편집 방향을 입력해 주세요';
  const free = record('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'call_text', arguments: JSON.stringify({ questions: [{ title }] }) });
  const user = text => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  const rows = [...f.initial, free, user(replyText() + '\n'), user(replyText('자연스럽게 연결', title, 'call_text') + '\n'), question(), free, record('event_msg', { type: 'task_complete', turn_id: turnId })];
  fs.writeFileSync(f.file, ordinalLines(rows));
  const result = await new Questions({ root: f.root }).get(thread, f.metadata, { id: turnId, status: 'completed' });
  assert.equal(result.state, 'ready'); assert.equal(result.data.length, 2); assert.deepEqual(result.data.map(q => q.state), ['answered', 'answered']);
  assert.deepEqual(result.data.map(q => q.answer), ['기본 유지', '자연스럽게 연결']); assert.deepEqual(result.data[1].options, []);
  for (const options of [null, 'text', {}, [1], Array(9).fill('x')]) {
    const p = questionParser(thread), bad = structuredClone(free); bad.payload.arguments = JSON.stringify({ questions: [{ title, options }] }); assert.throws(() => p.record(bad));
  }
});
test('ordinal prefix is structural and reasoning is excluded before body parsing; malformed ordinals never expose partial questions', async t => {
  const f = questionFixture(t), base = ordinalLines(f.initial);
  const prefix = '{"timestamp":"2026-10-16T06:37:46.035Z","ordinal":9,"type":"response_item","payload":';
  // Invalid opaque bodies make any attempt to JSON-parse reasoning/world_state fail this test.
  fs.writeFileSync(f.file, base + prefix + '{"type":"reasoning","content":not-json}\n' + prefix.replace('response_item', 'world_state') + '{"private":not-json}\n');
  assert.equal((await new Questions({ root: f.root }).get(thread, f.metadata, current)).state, 'ready');
  for (const ordinal of ['"0"', '0.5', '-1', '00']) {
    fs.writeFileSync(f.file, base.replace('"ordinal":0', '"ordinal":' + ordinal));
    assert.equal((await new Questions({ root: f.root }).get(thread, f.metadata, current)).state, 'unavailable');
  }
});
test('trusted metadata ID, canonical sessions path/UUID basename, links and swapped files are checked before any log body read', async t => {
  const f = questionFixture(t); let reads = 0;
  const io = { ...fs, readSync(...args) { reads++; return fs.readSync(...args); } }, source = new Questions({ root: f.root, io });
  for (const path of [join(f.root, '..', 'escape.jsonl'), f.file.replace(thread, '33333333-3333-4333-8333-333333333333'), '//host/share/file.jsonl', f.file + ':stream']) {
    const result = await new Questions({ root: f.root, io }).get(thread, async () => ({ thread: { id: thread, path } }), current); assert.equal(result.state, 'unavailable');
  }
  assert.equal((await source.get(thread, async () => ({ thread: { id: 'wrong', path: f.file } }), current)).state, 'unavailable'); assert.equal(reads, 0);
  const hardlink = join(f.dir, 'other.jsonl'); fs.linkSync(f.file, hardlink);
  assert.equal((await new Questions({ root: f.root, io }).get(thread, f.metadata, current)).state, 'unavailable'); assert.equal(reads, 0); fs.unlinkSync(hardlink);
  const linkedRoot = join(f.root, '..', 'linked-sessions'); fs.symlinkSync(f.root, linkedRoot, 'junction');
  const linkedFile = join(linkedRoot, '2026', '10', '16', f.file.split(/[\\/]/).at(-1));
  assert.equal((await new Questions({ root: linkedRoot, io }).get(thread, async () => ({ thread: { id: thread, path: linkedFile } }), current)).state, 'unavailable'); assert.equal(reads, 0);
  const swapped = new Questions({ root: f.root, io: { ...io, openSync(file, flags) { const fd = fs.openSync(file, flags); fs.renameSync(file, file + '.old'); fs.writeFileSync(file, lines(f.initial)); return fd; } } });
  assert.equal((await swapped.get(thread, f.metadata, current)).state, 'unavailable');
});
test('cached incremental scan resolves appended answers without rereading whole log; partial lines/loading and fd cleanup remain bounded', async t => {
  const f = questionFixture(t); let now = 1, total = 0, max = 0, metadataCalls = 0, opened = 0;
  // Real-sized source spans several scan budgets; ordinal reasoning bodies are skipped before JSON parsing.
  const noise = ordinalLines([record('response_item', { type: 'reasoning', content: 'x'.repeat(60000) })]);
  fs.writeFileSync(f.file, ordinalLines(f.initial) + noise.repeat(280) + ordinalLines([reply()]));
  const io = { ...fs, readFileSync() { throw new Error('whole log read forbidden'); }, openSync(...a) { opened++; return fs.openSync(...a); }, closeSync(fd) { opened--; return fs.closeSync(fd); }, readSync(fd, b, o, n, pos) { max = Math.max(max, n); const count = fs.readSync(fd, b, o, n, pos); total += count; return count; } };
  const q = new Questions({ root: f.root, io, now: () => now }), metadata = async () => { metadataCalls++; return f.metadata(); };
  let ready;
  for (let n = 0; n < 6; n++) {
    const before = total; ready = await q.get(thread, metadata, current); assert.equal(opened, 0); assert.ok(total - before <= 4 * 1024 * 1024 + 64);
    if (ready.state === 'ready') break;
    assert.equal(ready.state, 'loading'); assert.deepEqual(ready.data, []); now += 2001;
  }
  assert.equal(ready.state, 'ready'); assert.equal(ready.data[0].state, 'answered'); assert.ok(max <= 65536);
  const initialBytes = total; await q.get(thread, metadata, current); assert.equal(total, initialBytes); assert.equal(metadataCalls, 1);
  const append = lines([question('call_later')]); fs.appendFileSync(f.file, append); now += 2001;
  const next = await q.get(thread, metadata, current); assert.equal(next.data.at(-1).state, 'unconfirmed'); assert.ok(total - initialBytes <= Buffer.byteLength(append) + 64);
  const nativeReply = Buffer.from(ordinalLines([record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: replyText('다음 선택', '어떻게 진행할까요?', 'call_later') + '\n' }] })]));
  const split = nativeReply.indexOf(Buffer.from('다음 선택')) + 1;
  fs.appendFileSync(f.file, nativeReply.subarray(0, split)); now += 2001; assert.equal((await q.get(thread, metadata, current)).state, 'loading'); assert.equal(opened, 0);
  fs.appendFileSync(f.file, nativeReply.subarray(split)); now += 2001;
  const answered = await q.get(thread, metadata, current); assert.equal(answered.state, 'ready'); assert.deepEqual(answered.data.map(q => q.state), ['answered', 'answered']); assert.equal(answered.data[1].answer, '다음 선택');
});
test('concurrent append fails closed for that snapshot and recovers without stale pending cards or leaked descriptors', async t => {
  const f = questionFixture(t); let now = 1, append = true, opened = 0;
  const io = { ...fs, openSync(...args) { opened++; return fs.openSync(...args); }, closeSync(fd) { opened--; return fs.closeSync(fd); }, readSync(...args) {
    const n = fs.readSync(...args); if (append) { append = false; fs.appendFileSync(f.file, ordinalLines([reply()])); } return n;
  } };
  const source = new Questions({ root: f.root, io, now: () => now });
  assert.deepEqual(await source.get(thread, f.metadata, current), { state: 'unavailable', data: [] }); assert.equal(opened, 0);
  now += 2001; const result = await source.get(thread, f.metadata, current); assert.equal(result.state, 'ready'); assert.equal(result.data[0].state, 'answered'); assert.equal(opened, 0);
});
test('file/line/schema limits are unavailable, never a partial pending question list; caches/concurrency bounded and metadata is rechecked', async t => {
  const f = questionFixture(t); let now = 1;
  const source = new Questions({ root: f.root, now: () => now });
  fs.writeFileSync(f.file, lines(f.initial) + 'x'.repeat(QUESTION_LINE_LIMIT + 1)); assert.equal((await source.get(thread, f.metadata, current)).state, 'unavailable');
  fs.truncateSync(f.file, QUESTION_FILE_LIMIT + 1); now += 2001; assert.equal((await source.get(thread, f.metadata, current)).state, 'unavailable');
  fs.writeFileSync(f.file, lines([record('session_meta', { id: 'wrong' }), question()])); now += 2001; assert.equal((await source.get(thread, f.metadata, current)).state, 'unavailable');
  fs.writeFileSync(f.file, lines(f.initial)); now += 2001; assert.equal((await source.get(thread, f.metadata, current)).state, 'ready');
  now += 30001; assert.equal((await source.get(thread, async () => ({ thread: { id: 'wrong', path: f.file } }), current)).state, 'unavailable');
  for (let n = 0; n < 20; n++) { now += 2001; await source.get(`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, async () => null, current); } assert.equal(source.cache.size, 8);
});
test('question lookup is single-flight per thread and permits at most two concurrent metadata/scan requests', async () => {
  const source = new Questions(); let count = 0; const release = [];
  const metadata = () => { count++; return new Promise(resolve => release.push(resolve)); };
  const first = source.get(thread, metadata, current), duplicate = source.get(thread, metadata, current);
  const second = source.get(turnId, metadata, current);
  assert.equal((await source.get('33333333-3333-4333-8333-333333333333', metadata, current)).state, 'unavailable');
  assert.equal(count, 2); assert.equal(source.busy, 2); release.forEach(resolve => resolve(null));
  await Promise.all([first, duplicate, second]); assert.equal(source.busy, 0); assert.equal(source.flights.size, 0);
});
test('Engine question adapter requires own recent current history, uses readonly thread/read metadata only, and failure never breaks history', async t => {
  const f = await fixture(t), logs = questionFixture(t); f.engine.questions = new Questions({ root: logs.root });
  const before = f.calls.length; assert.equal((await f.engine.questionState(thread, { id: 'own' })).state, 'unavailable'); assert.equal(f.calls.length, before);
  f.desktop.hook = async (_tool, args) => ({ thread: f.desktop.thread(args.threadId), turns: [{ id: turnId, status: 'inProgress', items: [] }] });
  await f.engine.history(thread, null, { id: 'own' }); const rpc = await f.engine.stored(); rpc.request = async (method, params) => { assert.equal(method, 'thread/read'); assert.deepEqual(params, { threadId: thread, includeTurns: false }); return logs.metadata(); };
  assert.equal((await f.engine.questionState(thread, { id: 'own' })).data[0].id, key()); assert.equal((await f.engine.questionState(thread, { id: 'other' })).state, 'unavailable');
  assert.equal(f.engine.records.length, 0); assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread'));
});
