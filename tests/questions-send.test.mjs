import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../server/engine.mjs';
import { Questions, questionParser } from '../server/questions.mjs';
import { BridgeError } from '../server/rpc.mjs';
import { browser } from './browser-fixture.mjs';
import { fixture, waitFor, httpCall } from './helpers.mjs';
import { createBridge } from '../server/http.mjs';
import { questionFixture, thread, turnId, key, record, question, reply, lines } from './questions-fixture.mjs';

const nodes = root => [root, ...(root.children ?? []).flatMap(child => typeof child === 'object' ? nodes(child) : [])];
const find = (root, tag) => nodes(root).filter(n => n.tagName === tag.toUpperCase());
const ended = () => record('event_msg', { type: 'task_complete', turn_id: turnId });
const current = { id: turnId, status: 'inProgress' };
async function owned(t) {
  const f = await fixture(t), logs = questionFixture(t), session = { id: 'own-question-fixture' };
  f.engine.questions = new Questions({ root: logs.root });
  const rpc = await f.engine.stored(); let metadataCalls = 0;
  rpc.request = async (method, params) => { assert.equal(method, 'thread/read'); assert.deepEqual(params, { threadId: thread, includeTurns: false }); metadataCalls++; return logs.metadata(); };
  await f.engine.history(thread, null, session);
  const q = (await f.engine.questionState(thread, session)).data[0];
  const input = () => ({ threadId: thread, requestId: randomUUID(), text: `질문: ${q.title}\n답변: 기본 유지`, question: { id: q.id, sourceKey: q.sourceKey } });
  return { ...f, logs, session, q, input, metadataCalls: () => metadataCalls };
}

test('parser to shipped renderer: task completion/new turn retains async radio labels, direct text, focus and exact identity; only native reply becomes answered', async () => {
  const parser = questionParser(thread); parser.record(record('session_meta', { id: thread })); parser.record(record('turn_context', { turn_id: turnId })); parser.record(question());
  let result = parser.result(current), sendInput;
  const f = await browser({ selected: false, requestHook: (path, options) => path.endsWith('/questions') ? { data: result } : path === '/api/send' ? (() => { sendInput = JSON.parse(options.body); return { data: { requestId: sendInput.requestId, threadId: thread, state: 'delivered' } }; })() : null });
  await f.ui.openThread(thread); await waitFor(() => f.ui.state.questionNodes.size);
  const card = f.ui.state.questionNodes.get(key()), radios = find(card.root, 'input'), direct = find(card.root, 'textarea')[0];
  assert.equal(card.root.children.at(-1).hidden, false);
  radios[0].parent.children[1].click(); // Actual label text activation -> native radio input/change in the isolated DOM.
  assert.equal(radios[0].checked, true); assert.equal(card.answer, '기본 유지'); assert.equal(card.send.disabled, false);
  radios[1].parent.click(); assert.equal(radios[0].checked, false); assert.equal(radios[1].checked, true); assert.equal(card.answer, '더 짧게');
  radios[1].click(); assert.equal(radios[1].checked, true); // Clicking a selected radio does not clear it.
  direct.value = '직접 작성한 답변'; direct.dispatchEvent({ type: 'input', bubbles: true }); direct.focus();
  f.el('draft').value = '별도 일반 초안';
  const poll = async () => { f.ui.state.questionAt = 0; await f.ui.refreshCurrent(); await waitFor(() => !f.ui.state.questionFlight); };
  for (const event of [ended(), record('event_msg', { type: 'task_started', turn_id: '33333333-3333-4333-8333-333333333333' })]) {
    parser.record(event); result = parser.result({ id: '33333333-3333-4333-8333-333333333333', status: 'inProgress' });
    assert.equal(result.data[0].state, 'historical'); await poll();
    assert.equal(f.ui.state.questionNodes.get(key()), card); assert.equal(f.document.activeElement, direct); assert.equal(direct.value, '직접 작성한 답변'); assert.equal(card.send.disabled, false);
    assert.match(card.status.textContent, /이전 작업.*대기 여부는 확인할 수 없습니다/);
  }
  await card.send.click(); assert.deepEqual(sendInput.question, { id: key(), sourceKey: result.data[0].sourceKey });
  assert.equal(sendInput.threadId, thread); assert.equal(sendInput.text, '질문: 어떻게 진행할까요?\n답변: 직접 작성한 답변'); assert.ok(!sendInput.text.includes('send_user_message_question_reply'));
  assert.equal(f.el('draft').value, '별도 일반 초안'); assert.equal(card.send.disabled, true); assert.equal(f.ui.state.questionNodes.has(key()), false); assert.equal(f.el('questions').hidden, true);
  // A normal phone message is not evidence of a PC form answer.
  parser.record(record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: sendInput.text }] }));
  result = parser.result(current); assert.equal(result.data[0].state, 'historical'); await poll(); assert.equal(f.ui.state.questionNodes.has(key()), false);
  parser.record(reply()); result = parser.result(current); await poll();
  assert.equal(result.data[0].state, 'answered'); assert.equal(f.ui.state.questionNodes.has(key()), false);
  const sends = f.calls.filter(c => c.path === '/api/send').length; await card.send.onclick(); assert.equal(f.calls.filter(c => c.path === '/api/send').length, sends);
});

test('first load of ended unanswered async question offers explicit message controls without claiming current waiting; changed source preserves draft but blocks send and offers GET recovery', async () => {
  const p = questionParser(thread); for (const r of [record('session_meta', { id: thread }), record('turn_context', { turn_id: turnId }), question(), ended()]) p.record(r);
  let result = p.result({ id: turnId, status: 'completed' });
  const f = await browser({ selected: false, requestHook: path => path.endsWith('/questions') ? { data: result } : null }); await f.ui.openThread(thread); await waitFor(() => f.ui.state.questionNodes.size);
  const card = f.ui.state.questionNodes.get(key()); assert.equal(card.question.state, 'historical'); assert.ok(card.send); assert.equal(f.el('questions').open, true);
  assert.equal(card.root.children.at(-1).hidden, false); const radio = find(card.root, 'input')[0]; radio.parent.click(); radio.focus();
  result = { ...result, data: [{ ...result.data[0], sourceKey: 'f'.repeat(64), options: ['다른 선택'] }] };
  f.ui.state.questionAt = 0; await f.ui.refreshCurrent(); await waitFor(() => !f.ui.state.questionFlight);
  assert.equal(f.ui.state.questionNodes.get(key()), card); assert.equal(f.document.activeElement, radio); assert.equal(card.answer, '기본 유지'); assert.equal(card.send.disabled, true); assert.equal(card.retry.hidden, false); assert.match(card.feedback.textContent, /내용이 변경/);
  await card.send.onclick(); await card.retry.click(); assert.ok(!f.calls.some(c => c.options.method === 'POST'));
});

test('fresh owned source validation survives ended turn; durable hash-only association separates delivery from native answer and deduplicates across restart', async t => {
  const f = await owned(t); fs.appendFileSync(f.logs.file, lines([ended()]));
  const input = f.input(), before = f.metadataCalls(); assert.equal((await f.engine.send(f.session, input)).state, 'delivered'); assert.ok(f.metadataCalls() > before);
  const sends = f.desktop.calls.filter(c => c.tool === 'send_message_to_thread'); assert.equal(sends.length, 1); assert.deepEqual(sends[0].args, { threadId: thread, hostId: 'local', prompt: input.text });
  assert.deepEqual(await f.engine.send(f.session, input), f.engine.receipt(f.session, input.requestId));
  const restarted = new Engine(f.desktop, f.dir, { historyRpcFactory: async () => f.rpc }); restarted.questions = new Questions({ root: f.logs.root });
  await restarted.history(thread, null, f.session); const result = await restarted.questionState(thread, f.session);
  assert.equal(result.data[0].state, 'historical'); assert.equal(result.data[0].messageState, 'delivered');
  await assert.rejects(restarted.send(f.session, f.input()), e => e.code === 'QUESTION_MESSAGE_DELIVERED');
  await restarted.history(thread, null, { id: 'other-owner' }); assert.equal((await restarted.questionState(thread, { id: 'other-owner' })).data[0].messageState, undefined);
  const disk = fs.readFileSync(join(f.dir, 'requests.json'), 'utf8'); assert.ok(!disk.includes(input.text)); assert.ok(!disk.includes(f.q.title)); assert.ok(!disk.includes(f.q.id)); assert.match(JSON.parse(disk)[0].questionKey, /^[a-f0-9]{64}$/);
  fs.appendFileSync(f.logs.file, lines([reply()])); const answered = await restarted.questionState(thread, f.session, { fresh: true }); assert.equal(answered.data[0].state, 'answered'); assert.equal(answered.data[0].messageState, 'delivered');
  assert.equal(f.desktop.calls.filter(c => c.tool === 'send_message_to_thread').length, 1);
});

test('authenticated HTTP parser-to-renderer explicit answer survives browser reload as message-delivered, not native answered; draft and staged composer files stay separate', async t => {
  const f = await owned(t); fs.appendFileSync(f.logs.file, lines([ended()]));
  const server = createBridge(f); await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  const paired = f.auth.pair(JSON.parse(fs.readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1');
  const headers = { Cookie: `codex_phone=${paired.token}`, Origin: 'http://100.64.0.10:47831', 'Content-Type': 'application/json', 'X-Codex-CSRF': paired.session.csrf };
  const route = `/api/threads/${thread}/questions`;
  assert.equal((await httpCall(server.address().port, route)).status, 401);
  const hook = async (path, options) => {
    if (path !== '/api/session' && !path.startsWith(`/api/threads/${thread}`) && path !== '/api/send' && !path.startsWith('/api/requests/')) return null;
    const response = await httpCall(server.address().port, path, { method: options.method, headers, ...(options.body ? { data: JSON.parse(options.body) } : {}) });
    return { status: response.status, data: response.json };
  };
  const b = await browser({ selected: false, requestHook: hook }); await b.ui.openThread(thread); await waitFor(() => b.ui.state.questionNodes.size);
  const card = b.ui.state.questionNodes.get(key()); assert.equal(card.root.children.at(-1).hidden, false); find(card.root, 'input')[0].parent.children[1].click();
  b.el('draft').value = '일반 초안은 별도로 유지'; b.el('draft').oninput();
  b.el('attachFiles').click(); b.el('attachmentPicker').files = [new File(['synthetic'], '별도첨부.txt')]; b.el('attachmentPicker').onchange();
  await card.send.click(); assert.equal(b.ui.state.questionNodes.has(key()), false); assert.equal(b.el('draft').value, '일반 초안은 별도로 유지'); assert.equal(b.evaluate('attachments.rows(state.selected).length'), 1);
  const post = b.calls.filter(c => c.path === '/api/send'); assert.equal(post.length, 1); assert.equal(JSON.parse(post[0].options.body).attachments, undefined);
  const reloaded = await browser({ selected: false, requestHook: hook }); await reloaded.ui.openThread(thread); await waitFor(() => reloaded.ui.state.questionResult?.state === 'ready');
  assert.equal(reloaded.ui.state.questionNodes.has(key()), false); assert.equal(reloaded.el('questions').hidden, true);
  const observed = (await httpCall(server.address().port, route, { headers })).json.data[0];
  assert.equal(observed.state, 'historical'); assert.equal(observed.messageState, 'delivered');
  assert.ok(!reloaded.calls.some(c => c.path === '/api/send'));
  const unsafe = await httpCall(server.address().port, '/api/send', { method: 'POST', headers, data: { ...f.input(), question: null } }); assert.equal(unsafe.status, 400);
  assert.equal(f.desktop.calls.filter(c => c.tool === 'send_message_to_thread').length, 1);
});

test('question preflight rejects stale cache, answered/missing/replaced source, forged IDs and foreign ownership without any native write', async t => {
  for (const change of ['answer', 'replace', 'missing', 'owner', 'key', 'blocking', 'text']) {
    const f = await owned(t), input = f.input();
    if (change === 'answer') fs.appendFileSync(f.logs.file, lines([reply()]));
    if (change === 'replace') fs.writeFileSync(f.logs.file, lines([record('session_meta', { id: thread }), question('call_first', '동일 ID지만 바뀐 질문')]));
    if (change === 'missing') fs.unlinkSync(f.logs.file);
    if (change === 'owner') f.session = { id: 'not-history-owner' };
    if (change === 'key') input.question.sourceKey = '0'.repeat(64);
    if (change === 'blocking') input.question.id = '["request_user_input","call_first",0]';
    if (change === 'text') input.text = '다른 질문에 대한 임의 답변';
    await assert.rejects(f.engine.send(f.session, input), e => ['QUESTION_SOURCE_CHANGED', 'INVALID_QUESTION'].includes(e.code));
    assert.ok(!f.desktop.calls.some(c => c.tool === 'send_message_to_thread'));
    assert.ok(f.engine.records.every(r => r.state === 'rejected'));
  }
  const f = await owned(t);
  for (const invalid of [null, [], 'string', { id: key(), sourceKey: 'bad' }, { id: '["request_user_input_async", "call_first",0]', sourceKey: f.q.sourceKey }]) {
    await assert.rejects(f.engine.send(f.session, { ...f.input(), question: invalid }), e => e.status === 400);
  }
});

test('question rejected preflight allows deliberate retry; uncertain/request identity recovery never auto-replays or becomes native answered', async t => {
  const f = await owned(t), input = f.input(); let reject = true;
  f.engine.options.validate = async () => { if (reject) throw new BridgeError('MODEL_CHOICE_UNAVAILABLE', 409); };
  input.model = 'fixture-model'; await assert.rejects(f.engine.send(f.session, input), e => e.code === 'MODEL_CHOICE_UNAVAILABLE');
  assert.equal(f.engine.receipt(f.session, input.requestId).state, 'rejected');
  assert.equal((await f.engine.questionState(thread, f.session)).data[0].messageState, undefined); // Unvalidated client associations are never journaled.
  reject = false;
  await assert.rejects(f.engine.send(f.session, { ...input, requestId: randomUUID() }, () => { throw new BridgeError('AUTH_REQUIRED', 401); }), e => e.code === 'AUTH_REQUIRED');
  assert.equal((await f.engine.questionState(thread, f.session)).data[0].messageState, 'rejected');
  f.desktop.hook = async tool => { if (tool === 'send_message_to_thread') throw new BridgeError('DESKTOP_TIMEOUT', 503); };
  const retryInput = { ...input, requestId: randomUUID() }; await assert.rejects(f.engine.send(f.session, retryInput), e => e.code === 'SEND_UNCERTAIN');
  assert.equal((await f.engine.questionState(thread, f.session)).data[0].messageState, 'uncertain');
  assert.equal((await f.engine.send(f.session, retryInput)).state, 'uncertain');
  await assert.rejects(f.engine.send(f.session, { ...retryInput, question: { ...retryInput.question, sourceKey: 'a'.repeat(64) } }), e => e.code === 'REQUEST_ID_CONFLICT');
  assert.equal(f.desktop.calls.filter(c => c.tool === 'send_message_to_thread').length, 1);
  await f.engine.history(thread, null, f.session); await f.engine.acknowledge(f.session, retryInput.requestId, { threadId: thread, confirmed: true });
  assert.equal((await f.engine.questionState(thread, f.session)).data[0].messageState, 'acknowledged');
  await assert.rejects(f.engine.send(f.session, { ...retryInput, requestId: randomUUID() }), e => e.code === 'QUESTION_MESSAGE_UNCONFIRMED');
});

test('missing readonly runtime yields sanitized HTTP diagnostic, then exact parser choices recover with GET-only retry and input retained through another outage', async t => {
  const f = await fixture(t), logs = questionFixture(t); let now = 10000, missing = true, starts = 0;
  f.engine.now = () => now; f.engine.questions = new Questions({ root: logs.root, now: () => now });
  f.engine.historyRpcFactory = async () => {
    starts++; if (missing) throw new BridgeError('CODEX_INSTALL_UNAVAILABLE');
    return { closed: false, close() { this.closed = true; }, async request(method, params) { assert.equal(method, 'thread/read'); assert.equal(params.threadId, thread); assert.equal(params.includeTurns, false); return logs.metadata(); } };
  };
  const server = createBridge(f); await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  const paired = f.auth.pair(JSON.parse(fs.readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1');
  const headers = { Cookie: `codex_phone=${paired.token}` };
  const b = await browser({ selected: false, requestHook: async (path, options) => {
    if (!path.startsWith(`/api/threads/${thread}`)) return null;
    assert.ok(!options.method || options.method === 'GET');
    const response = await httpCall(server.address().port, path, { headers }); return { status: response.status, data: response.json };
  } });
  await b.ui.openThread(thread); await waitFor(() => b.ui.state.questionResult?.reason === 'runtime-unavailable');
  assert.equal(b.ui.state.questionNodes.size, 0); assert.match(b.el('questionStatus').textContent, /질문 조회 연결.*업데이트/);
  const dto = await httpCall(server.address().port, `/api/threads/${thread}/questions`, { headers });
  assert.deepEqual(dto.json, { state: 'unavailable', data: [], reason: 'runtime-unavailable' }); assert.ok(!dto.text.includes(logs.root));
  missing = false; now += 2001; await b.el('questionRetry').click();
  const card = b.ui.state.questionNodes.get(key()); assert.equal(find(card.root, 'input').length, 2); assert.equal(card.root.children.at(-1).hidden, false); find(card.root, 'input')[1].parent.click();
  const direct = find(card.root, 'textarea')[0]; direct.value = '중단 중에도 보존할 답변'; direct.dispatchEvent({ type: 'input', bubbles: true }); direct.focus(); b.el('draft').value = '일반 초안';
  missing = true; f.engine.historyRpc.closed = true; now += 30001; b.ui.state.questionAt = 0; await b.ui.refreshCurrent(); await waitFor(() => !b.ui.state.questionFlight);
  assert.equal(card.send.disabled, true); assert.equal(b.ui.state.questionNodes.get(key()), card); assert.equal(b.document.activeElement, direct);
  missing = false; now += 2001; await b.el('questionRetry').click();
  assert.equal(b.ui.state.questionNodes.get(key()), card); assert.equal(direct.value, '중단 중에도 보존할 답변'); assert.equal(card.send.disabled, false); assert.equal(b.el('draft').value, '일반 초안');
  assert.ok(starts >= 4); assert.ok(b.calls.every(c => !c.options.method || c.options.method === 'GET')); assert.ok(f.desktop.calls.every(c => ['list_threads', 'read_thread'].includes(c.tool)));
});
