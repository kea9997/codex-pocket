import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

const nodes = root => [root, ...(root.children || []).flatMap(child => typeof child === 'object' ? nodes(child) : [])];
const text = root => typeof root === 'string' ? root : (root.textContent || '') + (root.children || []).map(text).join('');
const find = (root, tag) => nodes(root).filter(n => n.tagName === tag.toUpperCase());
async function setup() {
  const f = await browser({ selected: false });
  const movie = { state: 'ready', kind: 'video', url: '/api/media/' + 'v'.repeat(43), alt: '생성 영상' };
  let items = [{ id: 'user', type: 'userMessage', text: '나의 문자 그대로 .* [한글] <b>안전</b>' },
    { id: 'assistant', type: 'agentMessage', text: '## 표시 본문\n\n문자 그대로 .* 확인\n\n```js\nconst sample = "한글";\n```' },
    { id: 'notice', type: 'requestNotice', text: '원문이 생략된 요청 안내' },
    { id: 'private-tool', type: 'mcpToolCall', text: 'tool-private-needle', detail: 'hidden-args' },
    { id: 'reasoning', type: 'reasoning', text: 'reasoning-private-needle' },
    { id: 'video', type: 'imageView', media: movie },
    { id: 'image', type: 'imageView', media: { state: 'ready', url: '/api/media/' + 'i'.repeat(43), alt: '생성 사진' } },
    { id: 'file', type: 'agentMessage', text: '생성 결과', files: [{ file: { state: 'ready', url: '/api/files/' + 'f'.repeat(43), name: '생성 결과.pdf' } }] }];
  f.hook(path => path.endsWith('/history') ? { data: { data: [{ id: 'current', status: 'inProgress', items }], nextCursor: null, status: 'active' } } : path.endsWith('/questions') ? { data: { state: 'ready', data: [] } } : null);
  await f.ui.openThread('fixture'); f.el('draft').value = '기존 초안'; f.el('draft').oninput();
  return { ...f, items: value => { items = value; }, currentItems: () => items };
}
test('quick instructions append exact Korean text without overwriting, sending, changing selection scope or bypassing pending locks/length limits', async () => {
  const f = await setup();
  for (const [id, instruction] of [['quickContinue', '계속 진행해줘'], ['quickStatus', '현재 작업 상황을 알려줘'], ['quickError', '오류 원인부터 확인하고 해결해줘']]) {
    const old = f.el('draft').value; f.el('chatTools').onclick(); assert.equal(f.el('toolsDialog').open, true); f.el(id).onclick();
    assert.equal(f.el('toolsDialog').open, false); assert.equal(f.el('draft').value, old + '\n\n' + instruction); assert.equal(f.document.activeElement, f.el('draft'));
    assert.equal(f.ui.durable.data.drafts.find(([id]) => id === 'fixture')[1], f.el('draft').value);
  }
  const old = f.el('draft').value;
  for (const lock of [() => { f.ui.state.pending = { threadId: 'other', requestId: 'pending' }; }, () => { f.ui.state.pending = null; f.ui.state.capability.uncertain = true; }, () => { f.ui.state.capability.uncertain = false; f.ui.state.serverSending = true; }]) {
    lock(); f.ui.composerState(); f.el('quickContinue').onclick(); assert.equal(f.el('quickContinue').disabled, true); assert.equal(f.el('draft').value, old);
  }
  f.ui.state.serverSending = false; f.el('draft').value = '가'.repeat(16000); f.ui.composerState(); f.el('quickContinue').onclick();
  assert.equal(f.el('draft').value.length, 16000); assert.match(f.el('quickFeedback').textContent, /추가하지 않았/);
  assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('literal loaded visible message search excludes tool/reasoning/other thread and does not alter reading position, draft, video, focus or persistence on polls', async () => {
  const f = await setup(), movie = find(f.el('messages'), 'video')[0]; await movie.play(); movie.currentTime = .4;
  f.el('chatTools').onclick(); f.el('toolSearch').onclick(); f.el('messageSearch').value = '.*'; f.el('messageSearch').oninput(); f.el('messageSearch').focus();
  assert.equal(f.ui.state.tools.matches.length, 2); const buttons = [...f.el('messageSearchResults').children], scroll = f.el('history').scrollTop, detached = movie.detachCount || 0;
  f.items([...f.currentItems(), { id: 'progress', type: 'agentMessage', text: '새 진행 메시지' }]); await f.ui.refreshCurrent();
  assert.equal(f.el('history').scrollTop, scroll); assert.equal(f.document.activeElement, f.el('messageSearch')); assert.equal(f.el('messageSearchResults').children[0], buttons[0]);
  assert.equal(find(f.el('messages'), 'video')[0], movie); assert.equal(movie.currentTime, .4); assert.equal(movie.paused, false); assert.equal(movie.detachCount || 0, detached);
  for (const query of ['tool-private-needle', 'reasoning-private-needle', 'hidden-args', 'not loaded', '[.*]']) {
    f.el('messageSearch').value = query; f.el('messageSearch').oninput(); assert.equal(f.ui.state.tools.matches.length, 0); assert.equal(f.el('searchNext').disabled, true); assert.match(f.el('messageSearchStatus').textContent, /일치하는 내용이 없습니다/);
  }
  f.el('messageSearch').value = '<b>안전</b>'; f.el('messageSearch').oninput(); assert.equal(f.ui.state.tools.matches.length, 1);
  assert.equal(find(f.el('messageSearchResults'), 'b').length, 0); f.ui.persistDevice(true);
  const saved = JSON.stringify([...f.storage.values]); for (const hidden of ['reasoning-private-needle', '표시 본문', 'requestNotice', '/api/media/', '나의 문자 그대로']) assert.ok(!saved.includes(hidden));
  const match = f.ui.state.tools.matches[0], ui = f.ui.state.historyNodes.get(match.key); ui.root.rect = { top: 240, bottom: 300 }; f.el('history').rect = { top: 0, bottom: 100 };
  f.el('messageSearchResults').children[0].onclick(); assert.equal(f.el('toolsDialog').open, false); assert.equal(f.document.activeElement, ui.root); assert.equal(ui.root.dataset.toolTarget, 'true');
  f.el('chatTools').onclick(); f.el('toolSearch').onclick(); assert.equal(f.el('messageSearch').value, '<b>안전</b>'); f.el('searchClear').onclick(); assert.equal(f.ui.state.tools.matches.length, 0);
  assert.equal(f.el('draft').value, '기존 초안');
});
test('search result and query counts are bounded; next/previous navigate the exact message without DOM highlighting', async () => {
  const f = await setup(); f.items(Array.from({ length: 250 }, (_, n) => ({ id: `a-${n}`, type: 'agentMessage', text: '공통 검색 본문 ' + n })));
  await f.ui.refreshCurrent(); f.el('toolSearch').onclick(); f.el('messageSearch').value = '공통'; f.el('messageSearch').oninput();
  assert.equal(f.ui.state.tools.matches.length, 200); assert.equal(f.el('messageSearchResults').children.length, 200); assert.match(f.el('messageSearchStatus').textContent, /최대 표시/);
  f.el('searchNext').onclick(); assert.equal(f.ui.state.tools.match, 1); assert.equal(f.el('toolsDialog').open, false);
  f.el('toolSearch').onclick(); f.el('searchPrevious').onclick(); assert.equal(f.ui.state.tools.match, 0); assert.equal(find(f.el('messages'), 'mark').length, 0);
  f.el('messageSearch').value = '가'.repeat(500); f.el('messageSearch').oninput(); assert.equal(f.ui.state.tools.query.length, 200);
});
test('individual message copy is explicit, preserves literal text, reports clipboard success/failure and provides only that message as manual fallback', async () => {
  const f = await setup(), ui = [...f.ui.state.historyNodes.values()].find(ui => ui.kind === 'userMessage');
  f.evaluate('globalThis.copied = []; navigator.clipboard = { async writeText(value) { copied.push(value); } };');
  await ui.copy.onclick(); assert.equal(f.evaluate('copied[0]'), '나의 문자 그대로 .* [한글] <b>안전</b>'); assert.equal(ui.copy.textContent, '복사됨'); assert.ok(!f.el('copyDialog').open);
  f.evaluate('navigator.clipboard = { async writeText() { throw new Error("denied"); } }; document.execCommand = () => false;');
  const draft = f.el('draft'); draft.focus(); await ui.copy.onclick(); assert.equal(ui.copy.textContent, '직접 복사 필요'); assert.equal(f.el('copyDialog').open, true); assert.equal(f.el('manualCopy').value, ui.visibleText);
  assert.ok(!f.el('manualCopy').value.includes('tool-private')); f.el('selectCopy').onclick(); assert.equal(f.el('manualCopy').selectionEnd, ui.visibleText.length);
  f.el('closeCopy').onclick(); assert.equal(f.el('manualCopy').value, ''); assert.equal(draft.value, '기존 초안');
  f.evaluate('document.execCommand = () => true;'); await ui.copy.onclick(); assert.equal(ui.copy.textContent, '복사됨'); assert.equal(f.el('copyDialog').open, false);
  assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('gathered results filter loaded safe DTOs, dedupe handles and jump to original helpers without duplicate videos or transfers, retaining main player on polls', async () => {
  const f = await setup(), movie = find(f.el('messages'), 'video')[0]; movie.currentTime = .6; await movie.play();
  f.el('toolResults').onclick(); assert.equal(f.ui.state.tools.results.length, 3); assert.equal(find(f.el('gatheredResults'), 'video').length, 0); assert.equal(find(f.el('gatheredResults'), 'img').length, 0);
  f.el('resultsVideos').onclick(); assert.equal(f.el('gatheredResults').children.length, 1); assert.match(f.el('gatheredResults').children[0].textContent, /동영상/);
  const button = f.el('gatheredResults').children[0], detaches = movie.detachCount || 0, calls = f.calls.length;
  await f.ui.refreshCurrent(); assert.equal(f.el('gatheredResults').children[0], button); assert.equal(movie.detachCount || 0, detaches); assert.equal(movie.currentTime, .6); assert.equal(movie.paused, false);
  button.onclick(); assert.equal(f.el('toolsDialog').open, false); assert.equal(find(f.el('messages'), 'video')[0], movie); assert.ok(!f.calls.slice(calls).some(c => /media|files|send/.test(c.path)));
  f.el('toolResults').onclick(); f.el('resultsFiles').onclick(); f.el('gatheredResults').children[0].onclick();
  assert.ok(nodes(f.document.activeElement).some(n => n.className === 'result-file')); assert.ok(find(f.document.activeElement, 'a').some(n => n.href.startsWith('/api/files/')));
  f.items([{ id: 'expired', type: 'imageView', media: { state: 'unavailable', alt: '만료 샘플', error: 'MEDIA_MISSING' } }]); await f.ui.refreshCurrent(); f.el('toolResults').onclick(); f.el('resultsAll').onclick(); assert.match(f.el('gatheredResults').children[0].textContent, /원본 확인 필요/);
  f.el('gatheredResults').children[0].onclick(); assert.ok(find(f.document.activeElement, 'button').some(n => /다시 확인/.test(n.textContent)));
});
test('gathered result metadata is capped/deduped, empty filters are explicit, and added results do not replace the focused existing entry', async () => {
  const f = await setup();
  const photos = Array.from({ length: 160 }, (_, n) => ({ id: `generated-${n}`, type: 'imageView', media: { state: 'ready', url: '/api/media/' + String(n).padStart(43, 'i'), alt: `생성 사진 ${n}` } }));
  f.items([...photos, { ...photos[0], id: 'duplicate' }]); await f.ui.refreshCurrent(); f.el('toolResults').onclick();
  assert.equal(f.ui.state.tools.results.length, 128); assert.match(f.el('resultsStatus').textContent, /최대 표시/);
  f.el('resultsVideos').onclick(); assert.equal(f.el('gatheredResults').children.length, 0); assert.match(f.el('resultsStatus').textContent, /해당 결과가 없습니다/);
  f.items([photos[0], { ...photos[0], id: 'duplicate' }]); await f.ui.refreshCurrent(); f.el('resultsAll').onclick(); assert.equal(f.ui.state.tools.results.length, 1);
  const button = f.el('gatheredResults').children[0]; button.focus(); f.items([photos[0], photos[1]]); await f.ui.refreshCurrent();
  assert.equal(f.el('gatheredResults').children[0], button); assert.equal(f.document.activeElement, button); assert.equal(f.ui.state.tools.results.length, 2);
});
test('search/copy uses displayed text rather than Markdown hidden URLs, image references or button labels', async () => {
  const f = await setup(), value = '앞 [보이는 링크](https://fixture.invalid/hidden-url) ![샘플](<D:/fixture/hidden-image.png>) 뒤';
  const start = value.indexOf('!['), end = value.indexOf(' 뒤');
  f.items([{ id: 'visible-only', type: 'agentMessage', text: value, images: [{ start, end, media: { state: 'ready', url: '/api/media/' + 'i'.repeat(43), alt: '생성 사진' } }] }]); await f.ui.refreshCurrent(); f.el('toolSearch').onclick();
  for (const query of ['hidden-url', 'hidden-image', 'fixture.invalid', '복사', '이미지 다시 확인']) { f.el('messageSearch').value = query; f.el('messageSearch').oninput(); assert.equal(f.ui.state.tools.matches.length, 0); }
  f.el('messageSearch').value = '보이는 링크'; f.el('messageSearch').oninput(); assert.equal(f.ui.state.tools.matches.length, 1);
  f.el('closeTools').onclick(); f.evaluate('navigator.clipboard = { async writeText(value) { globalThis.copiedText = value; } };');
  const message = [...f.ui.state.historyNodes.values()].find(ui => ui.kind === 'agentMessage'); await message.copy.onclick();
  assert.match(f.evaluate('copiedText'), /보이는 링크/); assert.ok(!f.evaluate('copiedText').includes('hidden-')); assert.ok(!f.evaluate('copiedText').includes('복사'));
});
test('tool state and pending clipboard/diagnostic responses are cleared on logout/thread changes and stale auth does not repopulate them', async () => {
  const f = await setup(); f.el('toolSearch').onclick(); f.el('messageSearch').value = '.*'; f.el('messageSearch').oninput(); f.el('toolResults').onclick();
  await f.ui.openThread('other'); assert.equal(f.el('toolsDialog').open, false); assert.equal(f.ui.state.tools.query, ''); assert.equal(f.el('gatheredResults').children.length, 0); assert.equal(f.el('manualCopy').value, '');
  let resolve; f.hook(path => path === '/api/diagnostics' ? new Promise(done => { resolve = done; }) : null);
  f.el('listDiagnostics').onclick(); await waitFor(() => resolve); const flight = f.ui.state.tools.diagnosticFlight.promise;
  f.ui.showPair('expired'); resolve({ data: { desktop: 'available', readonly: 'available' } }); await flight;
  assert.equal(f.ui.state.tools.diagnostic, null); assert.equal(f.el('toolsDialog').open, false); assert.equal(f.el('copyDialog').open || false, false); assert.equal(f.ui.state.tools.results.length, 0);
});
test('Back/Escape dismiss only the tool/copy layer, preserve the underlying chat and do not trigger extra history polls; stale clipboard failure never reopens private text', async () => {
  const f = await setup(), calls = f.calls.length;
  f.el('toolSearch').onclick(); f.evaluate('history.back()');
  assert.equal(f.el('toolsDialog').open, false); assert.equal(f.document.body.dataset.chat, 'true'); assert.equal(f.evaluate('location.hash'), '#conversation'); assert.equal(f.calls.length, calls);
  f.el('toolResults').onclick(); let prevented = false; f.el('toolsDialog').events.get('cancel')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.el('toolsDialog').open, false); assert.equal(f.ui.state.tools.layer, null); assert.equal(f.evaluate('location.hash'), '#conversation');
  f.evaluate('navigator.clipboard = { writeText() { return new Promise((resolve, reject) => { globalThis.rejectCopy = reject; }); } };');
  const message = [...f.ui.state.historyNodes.values()].find(ui => ui.kind === 'userMessage'), pending = message.copy.onclick();
  f.ui.showPair('expired'); f.evaluate('rejectCopy(new Error("denied"))'); await pending;
  assert.equal(f.el('copyDialog').open || false, false); assert.equal(f.el('manualCopy').value, ''); assert.equal(f.ui.state.tools.layer, null);
});
test('diagnostics opens from list or chat, coalesces manual clicks, shows unconfirmed network causes and recovers without sending', async () => {
  const f = await setup(); let resolve;
  f.hook(path => path === '/api/diagnostics' ? new Promise(done => { resolve = done; }) : null);
  f.el('listDiagnostics').onclick(); f.el('retryDiagnostics').onclick(); f.el('toolDiagnostics').onclick();
  assert.equal(f.calls.filter(c => c.path === '/api/diagnostics').length, 1); assert.equal(f.el('retryDiagnostics').disabled, true);
  resolve({ data: { bridge: 'available', desktop: 'unavailable', readonly: 'available', desktopSuccessAt: 100, readonlySuccessAt: 200 } }); await f.ui.state.tools.diagnosticFlight.promise;
  assert.match(text(f.el('diagnosticFacts')), /조회 확인 불가/); assert.match(text(f.el('diagnosticFacts')), /진단 요청 인증됨/);
  f.offline(true); await f.el('retryDiagnostics').onclick(); assert.match(f.el('diagnosticStatus').textContent, /원인은 확인되지 않았/); assert.equal(f.el('retryDiagnostics').disabled, false);
  f.offline(false); f.hook(null); await f.el('retryDiagnostics').onclick(); assert.equal(f.ui.state.tools.diagnostic.desktop, 'available'); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
