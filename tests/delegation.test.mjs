import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { item } from '../server/engine.mjs';
import { BridgeError } from '../server/rpc.mjs';
import { createBridge } from '../server/http.mjs';
import { ORIGIN } from '../server/security.mjs';
import { fixture, httpCall } from './helpers.mjs';
import { browser } from './browser-fixture.mjs';
import { replyText } from './questions-fixture.mjs';

// Synthetic native records only: never connect to Desktop or read private configuration/logs.
const controller = '11111111-1111-4111-8111-111111111111', foreign = '22222222-2222-4222-8222-222222222222';
const frame = (text, source = controller) => `<codex_delegation>\n<source_thread_id>${source}</source_thread_id>\n<input>${text}</input>\n</codex_delegation>`;
const native = (text, overrides = {}) => ({ id: 'native-request-id', type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: { text: frame(text), truncated: false }, ...overrides });
const normalize = value => item(value, 0, () => { throw new Error('Request must not register media'); }, () => { throw new Error('Request must not register files'); }, controller);
const tree = element => [element, ...element.children.filter(c => typeof c === 'object').flatMap(tree)];
const content = element => tree(element).map(n => n.textContent).join('\n');
function source(f, items) {
  f.desktop.controllerId = controller;
  f.desktop.hook = async (tool, args) => tool === 'read_thread' ? { thread: f.desktop.thread(args.threadId), page: { nextCursor: args.cursor ? null : 'real-older' }, turns: [{ id: args.cursor ? 'old-turn' : 'current-turn', status: 'completed', items: typeof items === 'function' ? items(args) : items }] } : undefined;
}

test('real native output-object request is normalized through Engine using trusted caller controller, not destination ID; native ID retained without wrappers', async t => {
  const f = await fixture(t), request = '휴대폰에서 이어서 작업해 주세요.\n두 번째 줄'; source(f, [native(request)]);
  const page = await f.engine.history('different-destination', null, { id: 'own' });
  assert.deepEqual(page.data[0].items[0], { id: 'native-request-id', type: 'userMessage', text: request, requestState: 'complete' });
  assert.equal(page.outputLimit, 1500); assert.equal(page.outputsOmitted, false);
  assert.ok(!JSON.stringify(page).includes(controller)); assert.ok(!JSON.stringify(page).includes('codex_delegation'));
  assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread' && c.args.threadId === 'different-destination' && c.args.maxOutputCharsPerItem === 1500));
  assert.equal(f.engine.records.length, 0);
});
test('Korean multiline, code, whitespace and XML closing-tag literals remain exact plain request text; no media/path capabilities are created', () => {
  const request = '  한글 첫 줄\r\n\n```xml\n<input>값 &amp; 그대로</input>\n<source_thread_id>문자 예시</source_thread_id>\n```\n<script>문자열</script>\n![예시](D:/sample.png)\n끝  \n';
  assert.equal(normalize(native(request)).text, request);
  assert.equal(normalize(native(request)).text, request);
});
test('operator text is preserved verbatim, including policy-looking suffixes and normal PC input', () => {
  const literal = 'Synthetic operator instructions — retain this text';
  for (const request of [literal, `첫 줄\n\n${literal}\n마지막`, `그대로 보존\n\n${literal}`, `앞\n${literal}`, `앞\n\n${literal}\n`, `앞\n\n${literal} 뒤`]) assert.equal(normalize(native(request)).text, request);
  const typed = `PC에서 쓴 글\n\n${literal}`;
  assert.equal(normalize({ id: 'pc', type: 'userMessage', content: [{ type: 'text', text: typed }] }).text, typed);
});
test('metadata allowlist and configured-controller guard run before output access; reasoning and arbitrary function/MCP output cannot become requests', () => {
  const secret = () => { throw new Error('Forbidden output inspected'); };
  for (const change of [{ type: 'functionCall' }, { type: 'mcpToolCall' }, { namespace: 'other' }, { name: 'read_thread' }, { namespace: undefined }]) {
    const value = { ...native('fake'), ...change, get output() { return secret(); } };
    const result = normalize(value); assert.notEqual(result.type, 'userMessage'); assert.notEqual(result.type, 'requestNotice');
  }
  assert.equal(normalize({ type: 'reasoning', get output() { return secret(); }, get content() { return secret(); } }), null);
  assert.equal(item({ ...native('fake'), get output() { return secret(); } }).type, 'functionCallOutput');
});
test('foreign source, unframed/embedded/spoofed/malformed envelope and raw output string are not promoted or disclosed', () => {
  const good = frame('UNTRUSTED_OUTPUT');
  for (const text of [frame('UNTRUSTED_OUTPUT', foreign), `tool says ${good}`, `${good}\nunrelated tail`, good.replace('</input>', '</wrong>'), good.replace('<source_thread_id>', '<source_thread_id extra="x">'), good.replace(controller, controller + '-extra'), '<input>UNTRUSTED_OUTPUT</input>']) {
    const result = normalize(native('', { output: { text, truncated: false } }));
    assert.equal(result.type, 'functionCallOutput'); assert.equal(result.text, ''); assert.ok(!JSON.stringify(result).includes('UNTRUSTED_OUTPUT'));
  }
  assert.equal(normalize(native('', { output: good })).type, 'functionCallOutput');
  for (const text of [`unrelated ${good}`, frame('foreign', foreign)])
    assert.equal(normalize(native('', { output: { text, truncated: true } })).type, 'functionCallOutput');
});
test('truncated/omitted trusted-tool requests have a truthful non-user notice, never clipped content presented as complete; bounded size fallback stays readonly', async t => {
  const complete = native('CLIPPED_PRIVATE_REQUEST');
  for (const output of [undefined, null, { text: complete.output.text }, { ...complete.output, truncated: true }, { text: complete.output.text.slice(0, -20), truncated: true }, { text: frame('x'.repeat(1501)), truncated: false }]) {
    const result = normalize(native('', { output }));
    assert.equal(result.type, 'requestNotice'); assert.equal(result.requestState, 'unavailable'); assert.match(result.text, /전체 요청은 PC/);
    assert.ok(!JSON.stringify(result).includes('CLIPPED_PRIVATE_REQUEST')); assert.ok(!JSON.stringify(result).includes(controller));
  }
  assert.equal(normalize(native('', { output: { text: frame('foreign', foreign), truncated: true } })).type, 'functionCallOutput');
  const f = await fixture(t); f.desktop.controllerId = controller;
  f.desktop.hook = async (_tool, args) => {
    if (args.includeOutputs) throw new BridgeError('HISTORY_SIZE_LIMIT', 502);
    const { output, ...metadata } = native('unused');
    return { thread: f.desktop.thread(args.threadId), turns: [{ id: 'turn', status: 'completed', items: [metadata] }] };
  };
  const page = await f.engine.history('fixture'); assert.equal(page.data[0].items[0].type, 'requestNotice'); assert.equal(page.outputsOmitted, true); assert.equal(page.outputLimit, 0);
  assert.deepEqual(f.desktop.calls.map(c => c.args.includeOutputs), [true, false]); assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread' && c.args.maxOutputCharsPerItem === 1500));
  assert.equal(f.engine.records.length, 0);
});
test('normal PC user messages and native delegated question replies keep existing readable question/answer display', () => {
  const value = replyText(), typed = normalize({ id: 'pc', type: 'userMessage', content: [{ type: 'text', text: value }] });
  const phone = normalize(native(value));
  assert.equal(typed.text, '질문 답변\n어떻게 진행할까요?\n기본 유지'); assert.equal(phone.text, typed.text);
  assert.equal(typed.id, 'pc'); assert.equal(phone.id, 'native-request-id');
});
test('authenticated history DTO exposes normalized own-controller request, not transport/raw foreign tools/reasoning; no new route or send', async t => {
  const f = await fixture(t); source(f, [native('인증된 합성 요청'), native('FOREIGN_SECRET', { id: 'foreign', namespace: 'foreign' }), { type: 'reasoning', get content() { throw new Error('reasoning inspected'); } }]);
  const server = createBridge(f); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, options) => httpCall(server.address().port, path, options), route = '/api/threads/different-destination/history';
  assert.equal((await call(route)).status, 401);
  const code = JSON.parse(readFileSync(join(f.dir, 'pairing.json'), 'utf8')).code;
  const paired = await call('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: { code } });
  const headers = { Cookie: paired.headers['set-cookie'][0].split(';')[0] };
  const result = await call(route, { headers }); assert.equal(result.status, 200); assert.equal(result.json.data[0].items[0].text, '인증된 합성 요청');
  assert.equal(result.json.data[0].items[0].type, 'userMessage'); assert.equal(result.json.data[0].items.length, 2);
  for (const omitted of [controller, 'codex_delegation', 'FOREIGN_SECRET', 'reasoning']) assert.ok(!result.text.includes(omitted));
  const override = await call(route + '?controllerId=' + foreign, { headers }); // Existing history ignores unknown query fields; never trusts them.
  assert.equal(override.status, 200); assert.equal(override.json.data[0].items[0].text, '인증된 합성 요청');
  assert.equal((await call(route, { headers: { ...headers, Origin: 'https://foreign.invalid' } })).status, 403);
  assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread')); assert.equal(f.engine.records.length, 0);
});
test('production UI shows normalized native request in ordinary user body; repeated polling/overlapping older pages retain one request, collapsed commands, video, focus and draft', async t => {
  const f = await fixture(t), request = '휴대폰 합성 요청\n<태그>코드와 XML 그대로</태그>'; let revision = 0;
  const movie = { id: 'movie', type: 'imageView', path: 'D:/synthetic-only.mp4' };
  f.engine.media.register = () => ({ state: 'ready', kind: 'video', url: '/api/media/' + 'v'.repeat(43) });
  f.engine.files.register = () => null;
  const current = () => ({ id: 'current-turn', startedAt: 2, status: 'completed', items: [native(request), { id: 'command', type: 'commandExecution', command: '合成 command', aggregatedOutput: '限定 output' }, movie, { id: 'a', type: 'agentMessage', text: `진행 ${revision}` }, { id: 'foreign', type: 'functionCallOutput', namespace: 'foreign', name: 'send_message_to_thread', output: { text: frame('HIDDEN_FOREIGN'), truncated: false } }, { id: 'reason', type: 'reasoning', get content() { throw new Error('reasoning inspected'); } }] });
  f.desktop.controllerId = controller;
  f.desktop.hook = async (_tool, args) => ({ thread: f.desktop.thread(args.threadId), turns: args.cursor ? [current(), { id: 'older-turn', startedAt: 1, status: 'completed', items: [native('예전 휴대폰 요청'), { id: 'pc', type: 'userMessage', content: [{ type: 'text', text: 'PC 정상 입력' }] }] }] : [current()], page: { nextCursor: args.cursor ? null : 'actual-old-page' } });
  const ui = await browser({ selected: false });
  ui.hook(async path => path.includes('/history') ? { data: await f.engine.history('fixture', path.includes('?') ? 'actual-old-page' : null, { id: 'own' }) } : null);
  await ui.ui.openThread('fixture');
  const key = JSON.stringify(['current-turn', 'native-request-id', 'userMessage']), requestUi = ui.ui.state.historyNodes.get(key);
  assert.ok(requestUi); assert.equal(requestUi.role.textContent, '나'); assert.equal(requestUi.root.className, 'message userMessage'); assert.ok(content(requestUi.body).includes(request));
  assert.equal(tree(requestUi.body).filter(n => n.tagName === 'P')[0].textContent, request); assert.equal(tree(requestUi.body).filter(n => n.tagName === '태그').length, 0);
  const group = tree(ui.el('messages')).find(n => n.tagName === 'DETAILS'), video = tree(ui.el('messages')).find(n => n.tagName === 'VIDEO');
  assert.ok(!group.open); assert.match(group.children[0].textContent, /작업 내역 2개/); group.children[0].focus();
  await video.play(); video.currentTime = 0.4; const detached = video.detachCount || 0;
  ui.el('draft').value = '보존할 별도 초안';
  for (let n = 0; n < 3; n++) { revision++; await ui.ui.refreshCurrent(); }
  await ui.el('moreHistory').onclick();
  assert.equal(ui.ui.state.historyNodes.get(key), requestUi); assert.equal(tree(ui.el('messages')).filter(n => n === requestUi.root).length, 1);
  assert.equal(tree(ui.el('messages')).filter(n => n.className === 'message userMessage').length, 3); // Current request, older request, PC input.
  assert.equal(tree(ui.el('messages')).find(n => n.tagName === 'VIDEO'), video); assert.equal(video.currentTime, 0.4); assert.equal(video.paused, false); assert.equal(video.detachCount || 0, detached);
  assert.equal(ui.document.activeElement, group.children[0]); assert.ok(!group.open); assert.equal(ui.el('draft').value, '보존할 별도 초안');
  for (const hidden of ['HIDDEN_FOREIGN', 'codex_delegation', controller]) assert.ok(!content(ui.el('messages')).includes(hidden));
  assert.ok(!ui.calls.some(c => c.path === '/api/send')); assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread'));
});
test('production UI leaves unavailable request notice outside collapsed work without attributing missing or clipped contents to the user', async () => {
  const ui = await browser(); const notice = normalize(native('', { output: undefined }));
  ui.hook(path => path.endsWith('/history') ? { data: { data: [{ id: 'turn', status: 'completed', items: [notice, { id: 'cmd', type: 'commandExecution', text: '실제 명령은 접힘' }] }], status: 'idle', nextCursor: null } } : null);
  await ui.ui.refreshCurrent();
  const message = tree(ui.el('messages')).find(n => n.className === 'message requestNotice'); assert.ok(message); assert.match(content(message), /원문 확인 불가/); assert.match(content(message), /전체 요청은 PC/);
  assert.equal(tree(ui.el('messages')).filter(n => n.className === 'message userMessage').length, 0); assert.ok(!tree(ui.el('messages')).find(n => n.tagName === 'DETAILS').open);
});
