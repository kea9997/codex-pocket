import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { browser, deviceStorage } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';
const media = { state: 'ready', kind: 'video', url: '/api/media/' + 'v'.repeat(43) };
const file = { state: 'ready', url: '/api/files/' + 'f'.repeat(43), name: '결과 영상.mp4', mime: 'video/mp4' };
async function setup(options) {
  const f = await browser(options); let text = '진행';
  f.hook(path => path.endsWith('/history') ? { data: { data: [{ id: 'current', status: 'inProgress', items: [{ id: 'a', type: 'agentMessage', text, images: [{ start: 0, end: text.length, media }], files: [{ file }] }] }], status: 'active', nextCursor: null } } : null);
  await f.ui.refreshCurrent();
  return { ...f, text: value => { text = value; } };
}
test('result actions use only opaque authenticated attachment URLs; native capability chooses narrow save/share links on user click, browser share/update feedback is explicit', async () => {
  const f = await setup(), ui = [...f.ui.state.historyNodes.values()].find(ui => ui.files?.size), box = [...ui.files.values()][0];
  const [save, share] = box.children[1].children;
  assert.equal(save.href, file.url); assert.equal(share.href, file.url);
  save.onclick({ preventDefault() { throw new Error('Browser download must remain usable'); } }); assert.equal(save.attributes.download, file.name);
  let prevented = false; share.onclick({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.match(box.children[0].textContent, /v0.2/);
  f.windowEvents.get('codexNative')({ detail: { version: 2, monitor: true, message: '확인 중' } });
  save.onclick({ preventDefault() { throw 0; } }); assert.equal(save.href, '/native/files/save/' + 'f'.repeat(43));
  share.onclick({ preventDefault() { throw 0; } }); assert.equal(share.href, '/native/files/share/' + 'f'.repeat(43));
  assert.equal(save.attributes.download, undefined); assert.ok(!f.calls.some(c => c.path.startsWith('/native/')));
  assert.equal(f.el('monitorStart').hidden, true); assert.equal(f.el('monitorStop').hidden, false);
});
test('old APK does not pretend to save/share; file retry reads its original older cursor without changing newer video/source/draft or latest cursor chain', async () => {
  const f = await setup({ userAgent: 'Android CodexPhone/1' }), ui = [...f.ui.state.historyNodes.values()].find(ui => ui.files?.size), box = [...ui.files.values()][0];
  let prevented = false; box.children[1].children[0].onclick({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); assert.match(box.children[0].textContent, /v0.2/);
  const video = [...f.ui.state.videos][0]; video.currentTime = 0.6; await video.play(); const detached = video.detachCount;
  const old = { id: 'older', pageCursor: 'actual/older cursor', status: 'completed', items: [{ id: 'older-file', type: 'agentMessage', text: '이전 결과', files: [{ file }] }] };
  f.ui.state.turns = new Map([[old.id, old], ...f.ui.state.turns]); f.ui.state.historyCursor = 'latest-chain'; f.el('draft').value = '보존 초안';
  f.hook(path => path.endsWith('/history') ? { data: { data: [f.ui.state.turns.get('current')], nextCursor: 'latest-chain', status: 'active' } } : path.includes('/history?cursor=') ? { data: { data: [old], nextCursor: null } } : null);
  await f.ui.refreshCurrent(); const olderUi = [...f.ui.state.historyNodes.values()].find(ui => ui.pageCursor === old.pageCursor), olderBox = [...olderUi.files.values()][0];
  await olderBox.children[1].children[2].onclick();
  assert.ok(f.calls.some(c => c.path === '/api/threads/fixture/history?cursor=actual%2Folder%20cursor')); assert.equal(f.ui.state.historyCursor, 'latest-chain'); assert.equal(f.el('draft').value, '보존 초안');
  assert.equal(video.currentTime, 0.6); assert.equal(video.paused, false); assert.equal(video.detachCount, detached); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('native permission/offline/transfer progress/cancel/failure statuses remain truthful and cannot send, reset composer or detach playing video during changed polls', async () => {
  const f = await setup(), video = [...f.ui.state.videos][0]; video.currentTime = 0.48; await video.play(); const detached = video.detachCount;
  f.el('draft').value = '파일과 무관한 한글 초안';
  for (const detail of [
    { version: 2, monitor: false, message: '알림 권한이 없어 화면 밖 알림은 꺼져 있습니다.' },
    { version: 2, transfer: '파일 받는 중 · 50%', transferDone: false },
    { version: 2, transfer: '파일 처리를 취소했습니다.', transferDone: true },
    { version: 2, transfer: '저장·공유를 완료하지 못했습니다.', transferDone: true }
  ]) { f.windowEvents.get('codexNative')({ detail }); f.text('바뀐 진행 메시지'); await f.ui.refreshCurrent(); }
  assert.equal(f.el('draft').value, '파일과 무관한 한글 초안'); assert.equal(video.currentTime, 0.48); assert.equal(video.paused, false); assert.equal(video.detachCount, detached);
  assert.equal(f.el('cancelTransfer').hidden, true); assert.match(f.el('transferStatus').textContent, /완료하지 못/); assert.equal(f.ui.state.nativeMonitor, false);
  assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('actual native delivery expression returns false before production listener exists, true only after listener-ready; warm original-ID navigation is readonly and new document never inherits readiness', async () => {
  const activity = readFileSync(new URL('../android/app/src/main/java/kr/optiwork/codexphone/MainActivity.java', import.meta.url), 'utf8');
  const literal = /OPEN_THREAD_SCRIPT = ("[^\n]+");/.exec(activity)[1], script = id => JSON.parse(literal).replace('%s', JSON.stringify(id));
  const cold = vm.createContext({ window: {} }); assert.equal(vm.runInContext(script('cold-thread'), cold), false);
  const f = await browser({ selected: false }); await waitFor(() => !f.ui.state.booting); assert.equal(f.window.codexPhoneReady, true);
  f.el('draft').value = '별도 초안'; assert.equal(f.evaluate(script('cold-thread')), true); await waitFor(() => f.ui.state.selected === 'cold-thread' && !f.ui.state.restoring);
  assert.equal(f.evaluate(script('warm-thread')), true); await waitFor(() => f.ui.state.selected === 'warm-thread' && !f.ui.state.restoring);
  assert.ok(f.calls.some(c => c.path === '/api/threads/cold-thread/history')); assert.ok(f.calls.some(c => c.path === '/api/threads/warm-thread/history'));
  assert.equal(vm.runInContext(script('new-document-thread'), vm.createContext({ window: {} })), false);
  assert.ok(!f.calls.some(c => c.path === '/api/send' || c.path.endsWith('/acknowledge')));
});
test('stopped native monitor signal replaces starting text after service failure, session401 or permission stop rather than leaving stale UI', async () => {
  const f = await browser();
  for (const stop of ['서비스 시작 실패', '401', '권한 해제']) {
    f.windowEvents.get('codexNative')({ detail: { version: 2, monitor: false, message: '화면 밖 알림을 시작합니다.' } });
    f.windowEvents.get('codexNative')({ detail: { version: 2, monitor: false, message: '화면 밖 알림은 꺼져 있습니다. 필요할 때 직접 켜 주세요.' } });
    assert.equal(f.el('monitorStart').hidden, false, stop); assert.equal(f.el('monitorStop').hidden, true, stop); assert.doesNotMatch(f.el('nativeStatus').textContent, /시작합니다/);
  }
});
test('notification tap during boot receipt recovery remains deferred until pending lookup finishes, then opens its original thread without clearing uncertainty or sending', async () => {
  const session = deviceStorage(), requestId = '11111111-1111-4111-8111-111111111111'; let release;
  session.setItem('codex-phone-pending', JSON.stringify({ threadId: 'fixture', requestId, storageScope: 'a'.repeat(64) }));
  const f = await browser({ selected: false, session, requestHook: async path => {
    if (path === '/api/requests/' + requestId) { await new Promise(resolve => { release = resolve; }); return { data: { requestId, threadId: 'fixture', state: 'uncertain' } }; }
  } });
  await waitFor(() => Boolean(release)); assert.equal(f.ui.state.booting, true);
  f.windowEvents.get('codexOpenThread')({ detail: { threadId: 'notification-thread' } }); assert.equal(f.ui.state.selected, 'fixture');
  release(); await waitFor(() => !f.ui.state.booting && !f.ui.state.restoring && f.ui.state.selected === 'notification-thread');
  assert.equal(f.ui.state.pending.requestId, requestId); assert.ok(f.calls.some(c => c.path === '/api/threads/notification-thread/history')); assert.ok(!f.calls.some(c => c.path === '/api/send' || c.path.endsWith('/acknowledge')));
});
test('same live WebView session switch removes old visible history/drafts/favorites/pending and ignores late responses; notification deep link opens original ID readonly', async () => {
  const f = await browser({ selected: false }); await f.ui.openThread('fixture'); f.el('draft').value = '이전 연결의 비공개 초안'; f.ui.persistDevice(true);
  f.ui.state.favorites = [{ id: 'fixture', title: '이전 연결' }];
  f.hook(path => path === '/api/session' ? { data: { csrf: 'new-csrf', storageScope: 'b'.repeat(64) } } : null);
  await f.ui.boot(); assert.equal(f.ui.state.selected, null); assert.equal(f.el('messages').children.length, 0); assert.equal(f.el('draft').value, ''); assert.equal(f.ui.state.drafts.size, 0); assert.equal(f.ui.state.favorites.length, 0);
  f.windowEvents.get('codexOpenThread')({ detail: { threadId: '../../not-a-thread' } }); assert.equal(f.ui.state.selected, null);
  f.windowEvents.get('codexOpenThread')({ detail: { threadId: 'original-thread' } }); await waitFor(() => f.ui.state.selected === 'original-thread' && !f.ui.state.restoring);
  assert.ok(f.calls.some(c => c.path === '/api/threads/original-thread/history')); assert.ok(!f.calls.some(c => c.path === '/api/send' || c.path.endsWith('/acknowledge')));
});
