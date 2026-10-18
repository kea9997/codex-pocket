import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browser, deviceStorage } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';
import { optionsView } from './options-fixture.mjs';
const submit = { preventDefault() {} };
const posts = f => f.calls.filter(c => c.options.method === 'POST');
async function setup(options = {}) {
  const supplied = options.requestHook;
  const f = await browser({ selected: false, ...options, requestHook: async (path, opts) => {
    const r = supplied ? await supplied(path, opts) : null;
    return r || (path === '/api/options' ? { data: optionsView() } : null);
  } });
  await waitFor(() => !f.ui.state.booting && !f.ui.state.creation.checking);
  return f;
}
async function composerOptions(f) { await waitFor(() => !f.ui.state.models.flight); assert.equal(Boolean(f.el('toolsDialog').open), false); }
function choose(f, operation, model, thinking = '') {
  f.el(operation + 'Model').value = model; f.el(operation + 'Model').onchange();
  f.el(operation + 'Thinking').value = thinking; f.el(operation + 'Thinking').onchange();
}
async function newPane(f) { await f.el('newChat').onclick(); await waitFor(() => !f.ui.state.models.flight && !f.ui.state.creation.checking); }

test('new-chat dialog open/select/cancel/Escape/native/browser Back never mutate; draft, scroll and list/chat history remain intact', async () => {
  for (const action of ['close', 'escape', 'native', 'browser']) {
    const f = await setup({ asyncHistory: true }); await f.ui.openThread('fixture');
    f.el('draft').value = '기존 대화 초안'; f.el('history').scrollTop = 33;
    await newPane(f); assert.equal(f.el('newChatDialog').open, true);
    f.el('newPrompt').value = '아직 보내지 않은 새 요청'; f.el('newPrompt').oninput();
    choose(f, 'create', 'fixture-deep', 'ultra'); f.el('newProject').value = 'fixture-project'; f.el('newProject').onchange();
    assert.equal(f.el('createChat').disabled, false); assert.equal(posts(f).length, 0);
    if (action === 'close') f.el('closeNewChat').onclick();
    if (action === 'escape') f.el('newChatDialog').events.get('cancel')(submit);
    if (action === 'native') assert.equal(f.window.codexPhoneBack(), 'handled');
    if (action === 'browser') f.navigation.history.back();
    f.navigation.flush();
    assert.equal(f.el('newChatDialog').open, false); assert.equal(f.document.body.dataset.chat, 'true');
    assert.equal(f.el('draft').value, '기존 대화 초안'); assert.equal(f.el('history').scrollTop, 33); assert.equal(posts(f).length, 0);
    assert.equal(f.document.activeElement, f.el('newChat')); assert.equal(f.navigation.rootExits, 0);
  }
});
test('direct composer changes autosave per-thread without a dialog or POST; incompatible effort resets and delivered choice is one-shot', async () => {
  const f = await setup({ requestHook: (path, opts) => path === '/api/send' ? { data: { ...JSON.parse(opts.body), state: 'delivered' } } : null });
  await f.ui.openThread('fixture'); f.el('draft').value = '유지할 초안'; f.el('history').scrollTop = 29;
  await composerOptions(f); f.el('sendThinking').focus(); choose(f, 'send', 'fixture-fast', 'high');
  assert.equal(posts(f).length, 0); assert.equal(f.ui.state.models.preferences.get('fixture').thinking, 'high');
  assert.equal(f.document.activeElement, f.el('sendThinking')); assert.equal(f.el('draft').value, '유지할 초안'); assert.equal(f.el('history').scrollTop, 29);
  const option = f.el('sendModel').children[1]; f.ui.composerState(); assert.equal(f.el('sendModel').children[1], option);
  f.el('sendModel').value = 'fixture-other'; f.el('sendModel').onchange(); assert.equal(f.el('sendThinking').value, '');
  assert.equal(f.ui.state.models.preferences.get('fixture').model, 'fixture-other'); assert.equal(f.ui.state.models.preferences.get('fixture').thinking, undefined);
  choose(f, 'send', 'fixture-fast', 'high');
  await f.ui.openThread('other'); await composerOptions(f); assert.equal(f.el('sendModel').value, '');
  choose(f, 'send', 'fixture-other', 'medium');
  await f.ui.openThread('fixture'); await composerOptions(f); assert.equal(f.el('sendModel').value, 'fixture-fast'); assert.equal(f.el('sendThinking').value, 'high');
  await f.evaluate(`sendText('명시적 후속')`);
  const input = JSON.parse(posts(f).find(c => c.path === '/api/send').options.body); assert.equal(input.model, 'fixture-fast'); assert.equal(input.thinking, 'high');
  assert.equal(f.ui.state.models.preferences.has('fixture'), false); assert.equal(f.el('sendModel').value, ''); assert.equal(f.el('sendThinking').value, '');
  assert.equal(f.ui.state.models.preferences.get('other').thinking, 'medium');
  await f.evaluate(`sendText('기본값 후속')`); const next = JSON.parse(posts(f).filter(c => c.path === '/api/send').at(-1).options.body); assert.equal('model' in next, false); assert.equal('thinking' in next, false);
  choose(f, 'send', 'fixture-fast', 'high'); choose(f, 'send', ''); assert.equal(f.ui.state.models.preferences.has('fixture'), false); assert.equal(f.el('sendThinking').disabled, true);
});
test('restored choices are bounded strings in auth scope, invalid choices remain explicit and never silently default; logout/late option results cannot repopulate state', async () => {
  const storage = deviceStorage(), first = await setup({ storage }); await first.ui.openThread('fixture'); await composerOptions(first);
  choose(first, 'send', 'fixture-fast', 'high');
  const raw = JSON.parse(storage.getItem('codex-phone-device-v2')); assert.equal(raw.modelChoices[0][1].model, 'fixture-fast'); assert.equal('inputSchema' in raw, false);
  const second = await setup({ storage, requestHook: path => path === '/api/options' ? { data: { ...optionsView(), send: { available: true, state: 'unknown', models: [] } } } : null });
  await waitFor(() => second.ui.state.connected); await composerOptions(second);
  assert.equal(second.el('sendModel').value, 'fixture-fast'); assert.equal(second.el('sendModel').attributes['aria-invalid'], 'true'); assert.match(second.el('sendOptionsStatus').textContent, /자동 대체하지 않았습니다/);
  assert.equal(second.ui.state.models.preferences.get('fixture').thinking, 'high'); assert.equal(posts(second).length, 0);
  choose(second, 'send', ''); assert.equal(second.ui.state.models.preferences.has('fixture'), false); assert.equal(second.el('sendModel').attributes['aria-invalid'], 'false');
  const foreign = await setup({ storage, scope: 'b'.repeat(64) }); assert.equal(foreign.ui.state.models.preferences.size, 0);
  let release; const late = await setup({ requestHook: async path => { if (path === '/api/options') { await new Promise(r => { release = r; }); return { data: optionsView() }; } } });
  late.el('newChat').onclick(); await waitFor(() => release); late.ui.showPair(); release();
  await new Promise(r => setTimeout(r, 0)); assert.equal(late.ui.state.models.result, null); assert.equal(late.el('newChatDialog').open, false); assert.equal(late.ui.state.models.preferences.size, 0); assert.equal(late.el('newPrompt').value, '');
});
test('options failure keeps default continuation available, creation disabled with recovery and loading single-flight causes no mutations', async () => {
  const f = await setup({ requestHook: path => path === '/api/options' ? { status: 503, data: { error: 'OPTIONS_UNAVAILABLE' } } : null });
  await f.ui.openThread('fixture'); f.el('draft').value = '초안'; f.el('draft').oninput(); await composerOptions(f); assert.equal(f.el('sendModel').disabled, false); assert.match(f.el('sendOptionsStatus').textContent, /선택지 확인 불가/);
  assert.equal(f.el('send').disabled, false);
  await newPane(f); f.el('newPrompt').value = '첫 요청'; f.el('newPrompt').oninput(); assert.equal(f.el('createChat').disabled, true); assert.equal(posts(f).length, 0);
  let release; f.hook(async path => { if (path === '/api/options') { await new Promise(r => { release = r; }); return { data: optionsView() }; } });
  const one = f.el('refreshNewOptions').onclick(), two = f.el('refreshNewOptions').onclick(); await waitFor(() => release); release(); await Promise.all([one, two]); assert.equal(f.el('createChat').disabled, false); assert.equal(posts(f).length, 0);
});
test('composer options retry is GET-only and singleflight; stale choices never leak across chats or silently become defaults', async () => {
  const f = await setup(); await f.ui.openThread('fixture'); await composerOptions(f); choose(f, 'send', 'fixture-fast', 'high');
  let release;
  f.hook(async path => { if (path === '/api/options') { await new Promise(done => { release = done; }); return { status: 503, data: { error: 'OPTIONS_UNAVAILABLE' } }; } });
  const before = f.calls.length, first = f.el('refreshOptions').onclick(), second = f.el('refreshOptions').onclick(); await waitFor(() => release);
  assert.equal(f.el('sendModel').disabled, true); assert.equal(f.el('sendThinking').disabled, true);
  f.el('sendModel').value = ''; f.el('sendModel').onchange(); assert.equal(f.ui.state.models.preferences.get('fixture').thinking, 'high');
  await f.ui.openThread('other'); assert.equal(f.el('sendModel').value, '');
  release(); await Promise.all([first, second]);
  assert.equal(f.calls.slice(before).filter(c => c.path === '/api/options').length, 1); assert.equal(f.el('sendModel').value, '');
  f.hook(path => path === '/api/options' ? { status: 503, data: { error: 'OPTIONS_UNAVAILABLE' } } : null);
  await f.ui.openThread('fixture'); await composerOptions(f); assert.equal(f.el('sendModel').value, 'fixture-fast'); assert.equal(f.el('sendThinking').value, 'high');
  assert.equal(f.el('sendModel').attributes['aria-invalid'], 'true'); assert.equal(f.el('refreshOptions').hidden, false);
  f.hook(path => path === '/api/options' ? { data: optionsView() } : null);
  const retryAt = f.calls.length; await f.el('refreshOptions').onclick();
  assert.deepEqual(f.calls.slice(retryAt).map(c => c.path), ['/api/options']); assert.equal(f.el('sendOptionsStatus').hidden, true); assert.equal(f.el('sendThinking').value, 'high');
  f.el('sendModel').value = 'fixture-deep'; f.el('sendModel').onchange(); assert.equal(f.el('sendModel').value, 'fixture-fast');
  f.el('sendThinking').value = 'ultra'; f.el('sendThinking').onchange(); assert.equal(f.el('sendThinking').value, 'high');
  assert.equal(posts(f).length, 0);
});
test('direct selectors gate auth, missing chat, offline, receipt recovery and pending state without changing stored choice or history', async () => {
  const f = await setup(); f.ui.composerState(); assert.equal(f.el('sendModel').disabled, true); await f.ui.openThread('fixture'); await composerOptions(f);
  choose(f, 'send', 'fixture-fast', 'high');
  const guard = (lock, unlock) => {
    lock(); f.ui.composerState(); const before = f.calls.length;
    for (const id of ['sendModel', 'sendThinking', 'refreshOptions']) assert.equal(f.el(id).disabled, true, id);
    f.el('sendModel').value = ''; f.el('sendModel').onchange(); assert.equal(f.el('sendModel').value, 'fixture-fast');
    assert.equal(f.ui.state.models.preferences.get('fixture').thinking, 'high'); assert.equal(f.calls.length, before);
    unlock(); f.ui.composerState(); assert.equal(f.el('sendModel').disabled, false); assert.equal(f.el('sendThinking').disabled, false);
  };
  guard(() => f.offline(true), () => f.offline(false));
  guard(() => { f.ui.state.recovery.gated = true; }, () => { f.ui.state.recovery.gated = false; });
  guard(() => { f.ui.state.recovery.suspended = true; }, () => { f.ui.state.recovery.suspended = false; });
  guard(() => { f.ui.state.pending = { requestId: 'other', threadId: 'other' }; }, () => { f.ui.state.pending = null; });
  guard(() => { f.ui.state.serverSending = true; }, () => { f.ui.state.serverSending = false; });
  f.ui.showPair(); assert.equal(f.el('sendModel').disabled, true); assert.equal(f.el('sendThinking').disabled, true); assert.equal(f.el('refreshOptions').disabled, true); assert.equal(f.ui.state.models.preferences.size, 0);
  assert.equal(posts(f).length, 0);
});
test('model rejection exposes options-only retry, preserves the exact pair and only deliberate default selection clears it', async () => {
  const f = await setup({ requestHook: path => path === '/api/send' ? { status: 409, data: { error: 'MODEL_CHOICE_UNAVAILABLE' } } : null });
  await f.ui.openThread('fixture'); await composerOptions(f); choose(f, 'send', 'fixture-fast', 'high');
  await f.evaluate(`sendText('명시적 전송')`); assert.equal(f.el('sendOptionsFeedback').hidden, false); assert.equal(f.el('refreshOptions').hidden, false);
  const before = f.calls.length; await f.el('refreshOptions').onclick(); assert.deepEqual(f.calls.slice(before).map(c => c.path), ['/api/options']);
  assert.equal(f.ui.state.models.preferences.get('fixture').thinking, 'high'); assert.equal(f.el('sendOptionsFeedback').hidden, true);
  choose(f, 'send', ''); assert.equal(f.ui.state.models.preferences.has('fixture'), false); assert.equal(posts(f).length, 1);
});
test('only explicit create submits defaults or selected local target/settings once; verified creation auto-opens only while intended dialog remains open', async () => {
  for (const selected of [false, true]) {
    let release;
    const f = await setup({ asyncHistory: true, requestHook: async (path, opts) => {
      if (path === '/api/create') { await new Promise(r => { release = r; }); return { data: { kind: 'create', requestId: JSON.parse(opts.body).requestId, threadId: 'created-fixture', state: 'delivered' } }; }
    } });
    await newPane(f); f.el('newPrompt').value = '명시적 첫 요청'; f.el('newPrompt').oninput();
    if (selected) { choose(f, 'create', 'fixture-deep', 'ultra'); f.el('newProject').value = 'fixture-project'; f.el('newProject').onchange(); }
    const flight = f.el('newChatForm').onsubmit(submit); await waitFor(() => release);
    await f.el('newChatForm').onsubmit(submit); assert.equal(posts(f).filter(c => c.path === '/api/create').length, 1);
    const input = JSON.parse(posts(f).find(c => c.path === '/api/create').options.body);
    assert.equal(input.text, '명시적 첫 요청'); assert.equal(f.el('newPrompt').disabled, true);
    if (selected) { assert.equal(input.model, 'fixture-deep'); assert.equal(input.thinking, 'ultra'); assert.equal(input.target.projectId, 'fixture-project'); }
    else { assert.equal('model' in input, false); assert.equal('thinking' in input, false); assert.equal(input.target.type, 'projectless'); }
    release(); await flight; f.navigation.flush(); await waitFor(() => f.ui.state.selected === 'created-fixture' && !f.ui.state.restoring);
    assert.equal(f.el('newPrompt').value, ''); assert.ok(!posts(f).some(c => c.path === '/api/send')); assert.equal(f.ui.state.creation.receipt.state, 'delivered');
  }
});
test('pending/uncertain creation survives reload with ID only; PC-check acknowledgement never creates; late success after Back/logout never opens or leaks', async () => {
  const storage = deviceStorage(); let receipt;
  const hook = (path, opts) => {
    if (path === '/api/create') { receipt = { kind: 'create', requestId: JSON.parse(opts.body).requestId, state: 'pending', threadId: null }; return { data: receipt }; }
    if (path === '/api/create/state') return { data: { request: receipt || null } };
    if (path.endsWith('/acknowledge')) return { data: { ...receipt, state: 'acknowledged' } };
  };
  const first = await setup({ storage, requestHook: hook }); await newPane(first); first.el('newPrompt').value = '저장하지 않을 첫 요청'; first.el('newPrompt').oninput(); await first.el('newChatForm').onsubmit(submit);
  assert.equal(first.el('creationRecovery').hidden, false); assert.equal(first.el('createChat').disabled, true); assert.equal(first.ui.state.selected, null);
  const raw = storage.getItem('codex-phone-device-v2'); assert.ok(!raw.includes('저장하지 않을')); assert.ok(raw.includes(receipt.requestId));
  const second = await setup({ storage, requestHook: hook }); await newPane(second); assert.equal(second.ui.state.creation.receipt.state, 'pending'); assert.equal(posts(second).length, 0);
  await second.el('acknowledgeCreation').onclick(); assert.equal(posts(second).length, 1); assert.ok(posts(second)[0].path.endsWith('/acknowledge')); assert.equal(second.ui.state.creation.receipt.state, 'acknowledged');
  for (const action of ['back', 'logout']) {
    let release; const f = await setup({ asyncHistory: true, requestHook: async (path, opts) => {
      if (path === '/api/create') { await new Promise(r => { release = r; }); return { data: { kind: 'create', requestId: JSON.parse(opts.body).requestId, threadId: 'created-fixture', state: 'delivered' } }; }
    } });
    await newPane(f); f.el('newPrompt').value = '첫 요청'; f.el('newPrompt').oninput(); const flight = f.el('newChatForm').onsubmit(submit); await waitFor(() => release);
    if (action === 'back') { assert.equal(f.window.codexPhoneBack(), 'handled'); f.navigation.flush(); } else f.ui.showPair();
    release(); await flight; assert.equal(f.ui.state.selected, null); assert.equal(f.el('newChatDialog').open, false); assert.equal(f.document.body.dataset.chat, 'false');
    if (action === 'logout') { assert.equal(f.ui.state.creation.receipt, null); assert.equal(f.el('newPrompt').value, ''); }
    else assert.equal(f.ui.state.creation.receipt.state, 'delivered');
  }
});
test('creation network uncertainty restores only UUID, never replays, and missing server receipt unlock requires explicit PC confirmation without a mutation', async () => {
  const storage = deviceStorage(), f = await setup({ storage, requestHook: path => path === '/api/create' ? { status: 503, data: { error: 'CREATE_UNCERTAIN' } } : null });
  await newPane(f); f.el('newPrompt').value = '재생성 금지 · 비공개 첫 요청'; f.el('newPrompt').oninput(); await f.el('newChatForm').onsubmit(submit);
  assert.equal(f.ui.state.creation.receipt.state, 'uncertain'); assert.equal(f.el('createChat').disabled, true); assert.equal(posts(f).length, 1);
  const restored = await setup({ storage, requestHook: path => path.startsWith('/api/requests/') ? { status: 404, data: { error: 'REQUEST_NOT_FOUND' } } : null });
  await newPane(restored); assert.equal(restored.ui.state.creation.missing, true); assert.equal(restored.el('newPrompt').value, ''); assert.equal(posts(restored).length, 0);
  assert.equal(restored.el('creationRecovery').hidden, false); await restored.el('acknowledgeCreation').onclick();
  assert.equal(restored.ui.state.creation.receipt.state, 'acknowledged'); assert.equal(posts(restored).length, 0); assert.equal(restored.ui.state.selected, null);
});
test('rejected/uncertain optional send retains choice and composer; explicit question answer uses one-shot selection without clearing normal draft', async () => {
  const f = await setup({ requestHook: path => path === '/api/send' ? { status: 409, data: { error: 'MODEL_CHOICE_UNAVAILABLE' } } : null });
  await f.ui.openThread('fixture'); f.el('draft').value = '보존할 일반 초안'; f.el('draft').oninput(); await composerOptions(f); choose(f, 'send', 'fixture-fast', 'high');
  await f.evaluate(`sendText('지원 중단된 선택')`); assert.equal(f.ui.state.models.preferences.get('fixture').thinking, 'high'); assert.equal(f.el('draft').value, '보존할 일반 초안');
  f.hook((path, opts) => path === '/api/send' ? { data: { ...JSON.parse(opts.body), state: 'uncertain' } } : path.startsWith('/api/requests/') ? { data: { requestId: f.ui.state.pending.requestId, threadId: 'fixture', state: 'uncertain' } } : null);
  await f.evaluate(`sendText('불명 결과')`); assert.equal(f.ui.state.models.preferences.get('fixture').model, 'fixture-fast'); assert.equal(f.ui.state.pending.selection.thinking, 'high'); assert.equal(f.el('draft').value, '보존할 일반 초안');
  await f.evaluate(`settlePending({ requestId:state.pending.requestId,threadId:'fixture',state:'acknowledged' }); clearError();`);
  f.hook((path, opts) => path === '/api/send' ? { data: { ...JSON.parse(opts.body), state: 'delivered' } } : null);
  await f.evaluate(`sendText('질문 답변 메시지','fixture-question')`); assert.equal(f.ui.state.models.preferences.size, 0); assert.equal(f.el('draft').value, '보존할 일반 초안');
  const input = JSON.parse(posts(f).filter(c => c.path === '/api/send').at(-1).options.body); assert.equal(input.model, 'fixture-fast'); assert.equal(input.thinking, 'high'); assert.equal(f.ui.state.questionReceipts.get('fixture/fixture-question'), true);
});
test('late send after authentication replacement cannot consume new preferences, pending state, draft or sending lock', async () => {
  let release;
  const f = await setup({ requestHook: async (path, opts) => { if (path === '/api/send') { await new Promise(r => { release = r; }); return { data: { ...JSON.parse(opts.body), state: 'delivered' } }; } } });
  await f.ui.openThread('fixture'); await composerOptions(f); choose(f, 'send', 'fixture-fast', 'high');
  const flight = f.evaluate(`sendText('이전 인증의 명시적 요청')`); await waitFor(() => release); f.ui.showPair(); await f.ui.boot(); await f.ui.openThread('other');
  f.el('draft').value = '새 인증 초안'; f.ui.state.models.preferences.set('other', { model: 'fixture-other' });
  const pending = { requestId: 'new-auth-request', threadId: 'other' }; f.ui.state.pending = pending; f.ui.state.sending = true;
  release(); await flight; assert.equal(f.ui.state.pending, pending); assert.equal(f.ui.state.sending, true); assert.equal(f.el('draft').value, '새 인증 초안'); assert.equal(f.ui.state.models.preferences.get('other').model, 'fixture-other');
});
test('late receipt checks cannot show old uncertainty or consume a new authentication scope choice', async () => {
  for (const outcome of ['delivered', 'uncertain', 'missing']) {
    let release; const f = await setup({ requestHook: async path => {
      if (path === '/api/requests/old-request') { await new Promise(r => { release = r; }); return outcome === 'missing' ? { status: 404, data: { error: 'REQUEST_NOT_FOUND' } } : { data: { requestId: 'old-request', threadId: 'fixture', state: outcome } }; }
    } });
    f.ui.state.pending = { requestId: 'old-request', threadId: 'fixture' };
    const flight = f.evaluate('checkPending()'); await waitFor(() => release); f.ui.showPair(); await f.ui.boot();
    const pending = { requestId: 'new-request', threadId: 'other' }; f.ui.state.pending = pending; f.ui.state.models.preferences.set('other', { model: 'fixture-other' });
    release(); await flight; assert.equal(f.ui.state.pending, pending); assert.equal(f.ui.state.errorCode, null); assert.equal(f.ui.state.models.preferences.get('other').model, 'fixture-other');
  }
});
test('normal ready creation/model panes hide source prose, duplicate idle copy and requestless recovery actions without changing explicit submit semantics', async () => {
  const f = await setup(); await newPane(f);
  for (const id of ['createOptionsStatus', 'projectOptionsStatus', 'creationStatus', 'checkCreation', 'creationRecovery', 'openCreated']) assert.equal(f.el(id).hidden, true, id);
  assert.equal(f.el('createOptionsStatus').textContent, ''); assert.equal(f.el('creationStatus').textContent, ''); assert.equal(f.el('refreshNewOptions').hidden, false);
  f.el('newPrompt').value = '명시적 제출 전 첫 요청'; f.el('newPrompt').oninput(); choose(f, 'create', 'fixture-deep', 'ultra');
  assert.equal(f.el('createChat').disabled, false); assert.equal(f.el('createOptionsStatus').hidden, true); assert.equal(posts(f).length, 0);
  f.el('closeNewChat').onclick(); await f.ui.openThread('fixture'); await composerOptions(f);
  assert.equal(f.el('sendOptionsStatus').hidden, true); choose(f, 'send', 'fixture-fast', 'high');  assert.equal(f.ui.state.models.preferences.get('fixture').thinking, 'high'); assert.match(f.el('sendThinking').title, /다음 메시지.*직접 보내기/); assert.equal(f.el('sendOptionsStatus').hidden, true); assert.equal(posts(f).length, 0);
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /첫 요청을 PC Codex에 보냅니다/); assert.ok(!html.includes('폴더·권한·계정은 변경하지 않습니다'));
  assert.ok(!html.includes('만들고 보내기를 누르기 전에는 생성·전송하지 않습니다'));
});
test('compact creation pane retains loading, unavailable, unknown-model and invalid-project explanations and truthful disabled controls', async () => {
  let release; const f = await setup({ requestHook: async path => { if (path === '/api/options') { await new Promise(r => { release = r; }); return { data: optionsView() }; } } });
  await f.el('newChat').onclick(); await waitFor(() => release);
  assert.equal(f.el('createOptionsStatus').hidden, false); assert.match(f.el('createOptionsStatus').textContent, /확인하고 있습니다/);
  assert.equal(f.el('projectOptionsStatus').hidden, false); assert.match(f.el('projectOptionsStatus').textContent, /확인 중/);
  const flight = f.ui.state.models.flight; release(); await flight;
  assert.equal(f.el('createOptionsStatus').hidden, true); assert.equal(f.el('projectOptionsStatus').hidden, true);
  let options = { ...optionsView(), projects: { state: 'unavailable', items: [] } };
  f.hook(path => path === '/api/options' ? { data: options } : null); await f.el('refreshNewOptions').onclick();
  f.el('newPrompt').value = '프로젝트 없이 가능한 요청'; f.el('newPrompt').oninput();
  assert.equal(f.el('projectOptionsStatus').hidden, false); assert.match(f.el('projectOptionsStatus').textContent, /목록 확인 불가/); assert.equal(f.el('createChat').disabled, false);
  f.el('newProject').value = 'fixture-project'; f.el('newProject').onchange(); assert.equal(f.el('createChat').disabled, true); assert.match(f.el('projectOptionsStatus').textContent, /자동으로.*바꾸지 않습니다/);
  f.el('newProject').value = ''; f.el('newProject').onchange(); options = { ...optionsView(), create: { available: true, state: 'unknown', models: [] } }; await f.el('refreshNewOptions').onclick();
  assert.equal(f.el('createOptionsStatus').hidden, false); assert.match(f.el('createOptionsStatus').textContent, /목록 미제공/); assert.equal(f.el('createChat').disabled, false);
  options = { ...optionsView(), create: { available: false, state: 'unavailable', models: [] } }; await f.el('refreshNewOptions').onclick();
  assert.equal(f.el('createOptionsStatus').hidden, false); assert.match(f.el('createOptionsStatus').textContent, /새 대화 기능을 확인할 수 없습니다/); assert.equal(f.el('createChat').disabled, true); assert.equal(posts(f).length, 0);
});
test('requestless state-check errors stay recoverable; actual reserved/pending receipts retain controls, and disappearing check actions restore usable focus without opening a chat', async () => {
  const f = await setup({ requestHook: path => path === '/api/create/state' ? { status: 503, data: { error: 'NETWORK' } } : null }); await newPane(f);
  assert.equal(f.el('creationStatus').hidden, false); assert.equal(f.el('checkCreation').hidden, false); assert.equal(f.el('checkCreation').disabled, false); assert.equal(f.el('createChat').disabled, true); assert.equal(f.el('creationRecovery').hidden, true);
  f.hook(path => path === '/api/create/state' ? { data: { request: null } } : null);
  f.el('checkCreation').focus(); await f.el('checkCreation').onclick();
  assert.equal(f.el('creationStatus').hidden, true); assert.equal(f.el('checkCreation').hidden, true); assert.equal(f.document.activeElement, f.el('newPrompt'));
  const requestId = '11111111-1111-4111-8111-111111111111'; f.ui.state.creation.receipt = { kind: 'create', requestId, state: 'reserved', threadId: null }; f.evaluate('creationState()');
  assert.equal(f.el('checkCreation').hidden, false); assert.equal(f.el('creationRecovery').hidden, true); assert.equal(f.el('createChat').disabled, true); assert.equal(f.el('creationStatus').hidden, false);
  f.ui.state.creation.receipt.state = 'pending'; f.evaluate('creationState()');
  assert.equal(f.el('creationRecovery').hidden, false); assert.match(f.el('creationStatus').textContent, /대화 준비 응답을 받았습니다/); assert.equal(f.el('openCreated').hidden, true);
  f.hook(path => path === '/api/create/state' ? { data: { request: null } } : path === '/api/requests/' + requestId ? { data: { kind: 'create', requestId, state: 'delivered', threadId: 'created-fixture' } } : null);
  f.el('checkCreation').focus(); await f.el('checkCreation').onclick();
  assert.equal(f.el('checkCreation').hidden, true); assert.equal(f.el('creationRecovery').hidden, true); assert.equal(f.el('openCreated').hidden, false); assert.equal(f.document.activeElement, f.el('openCreated'));
  assert.equal(f.ui.state.selected, null); assert.equal(posts(f).length, 0);
});
test('model/create UI ships labelled native selects, compact 44px controls and bounded scrolling dialogs without exposing current PC settings or permission/provider controls', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  for (const id of ['sendModel', 'sendThinking', 'createModel', 'createThinking', 'newProject', 'newPrompt']) assert.ok(html.includes(`for="${id}"`));
  const composer = html.slice(html.indexOf('<form id="composer"'), html.indexOf('<dialog id="toolsDialog"'));
  for (const id of ['sendModel', 'sendThinking']) assert.ok(composer.includes(`id="${id}"`));
  for (const id of ['nextModel', 'toolModel', 'modelPane', 'modelForm', 'saveModel', 'clearModel']) assert.ok(!html.includes(`id="${id}"`));
  assert.match(css, /\.model-settings select\{[^}]*min-height:44px/); assert.match(css, /\.list-caption>div\{display:flex;flex-wrap:wrap/);
  assert.match(css, /\.tools-dialog\{[^}]*max-height:calc\(var\(--app-height,100dvh\) - 20px\);overflow:auto/);
  assert.ok(!html.includes('현재 모델 변경 완료')); assert.ok(!html.includes('id="provider"')); assert.ok(!html.includes('id="permissions"'));
  // VM/contract tests do not establish real 320/390px browser or Fold6 layout.
});
