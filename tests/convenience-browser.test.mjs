import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, deviceStorage } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';
import { release } from '../server/release.mjs';

const nodes = root => [root, ...(root.children || []).flatMap(child => typeof child === 'object' ? nodes(child) : [])];
const find = (root, tag) => nodes(root).filter(n => n.tagName === tag.toUpperCase());
const text = root => root.nodeType === 3 ? root.data : Array.from(root.childNodes || []).map(text).join('');
const item = (id, value) => ({ id, type: 'agentMessage', text: value });
async function chat(options = {}) {
  const f = await browser({ selected: false, ...options });
  let items = [item('base', '처음 답변')], checked = 100;
  f.hook(path => path.endsWith('/history') ? { data: { data: [{ id: 'current', status: 'inProgress', items }], nextCursor: 'older', status: 'active', previewCheckedAt: checked++ } }
    : path.includes('/history?cursor=') ? { data: { data: [{ id: 'older', startedAt: 1, status: 'completed', items: [item('old', '오래된 답변')] }], nextCursor: null } }
      : path.endsWith('/questions') ? { data: { state: 'ready', data: [] } } : null);
  await f.ui.openThread('fixture');
  return { ...f, items: value => { items = value; }, current: () => items };
}
const input = (f, id, value) => { f.el(id).value = value; f.el(id).oninput?.(); };
const addSnippet = (f, label, value) => { input(f, 'snippetLabel', label); input(f, 'snippetText', value); f.el('snippetForm').onsubmit({ preventDefault() {} }); };

test('new answer jump is explicit, ignores old prepend and unchanged polls, keeps reader/focus/draft/media and does not mark an unseen long answer read', async () => {
  const f = await chat();
  f.items([...f.current(), { id: 'movie', type: 'imageView', media: { state: 'ready', kind: 'video', url: '/api/media/' + 'v'.repeat(43), alt: '합성 영상' } }]); await f.ui.refreshCurrent();
  const movie = find(f.el('messages'), 'video')[0]; await movie.play(); movie.currentTime = .4; const detached = movie.detachCount || 0, src = movie.src;
  const area = f.el('history'); area.scrollHeight = 2500; area.clientHeight = 400; area.scrollTop = 200;
  area.events.get('scroll')(); f.el('draft').focus(); input(f, 'draft', '위치를 유지할 초안');
  await f.el('moreHistory').onclick(); assert.equal(f.el('latestResponse').hidden, true);
  const top = area.scrollTop;
  f.items([...f.current(), item('new', '새 응답'.repeat(800))]); await f.ui.refreshCurrent();
  assert.equal(area.scrollTop, top); assert.equal(f.el('latestResponse').hidden, false); assert.equal(f.document.activeElement, f.el('draft'));
  const ui = f.ui.state.historyNodes.get(f.ui.state.latestAnswer.key), root = ui.root;
  await f.ui.refreshCurrent(); assert.equal(ui.root, root); assert.equal(area.scrollTop, top); assert.equal(f.el('latestResponse').hidden, false);
  root.rect = { top: 600, bottom: 1900 }; area.rect = { top: 100, bottom: 500 };
  const beforeRead = JSON.stringify([...f.ui.state.activity]); f.el('latestResponse').onclick();
  assert.equal(area.scrollTop, top + 500); assert.equal(f.el('latestResponse').hidden, true); assert.equal(JSON.stringify([...f.ui.state.activity]), beforeRead);
  assert.equal(f.el('draft').value, '위치를 유지할 초안'); assert.equal(f.document.activeElement, f.el('draft')); assert.equal(f.frames.size, 0);
  assert.equal(find(f.el('messages'), 'video')[0], movie); assert.equal(movie.currentTime, .4); assert.equal(movie.paused, false); assert.equal(movie.src, src); assert.equal(movie.detachCount || 0, detached);
  assert.ok(!f.calls.some(c => c.options.method === 'POST'));
  await f.ui.openThread('other'); assert.equal(f.el('latestResponse').hidden, true); f.ui.showPair(); assert.equal(f.ui.state.latestAnswer.key, null);
});
test('bottom reader, partial reveal and reduced motion never manufacture jump/unread state; removing latest text clears a stale target', async () => {
  for (const reducedMotion of [true, false]) {
    const f = await chat({ reducedMotion }); f.items([...f.current(), item('new', '받은 본문'.repeat(50))]); await f.ui.refreshCurrent();
    assert.equal(f.el('latestResponse').hidden, true); f.frame(1000);
    const area = f.el('history'); area.scrollHeight = 2000; area.scrollTop = 0; area.events.get('scroll')();
    f.items([item('base', '바뀐 답변')]); await f.ui.refreshCurrent(); assert.equal(f.el('latestResponse').hidden, false);
    f.items([]); await f.ui.refreshCurrent(); assert.equal(f.el('latestResponse').hidden, true);
  }
});
test('expanded editor shares one per-chat draft, persists edits and selection on Escape/Back without any second send path or poll focus loss', async () => {
  const f = await chat(); input(f, 'draft', '처음\n초안'); f.el('draft').setSelectionRange(1, 4); f.el('expandDraft').onclick();
  assert.equal(f.el('editorDialog').open, true); assert.equal(f.el('expandedDraft').selectionStart, 1);
  input(f, 'expandedDraft', '긴 한글\n수정한 초안'); f.el('expandedDraft').setSelectionRange(3, 7); f.el('expandedDraft').focus();
  await f.ui.refreshCurrent(); assert.equal(f.el('expandedDraft').value, '긴 한글\n수정한 초안'); assert.equal(f.document.activeElement, f.el('expandedDraft'));
  f.el('editorDialog').events.get('cancel')({ preventDefault() {} });
  assert.equal(f.el('editorDialog').open, false); assert.equal(f.el('draft').value, '긴 한글\n수정한 초안'); assert.equal(f.el('draft').selectionStart, 3);
  assert.equal(f.ui.durable.data.drafts.find(([id]) => id === 'fixture')[1], f.el('draft').value);
  f.advance(400); f.el('expandDraft').onclick(); f.advance(400); assert.equal(f.window.codexPhoneBack(), 'handled'); assert.equal(f.el('editorDialog').open, false);
  assert.equal(f.document.body.dataset.chat, 'true'); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('composition close/thread race waits for the completed input, then stores only in captured chat; pending locks and logout cannot bypass or revive editor text', async () => {
  const f = await chat({ asyncHistory: true }); f.el('expandDraft').onclick(); const editor = f.el('expandedDraft');
  editor.events.get('compositionstart')(); input(f, 'expandedDraft', '조합 중');
  const switching = f.ui.openThread('other'); assert.equal(f.ui.state.selected, 'fixture'); assert.equal(f.el('editorDialog').open, true);
  input(f, 'expandedDraft', '조합 완료'); editor.events.get('compositionend')(); f.navigation.flush(); await switching;
  assert.equal(f.ui.state.drafts.get('fixture'), '조합 완료'); assert.equal(f.el('draft').value, ''); assert.equal(f.ui.state.selected, 'other');
  f.ui.state.pending = { threadId: 'other', requestId: '11111111-1111-4111-8111-111111111111' }; f.ui.composerState(); f.el('expandDraft').onclick(); assert.ok(!f.el('editorDialog').open);
  f.ui.state.pending = null; f.ui.composerState(); f.el('expandDraft').onclick(); input(f, 'expandedDraft', '폐기할 초안'); f.ui.showPair();
  input(f, 'expandedDraft', '늦은 이전 입력'); editor.events.get('compositionend')(); assert.equal(f.ui.state.drafts.size, 0); assert.equal(f.ui.state.editor, null);
});
test('browser traversal during composition keeps its final text with the original chat even if another chat opens before compositionend', async () => {
  const f = await chat(); f.el('expandDraft').onclick(); const editor = f.el('expandedDraft'); editor.events.get('compositionstart')(); input(f, 'expandedDraft', '미완성');
  f.navigation.history.back(); assert.equal(f.ui.state.editor.detached, true);
  await f.ui.openThread('other'); editor.value = '완성한 원래 초안'; editor.events.get('compositionend')();
  assert.equal(f.ui.state.drafts.get('fixture'), '완성한 원래 초안'); assert.equal(f.el('draft').value, ''); assert.equal(f.ui.state.editor, null);
});
test('expanded editor save failure remains visible in the dialog and ordinary composer; delayed modal replacement waits for composition', async () => {
  const f = await chat(); f.el('expandDraft').onclick(); input(f, 'expandedDraft', '보존할 편집'); const set = f.storage.setItem;
  f.storage.setItem = () => { throw Error('quota'); }; f.ui.persistDevice(true); assert.match(f.el('editorStatus').textContent, /저장 실패/);
  f.el('closeEditor').onclick(); assert.match(f.el('composerStatus').textContent, /저장 실패/); assert.equal(f.el('draft').value, '보존할 편집');
  f.storage.setItem = set; f.advance(400); f.el('expandDraft').onclick(); const editor = f.el('expandedDraft'); editor.events.get('compositionstart')();
  f.evaluate("openToolLayer('copyDialog')"); assert.equal(f.el('editorDialog').open, true); assert.ok(!f.el('copyDialog').open);
  input(f, 'expandedDraft', '완료한 편집'); editor.events.get('compositionend')(); await waitFor(() => f.el('copyDialog').open);
  assert.equal(f.el('draft').value, '완료한 편집'); assert.ok(!f.el('editorDialog').open); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('tables, ordered/unordered/task lists use safe semantic DOM; fences, malformed tables, escapes, inline code and raw copy are exact', async () => {
  const f = await chat(), raw = '| 이름 | 값 |\n| :--- | ---: |\n| **한글** | `a|b` |\n| escaped \\| cell | [외부](https://example.invalid) |\n\n- [x] 완료\n- [ ] 미완료\n- 일반 <script>문자</script>\n\n3. 세 번째\n4. 다음\n\n~~~md\n| 코드 | 표 |\n| --- | --- |\n- [x] 문자 그대로\n```js\n~~~\n\n| 깨진 | 표 |\n| --- | --- |\n| 값 하나 |\n\n[j](javascript:alert(1))';
  f.items([item('base', raw)]); await f.ui.refreshCurrent();
  const ui = f.ui.state.historyNodes.get(JSON.stringify(['current', 'base', 'agentMessage']));
  assert.equal(find(ui.body, 'table').length, 1); assert.equal(find(ui.body, 'th').length, 2); assert.ok(find(ui.body, 'th').every(n => n.attributes.scope === 'col'));
  assert.equal(find(ui.body, 'ol')[0].attributes.start, '3'); assert.equal(find(ui.body, 'li').length, 5);
  assert.equal(nodes(ui.body).filter(n => n.className === 'task-mark').length, 2); assert.equal(find(ui.body, 'input').length, 0);
  assert.equal(find(ui.body, 'script').length, 0); assert.equal(find(ui.body, 'a').length, 1); assert.equal(find(ui.body, 'a')[0].href, 'https://example.invalid');
  assert.ok(text(ui.body).includes('a|b')); assert.ok(text(ui.body).includes('escaped | cell')); assert.ok(text(ui.body).includes('| 값 하나 |'));
  assert.ok(text(find(ui.body, 'pre')[0]).includes('- [x] 문자 그대로\n```js'));
  f.evaluate('globalThis.copied = []; navigator.clipboard = { async writeText(value) { copied.push(value); } };');
  await ui.rawCopy.onclick(); assert.equal(f.evaluate('copied[0]'), raw); const body = ui.body.children[0]; await f.ui.refreshCurrent(); assert.equal(ui.body.children[0], body);
  const calls = f.calls.length; assert.ok(!f.calls.some(c => /example.invalid/.test(c.path))); assert.equal(f.calls.length, calls);
});
test('single-column tables, delimiter alignment and adjacent lists retain safe readable structure without making raw HTML controls', async () => {
  const f = await chat(); f.items([item('base', '| 상태 |\n| :---: |\n| [x] 표 셀은 문자 |\n\n- <input checked>\n- [x] **확인**')]); await f.ui.refreshCurrent();
  const table = find(f.el('messages'), 'table')[0]; assert.ok(table); assert.equal(find(table, 'th')[0].className, 'align-center'); assert.equal(find(table, 'td')[0].className, 'align-center');
  assert.equal(find(f.el('messages'), 'input').length, 0); assert.equal(find(f.el('messages'), 'strong').length, 1); assert.ok(text(f.el('messages')).includes('[x] 표 셀은 문자'));
});
test('renderer rejects oversized and invalid block shapes as literal text without giant table construction', async () => {
  const f = await chat();
  for (const raw of ['| a | b |\n| --- | --- |\n' + '| x | y |\n'.repeat(201), '| a | b |\n| -- | --- |\n| x | y |', '| a | b |\n| --- | --- |\n| `open | y |', 'a'.repeat(131073), '\n'.repeat(4097) + '- [x] end']) {
    f.items([item('base', raw)]); await f.ui.refreshCurrent(); assert.equal(find(f.el('messages'), 'table').length, 0);
  }
});
test('personal instructions CRUD/reorder/apply is local, built-ins survive, empty/duplicate/length/count errors and deletion feedback are visible', async () => {
  const f = await chat(); f.el('toolQuick').onclick(); addSnippet(f, '', '내용'); assert.match(f.el('snippetFeedback').textContent, /입력/);
  addSnippet(f, '첫 지시', '첫 본문\n둘째 줄'); addSnippet(f, '둘째 지시', '둘째 본문');
  addSnippet(f, '첫 지시', '다른 본문'); assert.match(f.el('snippetFeedback').textContent, /이미/); assert.equal(f.ui.state.snippets.length, 2);
  f.el('cancelSnippet').onclick(); const first = f.el('snippetList').children[0]; first.actions.down.onclick();
  assert.equal(f.ui.durable.data.snippets[0].label, '둘째 지시'); assert.equal(f.el('snippetList').children[1], first);
  first.actions.edit.onclick(); input(f, 'snippetText', '수정한 첫 본문'); f.el('snippetForm').onsubmit({ preventDefault() {} }); assert.equal(f.ui.state.snippets[1].text, '수정한 첫 본문');
  input(f, 'draft', '기존 초안'); first.apply.onclick(); assert.equal(f.el('draft').value, '기존 초안\n\n수정한 첫 본문'); assert.ok(!f.calls.some(c => c.options.method === 'POST'));
  assert.equal(f.el('quickContinue').disabled, false); f.el('toolQuick').onclick(); first.actions.remove.onclick(); assert.match(f.el('snippetFeedback').textContent, /삭제/);
  for (let n = 0; n < 12; n++) addSnippet(f, '이름 ' + n, '본문 ' + n);
  assert.equal(f.ui.state.snippets.length, 12); assert.match(f.el('snippetFeedback').textContent, /최대 12/);
  addSnippet(f, '새 이름', '가'.repeat(2001)); assert.match(f.el('snippetFeedback').textContent, /2,000/);
  input(f, 'draft', '가'.repeat(16000)); f.el('snippetList').children[0].apply.onclick(); assert.equal(f.el('draft').value.length, 16000); assert.match(f.el('quickFeedback').textContent, /추가하지/);
});
test('personal snippets and expanded drafts survive independent restart, sanitize stored data and never cross logout/session; quota failure stays visible', async () => {
  const storage = deviceStorage(), f = await chat({ storage }); addSnippet(f, '내 지시', '<b>일반 문자</b>'); f.el('expandDraft').onclick(); input(f, 'expandedDraft', '저장한 긴 초안'); f.ui.persistDevice(true);
  const next = await browser({ selected: false, storage }); await waitFor(() => next.ui.state.selected === 'fixture');
  assert.equal(next.ui.state.snippets[0].text, '<b>일반 문자</b>'); assert.equal(next.el('draft').value, '저장한 긴 초안'); assert.equal(find(next.el('snippetList'), 'b').length, 0);
  const bounded = next.ui.durable.bounded({ version: 2, scope: next.ui.durable.scope, snippets: [{ id: 'x', label: 'valid', text: 'ok', cookie: 'SECRET' }, { id: 'x', label: 'duplicate ID', text: 'other' }, { id: 'y', label: 'bad\u0000', text: 'text' }, { id: 'z', label: 'huge', text: 'a'.repeat(2001) }] });
  assert.equal(bounded.snippets.length, 1); assert.ok(!JSON.stringify(bounded).includes('SECRET'));
  storage.setItem = () => { throw new Error('quota'); }; addSnippet(next, '추가 지시', '메모리에는 유지'); assert.match(next.el('snippetFeedback').textContent, /저장 실패/); assert.equal(next.ui.state.snippets.length, 2);
  next.ui.showPair(); assert.equal(next.el('snippetList').children.length, 0); assert.equal(next.ui.state.snippets.length, 0);
  const other = await browser({ storage, scope: 'b'.repeat(64) }); assert.equal(other.ui.state.snippets.length, 0); assert.ok(!other.calls.some(c => c.path === '/api/send'));
});
async function updates(options = {}) {
  const f = await chat(options); await waitFor(() => !f.ui.state.updates.flight);
  f.evaluate('globalThis.releaseNow = Date.now() + 10000; Date.now = () => releaseNow;');
  let value = { revision: 'different-web', notes: ['실제와 구분한 합성 변경 안내'] }, failure = false;
  f.hook(path => path === '/api/release' ? { data: failure ? { error: 'NETWORK' } : value, status: failure ? 503 : 200 } : null);
  const retry = async () => { f.evaluate('releaseNow += 4000'); await f.el('retryUpdate').onclick(); };
  await retry(); return { ...f, retry, result: v => { value = v; }, failed: v => { failure = v; } };
}
test('update info compares identifiers only, retains truthful unavailable/retry and current revision, never auto-reloads, pauses hidden and uses existing bounded poll', async () => {
  const f = await updates(); assert.equal(f.el('applyUpdate').hidden, false); assert.equal(f.navigation.location.reloads, undefined);
  assert.match(f.el('webRevision').textContent, new RegExp(release.revision)); assert.equal(f.el('listUpdates').textContent, '웹 업데이트 있음');
  const count = f.calls.filter(c => c.path === '/api/release').length;
  await f.el('retryUpdate').onclick(); assert.equal(f.calls.filter(c => c.path === '/api/release').length, count);
  f.failed(true); await f.retry(); assert.match(f.el('updateStatus').textContent, /확인 불가/); assert.equal(f.el('applyUpdate').disabled, true); assert.equal(f.ui.state.updates.result.revision, 'different-web');
  f.failed(false); f.result({ revision: '000-older-looking', notes: ['동등성만 비교'] }); await f.retry(); assert.equal(f.el('applyUpdate').disabled, false);
  f.document.hidden = true; await f.retry(); assert.equal(f.calls.filter(c => c.path === '/api/release').length, count + 2);
  f.document.hidden = false; f.result({ revision: release.revision, notes: release.notes }); await f.retry(); assert.equal(f.el('applyUpdate').hidden, true);
  f.result({ revision: 'bad<script>', notes: ['bad'] }); await f.retry(); assert.equal(f.ui.state.updates.result.revision, release.revision); assert.equal(f.ui.state.updates.failed, true);
  assert.equal(f.navigation.location.reloads, undefined); assert.ok(!f.calls.some(c => c.options.method === 'POST'));
});
test('single-flight update lookup ignores late prior-session results and manual burst cannot overlap a hanging GET', async () => {
  const f = await updates(); let complete; f.hook(path => path === '/api/release' ? new Promise(done => { complete = done; }) : null);
  f.evaluate('releaseNow += 4000'); const first = f.el('retryUpdate').onclick(), second = f.el('retryUpdate').onclick(); assert.equal(first, second);
  await waitFor(() => Boolean(complete)); f.ui.showPair(); complete({ data: { revision: 'late-private-session', notes: ['늦은 응답'] } }); await first;
  assert.equal(f.ui.state.updates.result, null); assert.ok(!f.el('updateStatus').textContent.includes('late-private-session'));
});
test('explicit update apply blocks every loss risk and save failure, then reloads only once after exact draft persistence for independent restart', async () => {
  const f = await updates();
  const checks = [
    ['pending', { threadId: 'fixture' }], ['sending', true], ['serverSending', true], ['acknowledging', true], ['recoverRequest', 'unresolved'], ['transferBusy', true], ['booting', true]
  ];
  for (const [key, value] of checks) { f.ui.state[key] = value; f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined, key); f.ui.state[key] = key === 'pending' ? null : false; }
  f.ui.state.creation.checked = false; f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined); f.ui.state.creation.checked = true;
  f.ui.state.creation.message = '이전 상태 확인 불가'; f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined); f.ui.state.creation.message = '';
  const dynamicQuestion = f.document.createElement('textarea'); f.events.get('compositionstart')({ target: dynamicQuestion }); f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined); f.events.get('compositionend')({ target: dynamicQuestion });
  f.ui.state.creation.receipt = { state: 'uncertain' }; f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined); f.ui.state.creation.receipt = null;
  for (const [id, value] of [['newPrompt', '첫 요청'], ['snippetText', '미저장 수정']]) { f.el(id).value = value; f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined, id); f.el(id).value = ''; }
  f.el('draft').events.get('compositionstart')(); f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined); f.el('draft').events.get('compositionend')();
  f.evaluate("attachments.groups.set('offpage', [{status:'ready'}])"); f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined); assert.match(f.el('updateStatus').textContent, /첨부/); f.evaluate('attachments.groups.clear()');
  input(f, 'draft', '업데이트 뒤 남겨야 할 한글\n둘째 줄'); const set = f.storage.setItem; f.storage.setItem = () => { throw Error('quota'); }; f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined); assert.match(f.el('updateStatus').textContent, /저장하지 못해/);
  f.storage.setItem = set; f.ui.state.drafts.set('overlong', 'x'.repeat(16001)); f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined); f.ui.state.drafts.delete('overlong');
  f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, 1);
  const restart = await browser({ selected: false, storage: f.storage }); await waitFor(() => restart.ui.state.selected === 'fixture'); assert.equal(restart.el('draft').value, '업데이트 뒤 남겨야 할 한글\n둘째 줄');
  assert.ok(!f.calls.some(c => c.options.method === 'POST'));
});
