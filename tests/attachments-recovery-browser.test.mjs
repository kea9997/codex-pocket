import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';
import { optionsView } from './options-fixture.mjs';
const event = { preventDefault() {} };
const plain = value => JSON.parse(JSON.stringify(value));
async function setup(hook) {
  const f = await browser({ selected: false, requestHook: async (path, opts) => (hook ? await hook(path, opts) : null) || (path === '/api/options' ? { data: optionsView() } : null) });
  await waitFor(() => !f.ui.state.booting && !f.ui.state.creation.checking); await f.ui.openThread('fixture');
  f.el('draft').value = '첨부와 보낼 요청'; f.el('draft').oninput(); return f;
}
function pick(f, files, fresh = false) {
  f.el(fresh ? 'attachNewFiles' : 'attachFiles').click();
  const input = f.el(fresh ? 'newAttachmentPicker' : 'attachmentPicker'); input.files = files; input.onchange();
}
function complete(f, index = 0) {
  const xhr = f.uploads[index], data = { handle: String.fromCharCode(117 + index).repeat(43), sha256: String(index + 1).repeat(64), size: xhr.file.size, expiresAt: Date.now() + 86400000 };
  xhr.respond(data); return data;
}
async function newPane(f) { await f.el('newChat').onclick(); await waitFor(() => !f.ui.state.models.flight && !f.ui.state.creation.checking); f.el('newPrompt').value = '첫 첨부 요청'; f.el('newPrompt').oninput(); }

test('real File/change/raw upload progress locks send; exact handles/hashes are frozen only on explicit send and consumed after delivery', async () => {
  let sent;
  const f = await setup((path, opts) => path === '/api/send' ? (sent = JSON.parse(opts.body), { data: { requestId: sent.requestId, threadId: sent.threadId, state: 'delivered' } }) : null);
  const file = new File(['photo bytes'], '사진.png', { type: 'image/png' }); pick(f, [file]);
  assert.equal(f.uploads.length, 1); const xhr = f.uploads[0]; assert.equal(xhr.file, file); assert.equal(xhr.path, '/api/uploads'); assert.equal(xhr.headers['Content-Type'], 'image/png'); assert.equal(xhr.headers['X-Codex-CSRF'], 'fixture-csrf');
  assert.equal(f.el('send').disabled, true); await f.el('composer').onsubmit(event); assert.equal(sent, undefined);
  xhr.progress(5); assert.match(f.el('attachments').children[0].children[0].children[1].textContent, /45%/);
  const uploaded = complete(f); assert.equal(f.el('send').disabled, false); assert.equal(sent, undefined);
  assert.match(f.el('attachments').children[0].children[0].children[0].textContent, /사진.png/);
  await f.el('composer').onsubmit(event);
  assert.deepEqual(sent.attachments, [{ handle: uploaded.handle, sha256: uploaded.sha256, size: file.size }]); assert.equal(sent.text, '첨부와 보낼 요청');
  assert.equal(f.el('attachments').children.length, 0); assert.equal(f.el('draft').value, '');
  const stored = [...f.storage.values.values()].join(''); for (const privateValue of ['사진.png', 'photo bytes', uploaded.handle, uploaded.sha256]) assert.ok(!stored.includes(privateValue));
});
test('cancel/error/manual retry/removal preserve draft and never autosend or auto-upload after online; server deletion is explicit', async () => {
  const f = await setup(path => path.endsWith('/cancel') ? { data: { removed: true } } : null), file = new File(['abc'], '문서.txt'); pick(f, [file]);
  const row = f.el('attachments').children[0]; row.children[1].onclick(); assert.equal(f.uploads[0].aborted, true); assert.match(row.children[0].children[1].textContent, /취소/); assert.equal(f.el('send').disabled, true);
  row.children[1].onclick(); assert.equal(f.uploads.length, 2); f.uploads[1].onerror(); assert.match(row.children[0].children[1].textContent, /연결 확인 실패/);
  f.offline(true); f.windowEvents.get('offline')(); f.offline(false); await f.windowEvents.get('online')(); assert.equal(f.uploads.length, 2); assert.equal(f.el('draft').value, '첨부와 보낼 요청');
  row.children[1].onclick(); complete(f, 2); assert.equal(f.el('send').disabled, false);
  row.children[2].focus(); assert.match(row.children[2].attributes['aria-label'], /문서.txt 첨부 제거/); await row.children[2].onclick(); assert.equal(f.document.activeElement, f.el('attachFiles')); assert.equal(f.el('attachments').children.length, 0); assert.equal(f.calls.filter(c => c.path.endsWith('/cancel')).length, 1); assert.equal(f.calls.filter(c => ['/api/send', '/api/create'].includes(c.path)).length, 0);
});
test('two upload slots, count/type/total bounds, picker cancellation and thread context guards keep selections scoped', async () => {
  const f = await setup(), files = [1, 2, 3].map(n => new File(['abc'], `자료${n}.txt`)); pick(f, files);
  assert.equal(f.uploads.length, 2); complete(f); assert.equal(f.uploads.length, 3);
  pick(f, Array(4).fill(files[0])); assert.match(f.el('attachmentStatus').textContent, /최대 6개/); assert.equal(f.evaluate('attachments.rows("fixture").length'), 3);
  pick(f, [new File(['x'], '실행.exe')]); assert.match(f.el('attachmentStatus').textContent, /지원하지 않는/);
  f.el('attachFiles').click(); f.el('attachmentPicker').files = [new File(['x'], '늦은.txt')]; await f.ui.openThread('other'); f.el('attachmentPicker').onchange(); assert.equal(f.evaluate('attachments.rows("other").length'), 0); assert.equal(f.el('attachments').children.length, 0);
  await f.ui.openThread('fixture'); assert.equal(f.el('attachments').children.length, 3);
  f.el('attachFiles').click(); f.el('attachmentPicker').files = []; f.el('attachmentPicker').onchange(); assert.equal(f.evaluate('attachments.rows("fixture").length'), 3);
});
test('uncertain dispatch keeps exact files/draft locked and online lookup remains GET only', async () => {
  let input;
  const f = await setup((path, opts) => path === '/api/send' ? (input = JSON.parse(opts.body), { status: 409, data: { error: 'SEND_UNCERTAIN' } }) : path.startsWith('/api/requests/') ? { data: { requestId: input?.requestId, threadId: 'fixture', state: 'uncertain' } } : null);
  pick(f, [new File(['abc'], '문서.txt')]); complete(f); await f.el('composer').onsubmit(event);
  assert.equal(f.el('draft').value, '첨부와 보낼 요청'); assert.equal(f.el('attachments').children.length, 1); assert.equal(f.el('attachments').children[0].children[2].disabled, true); assert.equal(f.el('send').disabled, true);
  const postCount = f.calls.filter(c => c.options.method === 'POST').length; await f.windowEvents.get('online')(); assert.equal(f.calls.filter(c => c.options.method === 'POST').length, postCount);
  assert.deepEqual(plain(f.ui.state.pending.files), input.attachments);
});
test('new chat first request has its own files, blocks incomplete upload, sends once, and retains existing chat selection', async () => {
  let created;
  const f = await setup((path, opts) => path === '/api/create' ? (created = JSON.parse(opts.body), { data: { kind: 'create', requestId: created.requestId, state: 'pending', verification: 'unresolved', threadId: null } }) : null);
  pick(f, [new File(['old'], '기존.txt')]); complete(f); await newPane(f);
  pick(f, [new File(['new'], '첫요청.pdf')], true); assert.equal(f.el('createChat').disabled, true); await f.el('newChatForm').onsubmit(event); assert.equal(created, undefined);
  const file = complete(f, 1); assert.equal(f.el('createChat').disabled, false); await f.el('newChatForm').onsubmit(event); await f.el('newChatForm').onsubmit(event);
  assert.equal(f.calls.filter(c => c.path === '/api/create').length, 1); assert.equal(created.attachments[0].handle, file.handle); assert.equal(f.evaluate('attachments.rows("fixture").length'), 1); assert.equal(f.el('newAttachments').children[0].children[2].disabled, true); assert.match(f.el('creationStatus').textContent, /실제 대화 ID는 아직 없어/);
});
test('logout aborts active uploads exactly once, clears private files, and late old upload responses cannot restore data after pairing', async () => {
  const f = await setup(); pick(f, [1, 2, 3].map(n => new File(['private'], `비공개${n}.txt`))); assert.equal(f.uploads.length, 2); const xhr = f.uploads[0], old = xhr.onload;
  f.ui.showPair(); assert.equal(xhr.aborted, true); assert.equal(f.el('attachments').children.length, 0); assert.equal(f.evaluate('attachments.groups.size'), 0);
  await f.ui.boot(); xhr.status = 200; xhr.responseText = JSON.stringify({ handle: 'a'.repeat(43), sha256: 'b'.repeat(64), size: 7, expiresAt: Date.now() + 86400000 }); old();
  assert.equal(f.evaluate('attachments.groups.size'), 0); assert.equal(f.el('attachments').children.length, 0); assert.ok(f.ui.state.csrf); assert.equal(f.uploads.length, 2);
  xhr.status = 401; old(); assert.ok(f.ui.state.csrf);
});
test('explicit question answer does not attach or consume unrelated composer files/draft, even while upload is incomplete', async () => {
  let sent;
  const f = await setup((path, opts) => path === '/api/send' ? (sent = JSON.parse(opts.body), { data: { requestId: sent.requestId, threadId: sent.threadId, state: 'delivered' } }) : null);
  pick(f, [new File(['pending'], '보존.txt')]); assert.equal(f.el('send').disabled, true);
  await f.evaluate('sendText("질문에 명시적인 답변", "question-id")'); assert.equal(sent.attachments, undefined); assert.equal(f.el('draft').value, '첨부와 보낼 요청'); assert.equal(f.evaluate('attachments.rows("fixture").length'), 1); assert.equal(f.ui.state.questionReceipts.get('fixture/question-id'), true);
});
test('old removal result after auth reset cannot remove a new pairing selection or steal focus', async () => {
  let release;
  const f = await setup(path => path.endsWith('/cancel') ? new Promise(done => { release = done; }) : null);
  pick(f, [new File(['old'], '이전.txt')]); complete(f); const remove = f.el('attachments').children[0].children[2]; remove.focus(); const pending = remove.onclick(); await waitFor(() => release);
  f.ui.showPair(); await f.ui.boot(); await f.ui.openThread('fixture'); pick(f, [new File(['new'], '새선택.txt')]); f.el('draft').focus(); release({ data: { removed: true } }); await pending;
  assert.equal(f.evaluate('attachments.rows("fixture").length'), 1); assert.match(f.el('attachments').children[0].children[0].children[0].textContent, /새선택.txt/); assert.equal(f.document.activeElement, f.el('draft'));
});
test('resume is one flight and gates actions until send/create receipts finish before history; no POST is replayed', async () => {
  const f = await setup(); f.ui.state.pending = { requestId: 'owned-request', threadId: 'fixture' }; let release;
  f.hook(path => path === '/api/requests/owned-request' ? new Promise(done => { release = done; }) : null);
  f.windowEvents.get('pagehide')(); const start = f.calls.length, a = f.windowEvents.get('pageshow')(), b = f.windowEvents.get('online')(); assert.equal(a, b);
  await waitFor(() => release); assert.equal(f.el('send').disabled, true); assert.ok(!f.calls.slice(start).some(c => c.path.endsWith('/history')));
  release({ data: { requestId: 'owned-request', threadId: 'fixture', state: 'rejected' } }); await a;
  const paths = f.calls.slice(start).map(c => c.path); assert.ok(paths.indexOf('/api/requests/owned-request') < paths.indexOf('/api/create/state')); assert.ok(paths.indexOf('/api/create/state') < paths.indexOf('/api/threads/fixture/history')); assert.ok(f.calls.slice(start).every(c => c.options.method === 'GET')); assert.equal(f.el('send').disabled, false);
});
test('hanging GETs share one 10s deadline, ignore late401 and cancel on hide without losing drafts', async () => {
  const f = await setup(); let release;
  f.hook(path => path === '/api/hanging' ? new Promise(done => { release = done; }) : null);
  const a = f.evaluate('api("/api/hanging")'), b = f.evaluate('api("/api/hanging")'); assert.equal(a, b); const failed = assert.rejects(a, e => e.code === 'NETWORK');
  await waitFor(() => release); assert.equal(f.calls.filter(c => c.path === '/api/hanging').length, 1);
  const timeout = [...f.timers.values()].filter(timer => timer.ms === 10000).at(-1); assert.ok(timeout); timeout.fn(); await failed;
  release({ status: 401, data: { error: 'AUTH_REQUIRED' } }); await Promise.resolve(); await Promise.resolve(); assert.ok(f.ui.state.csrf); assert.equal(f.el('draft').value, '첨부와 보낼 요청');
  let releaseAgain; f.hook(path => path === '/api/hanging' ? new Promise(done => { releaseAgain = done; }) : null);
  const pending = f.evaluate('api("/api/hanging")'); const cancelled = assert.rejects(pending, e => e.code === 'STALE_RESPONSE'); await waitFor(() => releaseAgain);
  f.document.hidden = true; f.events.get('visibilitychange')(); await cancelled; assert.equal(f.evaluate('getFlights.size'), 0); assert.equal(f.ui.state.activityTimer != null && f.timers.has(f.ui.state.activityTimer), false);
  releaseAgain({ data: {} });
});
test('automatic creation tracking rechecks only the same receipt with backoff and auto-opens verified actual ID only for unchanged visible intent', async () => {
  for (const leave of [false, true]) {
    let receipt, reads = 0;
    const f = await setup((path, opts) => {
      if (path === '/api/create') { const input = JSON.parse(opts.body); receipt = { requestId: input.requestId, state: 'uncertain', verification: 'candidate', kind: 'create', threadId: null }; return { data: receipt }; }
      if (path === '/api/create/state') { if (receipt && ++reads >= 2) receipt = { ...receipt, state: 'delivered', verification: 'verified', threadId: 'verified-created' }; return { data: { request: receipt } }; }
    });
    await newPane(f); await f.el('newChatForm').onsubmit(event); assert.equal(f.ui.state.selected, 'fixture');
    if (leave) { f.el('closeNewChat').onclick(); await f.ui.openThread('other'); f.el('draft').value = '다른 대화의 새 초안'; f.el('draft').oninput(); }
    f.evaluate('state.creation.nextAt = 0'); await f.evaluate('foregroundReceipts()'); assert.equal(f.ui.state.creation.receipt.state, 'uncertain'); const before = f.calls.length;
    await f.evaluate('foregroundReceipts()'); assert.equal(f.calls.length, before); assert.ok(f.ui.state.creation.nextAt > Date.now());
    f.evaluate('state.creation.nextAt = 0'); await f.evaluate('foregroundReceipts()'); await waitFor(() => !f.ui.state.creation.checking);
    if (leave) { assert.equal(f.ui.state.selected, 'other'); assert.equal(f.el('draft').value, '다른 대화의 새 초안'); assert.equal(f.el('openCreated').hidden, false); }
    else await waitFor(() => f.ui.state.selected === 'verified-created');
    assert.equal(f.calls.filter(c => c.path === '/api/create').length, 1); assert.ok(!f.calls.some(c => c.path.includes('worktree') || c.path.includes('clientThreadId')));
  }
});
test('direct selectors follow saved next-send choices and failed source; pending selection stays immutable and controls stay locked', async () => {
  let release, input;
  const f = await setup((path, opts) => path === '/api/send' ? new Promise(done => { input = JSON.parse(opts.body); release = done; }) : null);
  await waitFor(() => !f.ui.state.models.flight); assert.equal(f.el('sendModel').value, '');
  f.el('sendModel').value = 'fixture-fast'; f.el('sendModel').onchange(); f.el('sendThinking').value = 'high'; f.el('sendThinking').onchange();
  assert.equal(f.ui.state.models.preferences.get('fixture').thinking, 'high'); assert.match(f.el('sendModel').attributes['aria-label'], /현재 PC 설정은 조회되지 않습니다/);
  const pending = f.el('composer').onsubmit(event); await waitFor(() => release); assert.equal(input.thinking, 'high');
  assert.equal(f.el('sendModel').disabled, true); assert.equal(f.el('sendThinking').disabled, true);
  f.el('sendModel').value = ''; f.el('sendModel').onchange(); assert.equal(f.ui.state.models.preferences.get('fixture').model, 'fixture-fast'); assert.equal(f.el('sendModel').value, 'fixture-fast');
  f.ui.state.models.preferences.set('fixture', { model: 'fixture-other', thinking: 'medium' }); f.ui.composerState(); assert.equal(f.ui.state.pending.selection.model, 'fixture-fast'); assert.equal(f.el('sendModel').value, 'fixture-other');
  release({ data: { requestId: input.requestId, threadId: 'fixture', state: 'delivered' } }); await pending; assert.equal(f.ui.state.models.preferences.get('fixture').model, 'fixture-other');
  await f.ui.openThread('other'); assert.equal(f.el('sendModel').value, ''); await f.ui.openThread('fixture'); assert.equal(f.el('sendModel').value, 'fixture-other');
  f.ui.state.models.result = null; f.ui.composerState(); assert.match(f.el('sendOptionsStatus').textContent, /자동 대체하지 않았습니다/); assert.equal(f.el('sendModel').attributes['aria-invalid'], 'true');
  f.ui.showPair(); assert.equal(f.el('sendModel').disabled, true); assert.equal(f.el('sendThinking').disabled, true); assert.equal(f.el('sendModel').value, '');
});
test('JSON body hangs obey the same deadline; a bounded read map cancels oldest flights; POSTs are separate and never retried', async () => {
  const f = await setup(); let body, posts = 0;
  f.hook(path => path === '/api/json-hang' ? { json: () => new Promise(done => { body = done; }) } : path === '/api/post-hang' ? (posts++, new Promise(() => {})) : path.startsWith('/api/cap-') ? new Promise(() => {}) : null);
  const pending = f.evaluate('api("/api/json-hang")'), failed = assert.rejects(pending, e => e.code === 'NETWORK'); await waitFor(() => body);
  [...f.timers.values()].filter(timer => timer.ms === 10000).at(-1).fn(); await failed; body({ ignored: true });
  await waitFor(() => f.evaluate('getFlights.size') === 0);
  const reads = Array.from({ length: 30 }, (_, n) => f.evaluate(`api("/api/cap-${n}").catch(e => e.code)`));
  assert.equal(f.evaluate('getFlights.size'), 24); assert.equal(await reads[0], 'STALE_RESPONSE'); assert.equal(await reads[5], 'STALE_RESPONSE');
  f.evaluate('cancelReads()'); assert.ok((await Promise.all(reads)).every(code => code === 'STALE_RESPONSE'));
  const post = f.evaluate('api("/api/post-hang", {text:"explicit"})'), postFailure = assert.rejects(post, e => e.code === 'NETWORK');
  await waitFor(() => posts === 1); [...f.timers.values()].filter(timer => timer.ms === 35000).at(-1).fn(); await postFailure;
  await f.windowEvents.get('online')(); assert.equal(posts, 1);
});
test('size/empty/count checks precede raw upload and an expired receipt blocks send without discarding the original File', async () => {
  const f = await setup(), oversized = new File(['x'], '큰.txt'); Object.defineProperty(oversized, 'size', { value: 20 * 1024 * 1024 + 1 });
  pick(f, [oversized]); pick(f, [new File([], '빈.txt')]); assert.equal(f.uploads.length, 0);
  const big = new File(['x'], '합계.txt'); Object.defineProperty(big, 'size', { value: 15 * 1024 * 1024 }); pick(f, [big, big, big]); assert.equal(f.uploads.length, 0);
  pick(f, [new File(['x'], '보관.txt')]); const r = complete(f); f.evaluate('attachments.rows("fixture")[0].upload.expiresAt = 0'); f.ui.composerState();
  assert.equal(f.el('send').disabled, true); await f.el('composer').onsubmit(event); assert.equal(f.evaluate('attachments.rows("fixture").length'), 1); assert.match(f.el('attachments').children[0].children[0].children[1].textContent, /만료/); assert.ok(r.handle);
});
test('verified creation after hidden or a newer draft never hijacks navigation; completion stays an explicit open action', async () => {
  for (const reason of ['hidden', 'new-draft', 'closed-reopened']) {
    let release, posted;
    const f = await setup((path, opts) => path === '/api/create' ? new Promise(done => { posted = JSON.parse(opts.body); release = done; }) : null);
    await newPane(f); const pending = f.el('newChatForm').onsubmit(event); await waitFor(() => release);
    if (reason === 'hidden') { f.document.hidden = true; f.events.get('visibilitychange')(); }
    if (reason === 'new-draft') { f.el('newPrompt').value = '새 초안 유지'; f.el('newPrompt').oninput(); }
    if (reason === 'closed-reopened') { f.el('closeNewChat').onclick(); await newPane(f); }
    release({ data: { kind: 'create', requestId: posted.requestId, state: 'delivered', verification: 'verified', threadId: 'actual-id' } }); await pending;
    assert.equal(f.ui.state.selected, 'fixture'); assert.equal(f.el('openCreated').hidden, false);
    if (reason === 'new-draft') assert.equal(f.el('newPrompt').value, '새 초안 유지');
    assert.equal(f.calls.filter(c => c.path === '/api/create').length, 1);
  }
});
