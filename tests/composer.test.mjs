import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

// This exercises the shipped script with controlled dimensions, not a browser layout/keyboard claim.
test('normal composer has no footer hints; same-chat labels and actionable pending/uncertain/offline guards remain', async () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const text of ['작업 중인 같은 대화에 추가 지시합니다.', '이 대화의 모델과 작업 설정을 그대로 사용합니다.', 'composer-note', 'composer-bottom']) assert.ok(!html.includes(text));
  assert.match(html, /id="draft" rows="1"/);
  const f = await browser();
  for (const status of ['idle', 'active']) {
    f.ui.state.status = status; f.ui.composerState();
    assert.equal(f.el('composerFeedback').hidden, true); assert.equal(f.el('composerStatus').textContent, '');
    assert.equal(f.el('send').textContent, '↑'); assert.equal(f.el('send').disabled, false);
    assert.match(f.el('send').attributes['aria-label'], status === 'active' ? /추가 지시/ : /보내기/);
  }
  const draft = f.el('draft').value;
  f.ui.state.serverSending = true; f.ui.composerState(); assert.equal(f.el('send').disabled, true);
  assert.equal(f.el('composerFeedback').hidden, false); assert.match(f.el('composerStatus').textContent, /다른 전송/);
  f.ui.state.serverSending = false; f.ui.state.pending = { threadId: 'fixture', requestId: 'own' }; f.ui.composerState();
  assert.equal(f.el('send').disabled, true); assert.equal(f.el('draft').disabled, true); assert.equal(f.el('checkSend').hidden, false);
  assert.equal(f.el('composerFeedback').hidden, false); assert.match(f.el('composerStatus').textContent, /중복 전송 방지/);
  f.ui.state.pending = { threadId: 'other', requestId: 'other' }; f.ui.composerState();
  assert.equal(f.el('send').disabled, true); assert.match(f.el('composerStatus').textContent, /다른 대화/);
  f.ui.state.pending = null; f.ui.state.capability.uncertain = true; f.ui.state.recoverRequest = 'own'; f.ui.composerState();
  assert.equal(f.el('send').disabled, true); assert.equal(f.el('sendRecovery').hidden, false); assert.match(f.el('composerStatus').textContent, /전송 불명/);
  f.ui.state.capability.uncertain = false; f.ui.state.connected = false; f.ui.composerState();
  assert.equal(f.el('send').disabled, true); assert.equal(f.el('draft').disabled, false); assert.match(f.el('composerStatus').textContent, /초안은 유지/);
  assert.equal(f.el('draft').value, draft);
});
test('textarea grows from one line to bounded Korean multiline, shrinks and resizes; unchanged polls never reset its layout', async () => {
  const f = await browser(), draft = f.el('draft'); let height = '', assignments = 0;
  f.window.innerHeight = 800; draft.clientWidth = 240;
  Object.defineProperty(draft.style, 'height', { get: () => height, set: value => { height = value; assignments++; } });
  Object.defineProperty(draft, 'scrollHeight', { get: () => draft.value.length > 30 ? 310 : 44 });
  draft.value = ''; draft.oninput(); assert.equal(height, '44px'); assert.equal(draft.style.overflowY, 'hidden'); assert.equal(f.el('send').disabled, true);
  draft.value = '한글 여러 줄\n'.repeat(40); draft.oninput(); assert.equal(height, '144px'); assert.equal(draft.style.overflowY, 'auto');
  const before = assignments; f.ui.composerState(); await f.ui.refreshCurrent(); assert.equal(assignments, before);
  assert.equal(draft.value, '한글 여러 줄\n'.repeat(40));
  f.window.visualViewport = { height: 420 }; f.windowEvents.get('resize')(); assert.equal(height, '44px'); // Short viewports keep one visible line, with internal textarea scrolling.
  draft.clientWidth = 180; const previous = assignments; f.windowEvents.get('resize')(); assert.ok(assignments > previous);
  draft.value = '짧게'; draft.oninput(); assert.equal(height, '44px'); assert.equal(draft.style.overflowY, 'hidden');
});
test('compact send retains exact selected ID/payload and single pending request guard; delivered returns to quiet composer', async () => {
  const f = await browser(); let resolveSend;
  f.hook(path => path === '/api/send' ? new Promise(resolve => { resolveSend = resolve; }) : null);
  f.el('draft').value = '동일 대화에 보낼 샘플 지시'; f.el('draft').oninput();
  const submit = f.el('composer').onsubmit({ preventDefault() {} }); await waitFor(() => resolveSend);
  assert.equal(f.el('send').disabled, true); assert.equal(f.el('send').attributes['aria-label'], '전송 중');
  assert.equal(f.el('composerFeedback').hidden, false); assert.match(f.el('composerStatus').textContent, /확인 중/);
  await f.el('composer').onsubmit({ preventDefault() {} });
  const calls = f.calls.filter(c => c.path === '/api/send'); assert.equal(calls.length, 1);
  const input = JSON.parse(calls[0].options.body); assert.equal(input.threadId, 'fixture'); assert.equal(input.text, '동일 대화에 보낼 샘플 지시');
  assert.deepEqual(Object.keys(input).sort(), ['requestId', 'text', 'threadId']);
  resolveSend({ data: { requestId: input.requestId, threadId: input.threadId, state: 'delivered' } }); await submit;
  assert.equal(f.el('draft').value, ''); assert.equal(f.ui.state.pending, null); assert.equal(f.el('composerFeedback').hidden, true);
});
test('rotation clamps stale portrait visual height, coalesces one reflow and preserves draft, focus, uploads, notice and model choice without I/O', async () => {
  const listeners = new Map(), visualViewport = { height: 844, addEventListener(name, fn) { listeners.set(name, fn); } };
  const f = await browser({ visualViewport, innerHeight: 844 }); await waitFor(() => !f.ui.state.booting && !f.ui.state.creation.checking);
  const properties = new Map(); f.document.documentElement.style.setProperty = (name, value) => properties.set(name, value);
  const draft = f.el('draft'); draft.clientWidth = 240; draft.value = '회전해도 유지할 긴 한글 초안\n'.repeat(40); draft.scrollHeight = 310; draft.oninput(); draft.focus(); draft.setSelectionRange(3, 9);
  f.el('attachFiles').click(); const picker = f.el('attachmentPicker'); picker.files = [new File(['a'], '사진.png'), new File(['b'], '문서.txt')]; picker.onchange();
  f.ui.state.models.preferences.set('fixture', { model: 'fixture-model', thinking: 'high' }); f.ui.composerState();
  f.ui.state.notifications.set('other', { id: 'other', title: '다른 대화', text: '여러 줄 새 응답 알림 '.repeat(20), version: 'new', at: 10 }); f.evaluate('renderNotice()');
  const text = draft.value, model = [f.el('sendModel').value, f.el('sendThinking').value], notice = f.el('noticeSnippet').textContent, uploads = f.evaluate('attachments.rows("fixture")');
  f.el('history').scrollTop = 123; const calls = f.calls.length;
  f.window.innerHeight = 352; f.windowEvents.get('resize')(); f.windowEvents.get('resize')();
  assert.equal(properties.get('--app-height'), '352px'); assert.equal(f.document.documentElement.dataset.compactViewport, 'true'); assert.equal(draft.style.height, '44px'); assert.equal(draft.style.overflowY, 'auto'); assert.equal(f.frames.size, 1);
  visualViewport.height = 340; f.frame(16); assert.equal(properties.get('--app-height'), '340px'); assert.equal(f.frames.size, 0);
  assert.equal(draft.value, text); assert.equal(f.document.activeElement, draft); assert.equal(draft.selectionStart, 3); assert.equal(draft.selectionEnd, 9); assert.equal(f.el('history').scrollTop, 123);
  assert.equal(f.evaluate('attachments.rows("fixture")'), uploads); assert.equal(f.uploads.length, 2); assert.ok(f.uploads.every(xhr => !xhr.aborted)); assert.deepEqual([f.el('sendModel').value, f.el('sendThinking').value], model); assert.equal(f.el('noticeSnippet').textContent, notice); assert.equal(f.el('activityNotice').hidden, false); assert.equal(f.calls.length, calls);
  f.window.innerHeight = 844; visualViewport.height = 844; listeners.get('resize')(); f.frame(16);
  assert.equal(properties.get('--app-height'), '844px'); assert.equal(f.document.documentElement.dataset.compactViewport, 'false'); assert.equal(draft.style.height, '144px'); assert.equal(f.calls.length, calls);
});
test('keyboard-only visual resize toggles compact mode, ignores invalid dimensions, and rechecks resumed viewport without frame leaks or POST replay', async () => {
  const listeners = new Map(), visualViewport = { height: 844, addEventListener(name, fn) { listeners.set(name, fn); } };
  const f = await browser({ visualViewport, innerHeight: 844 }); await waitFor(() => !f.ui.state.booting && !f.ui.state.creation.checking);
  const properties = new Map(); f.document.documentElement.style.setProperty = (name, value) => properties.set(name, value);
  visualViewport.height = 260; listeners.get('resize')(); assert.equal(properties.get('--app-height'), '260px'); assert.equal(f.document.documentElement.dataset.compactViewport, 'true'); assert.equal(f.frames.size, 1);
  for (const value of [0, -1, NaN, Infinity]) { visualViewport.height = value; listeners.get('resize')(); assert.equal(properties.get('--app-height'), '844px'); assert.equal(f.frames.size, 1); }
  f.window.innerHeight = 0; visualViewport.height = 0; listeners.get('resize')(); assert.equal(properties.get('--app-height'), '640px');
  f.windowEvents.get('pagehide')(); assert.equal(f.frames.size, 0);
  f.window.innerHeight = 844; visualViewport.height = 420; const posts = f.calls.filter(c => c.options.method === 'POST').length; await f.windowEvents.get('pageshow')();
  assert.equal(properties.get('--app-height'), '420px'); assert.equal(f.document.documentElement.dataset.compactViewport, 'true'); assert.equal(f.frames.size, 0); assert.equal(f.calls.filter(c => c.options.method === 'POST').length, posts);
  visualViewport.height = 844; listeners.get('resize')(); f.frame(16); assert.equal(f.document.documentElement.dataset.compactViewport, 'false'); assert.equal(f.frames.size, 0);
});
