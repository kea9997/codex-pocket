import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

const nodes = root => [root, ...(root.children ?? []).flatMap(child => typeof child === 'object' ? nodes(child) : [])];
const find = (root, tag) => nodes(root).filter(n => n.tagName === tag.toUpperCase());
const text = root => typeof root === 'string' ? root : root.textContent + (root.children ?? []).map(text).join('');
const q = (id = 'q-live', extra = {}) => ({ id, state: 'unconfirmed', title: '어떤 방향으로 진행할까요?', options: ['기본 유지', '더 짧게'], turnId: 'current', ...(!extra.state || extra.state === 'unconfirmed' ? { sourceKey: 'a'.repeat(64) } : {}), ...extra });
async function setup() {
  const f = await browser({ selected: false }); let questions = { state: 'ready', data: [q()] }, items = [{ id: 'a', type: 'agentMessage', text: '선택을 기다리면서 작업 중입니다.' }], send = null;
  f.hook((path, options) => path.endsWith('/questions') ? { data: questions } : path.endsWith('/history') ? { data: { data: [{ id: 'current', status: 'inProgress', items }], status: 'active', nextCursor: null } } : path === '/api/send' && send ? send(path, options) : null);
  await f.ui.openThread('fixture'); await waitFor(() => f.ui.state.questionNodes.size > 0);
  return { ...f, questions: value => { questions = value; }, items: value => { items = value; }, send: value => { send = value; }, poll: async () => { f.ui.state.questionAt = 0; await f.ui.refreshCurrent(); await waitFor(() => !f.ui.state.questionFlight); } };
}
test('question radios/text are immediately available with explicit same-ID send; polling preserves selection/focus/other card and composer draft', async () => {
  const f = await setup(); f.questions({ state: 'ready', data: [q(), q('second')] }); await f.poll();
  const card = f.ui.state.questionNodes.get('q-live'), second = f.ui.state.questionNodes.get('second');
  const radios = find(card.root, 'input'), direct = find(card.root, 'textarea')[0];
  assert.ok(radios.every(r => r.checked === false)); assert.equal(card.send.disabled, true); assert.ok(!f.calls.some(c => c.path === '/api/send'));
  assert.ok(!find(card.root, 'button').some(n => n.textContent === '답변 메시지 작성')); assert.ok(!card.root.children.at(-1).hidden);
  radios[1].click(); assert.equal(card.send.disabled, false);
  find(second.root, 'textarea')[0].value = '다른 선택 보존'; find(second.root, 'textarea')[0].oninput();
  direct.focus(); f.el('draft').value = '일반 초안을 지우지 마세요';
  f.items([{ id: 'a', type: 'agentMessage', text: '계속 들어오는 진행 메시지' }]); await f.poll();
  assert.equal(f.ui.state.questionNodes.get('q-live'), card); assert.equal(radios[1].checked, true); assert.equal(f.document.activeElement, direct); assert.equal(second.answer, '다른 선택 보존');
  direct.value = '선택 대신 직접 답변'; direct.oninput(); assert.ok(radios.every(r => !r.checked));
  let resolve; f.send((_path, options) => new Promise(done => { resolve = () => { const input = JSON.parse(options.body); done({ data: { requestId: input.requestId, threadId: input.threadId, state: 'delivered' } }); }; }));
  const sending = card.send.onclick(); await waitFor(() => resolve); await card.send.onclick();
  assert.equal(f.calls.filter(c => c.path === '/api/send').length, 1); assert.equal(card.send.disabled, true);
  const input = JSON.parse(f.calls.find(c => c.path === '/api/send').options.body); assert.equal(input.threadId, 'fixture'); assert.deepEqual(Object.keys(input).sort(), ['question', 'requestId', 'text', 'threadId']); assert.deepEqual(input.question, { id: 'q-live', sourceKey: 'a'.repeat(64) }); assert.match(input.text, /직접 답변/);
  resolve(); await sending; assert.equal(f.el('draft').value, '일반 초안을 지우지 마세요'); assert.equal(card.send.disabled, true);
  assert.equal(f.ui.state.questionNodes.has('q-live'), false); assert.equal(card.root.parent, null);
  assert.match(f.el('questionSummary').textContent, /미응답 질문 1개/); await f.poll(); assert.equal(f.ui.state.questionNodes.has('q-live'), false);
});
test('answered/unverified historical/blocking cards are read-only; unavailable blocks stale send but preserves card text and later recovery', async () => {
  const f = await setup(), live = f.ui.state.questionNodes.get('q-live');
  find(live.root, 'textarea')[0].value = '유지할 답변'; find(live.root, 'textarea')[0].oninput();
  f.questions({ state: 'unavailable', data: [] }); await f.poll(); assert.equal(live.send.disabled, true); assert.equal(live.answer, '유지할 답변'); assert.equal(f.ui.state.questionNodes.get('q-live'), live);
  f.questions({ state: 'ready', data: [q(), q('old', { state: 'answered', answer: '기본 유지' }), q('closed', { state: 'historical' }), q('blocking', { state: 'pc-only', title: 'PC에서 질문 확인' })] }); await f.poll();
  assert.equal(live.send.disabled, false);
  assert.equal(f.ui.state.questionNodes.has('old'), false);
  for (const id of ['closed', 'blocking']) { const card = f.ui.state.questionNodes.get(id); assert.equal(find(card.root, 'input').length, 0); assert.equal(find(card.root, 'button').length, 0); }
  assert.ok(!text(f.el('questionCards')).includes('답변: 기본 유지'));
  f.questions({ state: 'ready', data: [q('q-live', { state: 'answered', answer: 'PC에서 선택한 답변' })] }); await f.poll();
  await live.send.onclick(); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('question sends obey uncertain/other-pending/offline safeguards; no auto-resend and late old-thread cards cannot send', async () => {
  const f = await setup(), card = f.ui.state.questionNodes.get('q-live'), direct = find(card.root, 'textarea')[0]; direct.value = '답변'; direct.oninput();
  for (const change of [() => { f.ui.state.capability.uncertain = true; }, () => { f.ui.state.capability.uncertain = false; f.ui.state.pending = { threadId: 'other', requestId: 'pending' }; }, () => { f.ui.state.pending = null; f.ui.state.connected = false; }]) {
    change(); f.ui.composerState(); await card.send.onclick(); assert.equal(card.send.disabled, true);
  }
  f.ui.state.connected = true; f.ui.composerState();
  f.send(() => ({ status: 409, data: { error: 'SEND_UNCERTAIN' } })); await card.send.onclick(); await card.send.onclick();
  assert.equal(f.calls.filter(c => c.path === '/api/send').length, 1); assert.ok(f.ui.state.pending); assert.equal(f.el('checkSend').hidden, false);
  await f.ui.openThread('other'); await card.send.onclick(); assert.equal(f.calls.filter(c => c.path === '/api/send').length, 1);
});
test('radio groups remain independent as earlier cards disappear and later cards are added across polls', async () => {
  const f = await setup(); f.questions({ state: 'ready', data: [q(), q('survivor')] }); await f.poll();
  const survivor = f.ui.state.questionNodes.get('survivor'), first = find(survivor.root, 'input')[0];
  const choose = radio => { radio.parent.click(); }; // Implicit label activation and native same-name grouping in the DOM fixture.
  choose(first); first.focus(); f.questions({ state: 'ready', data: [q('survivor')] }); await f.poll();
  assert.equal(f.ui.state.questionNodes.get('survivor'), survivor); assert.equal(f.document.activeElement, first);
  f.questions({ state: 'ready', data: [q('survivor'), q('newcomer')] }); f.items([{ id: 'a', type: 'agentMessage', text: '새 질문이 추가된 진행 메시지' }]); await f.poll();
  const newcomer = f.ui.state.questionNodes.get('newcomer'), second = find(newcomer.root, 'input')[1];
  assert.notEqual(first.name, second.name); assert.equal(first.checked, true); assert.equal(f.document.activeElement, first);
  choose(second); assert.equal(first.checked, true); assert.equal(second.checked, true); assert.equal(survivor.answer, '기본 유지'); assert.equal(newcomer.answer, '더 짧게');
  await f.poll(); assert.equal(first.checked, true); assert.equal(second.checked, true); assert.equal(f.document.activeElement, second);
  f.questions({ state: 'ready', data: [q('newcomer')] }); await f.poll(); f.questions({ state: 'ready', data: [q('newcomer'), q('last')] }); await f.poll();
  const last = find(f.ui.state.questionNodes.get('last').root, 'input')[0]; choose(last);
  assert.notEqual(last.name, second.name); assert.equal(second.checked, true); assert.equal(last.checked, true); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('unavailable/answered history stays quietly folded; title-only preferences use explicit ordinary answer messages', async () => {
  const f = await setup(); f.questions({ state: 'ready', data: [] }); await f.poll(); assert.equal(f.el('questions').hidden, true);
  f.questions({ state: 'unavailable', data: [] }); await f.poll();
  assert.equal(f.el('questions').hidden, false); assert.match(f.el('questionSummary').textContent, /확인 불가/); assert.ok(f.el('questionStatus').textContent.length < 80);
  f.questions({ state: 'ready', data: [q('old', { state: 'answered', answer: '기본 유지' }), q('ended', { state: 'historical' })] }); await f.poll();
  assert.equal(f.el('questions').open, true); assert.equal(f.el('questionStatus').hidden, true); assert.equal(find(f.el('questionCards'), 'button').length, 0); assert.equal(f.ui.state.questionNodes.has('old'), false);
  f.el('questions').open = true; f.el('questionSummary').focus(); await f.poll(); assert.equal(f.el('questions').open, true); assert.equal(f.document.activeElement, f.el('questionSummary'));
  const preference = q('free', { title: '권한 설정과 token 디자인의 편집 방향', options: [] });
  f.questions({ state: 'ready', data: [preference] }); await f.poll(); assert.equal(f.el('questions').open, true); assert.equal(f.el('questionStatus').hidden, true);
  const card = f.ui.state.questionNodes.get('free'); assert.equal(find(card.root, 'input').length, 0); assert.equal(card.send.disabled, true);
  assert.ok(!text(card.root).includes('네이티브')); assert.ok(text(card.root).includes('답변을 이 대화에 메시지로 보냅니다.'));
  const direct = find(card.root, 'textarea')[0]; direct.value = '더 단순한 디자인'; direct.oninput(); direct.focus(); f.el('draft').value = '보존할 일반 초안';
  f.questions({ state: 'loading', data: [] }); await f.poll(); assert.equal(card.send.disabled, true); assert.equal(f.el('questions').open, true); assert.equal(f.document.activeElement, direct);
  f.questions({ state: 'ready', data: [preference] }); await f.poll(); assert.equal(card.send.disabled, false); assert.equal(direct.value, '더 단순한 디자인');
  f.send((_path, options) => { const input = JSON.parse(options.body); return { data: { state: 'delivered', requestId: input.requestId, threadId: input.threadId } }; });
  await card.send.onclick(); const sends = f.calls.filter(c => c.path === '/api/send'); assert.equal(sends.length, 1);
  const input = JSON.parse(sends[0].options.body); assert.equal(input.threadId, 'fixture'); assert.equal(input.text, `질문: ${preference.title}\n답변: 더 단순한 디자인`);
  assert.ok(!input.text.includes('send_user_message_question_reply')); assert.equal(f.el('draft').value, '보존할 일반 초안');
});
test('recent question coverage is explicit even with zero results, preserves edited cards through window changes/errors and requires a fresh source match before sending', async () => {
  const f = await setup(), card = f.ui.state.questionNodes.get('q-live'), direct = find(card.root, 'textarea')[0];
  direct.value = '최근 구간에서도 유지할 답변'; direct.oninput(); direct.focus();
  f.questions({ state: 'ready', coverage: 'recent', reason: 'recent-window', data: [] }); await f.poll();
  assert.equal(f.el('questions').hidden, false); assert.match(f.el('questionSummary').textContent, /최근 구간/); assert.match(f.el('questionStatus').textContent, /전체 기록에 질문이 없다는 뜻이 아닙니다/);
  assert.equal(f.ui.state.questionNodes.get('q-live'), card); assert.equal(f.document.activeElement, direct); assert.equal(f.el('questions').open, true); assert.equal(card.send.disabled, true); assert.equal(direct.value, '최근 구간에서도 유지할 답변');
  f.questions({ state: 'unavailable', reason: 'line-too-large', data: [] }); await f.poll(); assert.match(f.el('questionStatus').textContent, /512KiB/); assert.equal(card.send.disabled, true);
  f.questions({ state: 'ready', coverage: 'recent', data: [q()] }); await f.poll(); assert.equal(card.send.disabled, false); assert.equal(f.ui.state.questionNodes.get('q-live'), card); assert.equal(direct.value, '최근 구간에서도 유지할 답변');
  f.questions({ state: 'ready', coverage: 'recent', data: [q('q-live', { turnId: null })] }); await f.poll(); assert.equal(f.ui.state.questionNodes.get('q-live'), card); assert.equal(f.document.activeElement, direct); assert.equal(direct.value, '최근 구간에서도 유지할 답변');
  assert.equal(f.el('questionRetry').hidden, false); await f.el('questionRetry').onclick(); assert.equal(f.el('questionRetry').disabled, false); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('pending-only mixed states, exact receipts, native answer during edit and routine IME/poll never send or replace ordinary drafts', async () => {
  const f = await setup(), sourceKey = 'a'.repeat(64);
  const mixed = [q(), q('history', { state: 'historical', sourceKey }), q('native', { state: 'answered' }), q('sent', { messageState: 'delivered' }), ...['reserved', 'uncertain', 'acknowledged', 'rejected'].map(messageState => q(messageState, { messageState }))];
  f.questions({ state: 'ready', data: mixed }); await f.poll();
  assert.equal(f.ui.state.questionNodes.size, 6); assert.match(f.el('questionSummary').textContent, /미응답 질문 6개/); assert.equal(f.el('questions').open, true);
  assert.ok(f.ui.state.questionNodes.get('history').send);
  for (const receipt of ['reserved', 'uncertain', 'acknowledged', 'rejected']) {
    const card = f.ui.state.questionNodes.get(receipt), input = find(card.root, 'textarea')[0]; input.value = '보관'; input.oninput();
    assert.equal(card.send.disabled, receipt !== 'rejected');
    if (receipt !== 'rejected') assert.match(card.feedback.textContent, /전달 여부가 미확인/);
  }
  const live = f.ui.state.questionNodes.get('q-live'), direct = find(live.root, 'textarea')[0]; direct.value = '작성 중'; direct.oninput(); direct.focus();
  f.el('draft').value = '독립 초안'; f.el('history').scrollTop = 51; f.el('questions').open = false;
  f.window.visualViewport = { height: 260 }; f.windowEvents.get('resize')(); await f.poll();
  assert.equal(f.document.activeElement, direct); assert.equal(f.el('questions').open, false); assert.equal(f.el('history').scrollTop, 51);
  f.ui.state.questionReceipts.set('other/q-live', sourceKey); await f.poll(); assert.equal(f.ui.state.questionNodes.get('q-live'), live);
  f.ui.state.questionReceipts.set('fixture/q-live', 'b'.repeat(64)); await f.poll(); assert.equal(f.ui.state.questionNodes.get('q-live'), live);
  f.questions({ state: 'ready', data: [q('q-live', { state: 'answered', answer: 'PC 합성 응답' })] }); await f.poll();
  assert.equal(f.ui.state.questionNodes.has('q-live'), false); await live.send.onclick(); assert.equal(f.el('draft').value, '독립 초안');
  f.questions({ state: 'ready', data: [q('new')] }); await f.poll(); assert.equal(f.el('questions').open, true);
  assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('many tool items fold into one stable group; assistant progress, failure, copy focus and playing video remain visible/attached', async () => {
  const f = await setup(); const video = { id: 'video', type: 'imageView', media: { kind: 'video', state: 'ready', url: '/api/media/' + 'v'.repeat(43) } };
  const tools = Array.from({ length: 15 }, (_, n) => ({ id: `tool-${n}`, type: ['commandExecution', 'fileChange', 'mcpToolCall', 'sleep', 'contextCompaction'][n % 5], text: '샘플 작업', detail: '작은 출력', status: n === 14 ? 'failed' : 'completed' }));
  const answer = { id: 'a', type: 'agentMessage', text: '첫 진행\n\n```js\nconst sample = 1;\n```' }, progress = { id: 'progress', type: 'agentMessage', text: '두 번째 진행도 접지 않습니다.' };
  f.items([answer, ...tools, video, progress, { id: 'opaque', type: 'function_call_output', text: 'opaque-hidden-noise' }]); await f.poll();
  const groups = find(f.el('messages'), 'details'); assert.equal(groups.length, 1); const group = groups[0]; assert.ok(!group.open); assert.match(group.children[0].textContent, /작업 내역 16개 · 실패 1개/);
  assert.ok(!nodes(f.el('messages')).some(n => n.textContent.includes('opaque-hidden-noise')));
  assert.ok(text(f.el('messages')).includes('두 번째 진행'));
  const roles = nodes(f.el('messages')).filter(n => n.className === 'role'); assert.equal(roles[1].hidden, true);
  const movie = find(f.el('messages'), 'video')[0]; await movie.play(); movie.currentTime = 0.4; const detached = movie.detachCount || 0;
  group.open = true; group.children[0].focus(); f.items([answer, ...tools, video, progress, { id: 'more', type: 'commandExecution', text: '새 작업', status: 'inProgress' }]); await f.poll();
  assert.equal(find(f.el('messages'), 'details')[0], group); assert.equal(group.open, true); assert.equal(f.document.activeElement, group.children[0]); assert.equal(find(f.el('messages'), 'video')[0], movie);
  assert.equal(movie.currentTime, 0.4); assert.equal(movie.detachCount || 0, detached); assert.equal(movie.paused, false);
  const copy = find(f.el('messages'), 'button').find(n => n.textContent === '복사'); copy.focus(); tools[0].detail = '변경된 도구 출력'; await f.poll(); assert.equal(f.document.activeElement, copy);
});
