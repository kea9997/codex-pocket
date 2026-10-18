import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

const nodes = root => [root, ...(root.children ?? []).flatMap(child => typeof child === 'object' ? nodes(child) : [])];
const find = (f, tag) => nodes(f.el('messages')).filter(n => n.tagName === tag.toUpperCase());
const media = key => ({ state: 'ready', kind: 'video', url: '/api/media/' + key.repeat(43), alt: '생성 샘플 동영상' });
const movieItem = (suffix = '') => {
  const text = '앞 ![영상](<D:/space here/sample.mp4>) 뒤' + suffix;
  return { id: 'movie', type: 'agentMessage', text, images: [{ start: 2, end: text.indexOf(' 뒤'), media: media('a') }] };
};
const turn = (id, items = []) => ({ id, status: 'inProgress', items });
const page = data => ({ data, status: 'active', nextCursor: 'older-page' });
async function setup() {
  const f = await browser({ selected: false }); let latest = turn('current', [movieItem()]);
  f.hook(path => path.endsWith('/history') ? { data: page([latest]) } : path.includes('/history?') ? { data: page([turn('older', [{ id: 'old', type: 'agentMessage', text: '이전 기록' }])]) } : null);
  await f.ui.openThread('fixture');
  return { ...f, latest: value => { latest = value; } };
}
test('video DOM stays attached with unchanged/changed assistant text, new tools/turns and older pages; source/time/controls untouched', async () => {
  const f = await setup(), video = find(f, 'video')[0], parent = video.parent;
  assert.equal(video.controls, true); assert.equal(video.playsInline, true); assert.equal(video.preload, 'metadata'); assert.equal(video.autoplay, false);
  assert.equal(video.attributes.playsinline, ''); assert.equal(video.src, media('a').url);
  assert.equal(find(f, 'img').length, 0); assert.ok(!nodes(f.el('messages')).some(n => /D:\/space/.test(n.textContent)));
  await video.play(); video.currentTime = 0.42; let assignments = 0, src = video.src;
  Object.defineProperty(video, 'src', { configurable: true, get: () => src, set: value => { assignments++; src = value; } });
  const before = video.detachCount || 0;
  await f.ui.refreshCurrent();
  f.latest(turn('current', [movieItem(' 갱신'), { id: 'tool', type: 'commandExecution', text: '샘플 진행', status: 'inProgress' }]));
  await f.ui.refreshCurrent();
  f.latest(turn('current', [movieItem(' 계속 갱신'), { id: 'tool', type: 'commandExecution', text: '새 도구 출력', status: 'completed' }, { id: 'new-answer', type: 'agentMessage', text: '새 답변' }]));
  await f.ui.refreshCurrent(); await f.el('moreHistory').onclick();
  f.latest(turn('new-latest', [{ id: 'user', type: 'userMessage', text: '샘플 새 턴' }])); await f.ui.refreshCurrent();
  assert.equal(find(f, 'video')[0], video); assert.equal(video.parent, parent); assert.equal(video.currentTime, 0.42);
  assert.equal(video.detachCount || 0, before); assert.equal(assignments, 0); assert.equal(video.pauseCalls || 0, 0); assert.equal(video.playCalls, 1);
  assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('explicit video retry reloads only its target, preserves other playback/draft/cursor and gives codec/missing feedback', async () => {
  const f = await setup(); f.latest(turn('current', [movieItem(), { id: 'second', type: 'imageView', media: media('b') }, { id: 'missing', type: 'imageView', media: { state: 'unavailable', kind: 'video', error: 'MEDIA_MISSING' } }]));
  await f.ui.refreshCurrent(); const [failed, playing] = find(f, 'video'); await playing.play(); playing.currentTime = 0.6;
  failed.error = { code: 4 }; failed.onerror(); assert.ok(nodes(f.el('messages')).some(n => /코덱/.test(n.textContent)));
  assert.ok(nodes(f.el('messages')).some(n => /동영상 파일을 찾거나/.test(n.textContent)));
  f.el('draft').value = '유지할 한글 초안'; f.el('history').scrollTop = 21; const cursor = f.ui.state.historyCursor;
  await find(f, 'button').find(n => n.textContent === '동영상 다시 확인').onclick();
  const videos = find(f, 'video'); assert.notEqual(videos[0], failed); assert.equal(failed.src, undefined); assert.equal(videos[1], playing);
  assert.equal(playing.currentTime, 0.6); assert.equal(playing.paused, false); assert.equal(playing.pauseCalls || 0, 0);
  assert.equal(f.el('draft').value, '유지할 한글 초안'); assert.equal(f.el('history').scrollTop, 21); assert.equal(f.ui.state.historyCursor, cursor);
});
test('hidden/offline/disconnected playback pauses without auto-resume; back/other chat/logout release sources and retain chat draft', async () => {
  const f = await setup(); let video = find(f, 'video')[0]; await video.play();
  f.document.hidden = true; f.events.get('visibilitychange')(); assert.equal(video.paused, true);
  f.document.hidden = false; f.events.get('visibilitychange')(); await waitFor(() => !f.ui.state.refresh);
  assert.equal(video.playCalls, 1); assert.equal(video.paused, true);
  await video.play(); f.windowEvents.get('offline')(); assert.equal(video.paused, true);
  f.windowEvents.get('online')(); await waitFor(() => !f.ui.state.refresh); assert.equal(video.playCalls, 2);
  await video.play(); f.ui.showError({ code: 'DESKTOP_DISCONNECTED' }); assert.equal(video.paused, true);
  await f.ui.refreshCurrent(); assert.equal(video.playCalls, 3); assert.equal(video.paused, true);
  f.el('draft').value = '보존할 한글 초안'; f.el('back').onclick(); assert.equal(video.src, undefined); assert.ok(video.loadCalls > 0);
  f.document.body.dataset.chat = 'true'; await f.ui.refreshCurrent(); assert.equal(video.src, media('a').url); assert.equal(video.playCalls, 3);
  await f.ui.openThread('other'); assert.equal(video.src, undefined); assert.equal(f.ui.state.drafts.get('fixture'), '보존할 한글 초안');
  await f.ui.openThread('fixture'); assert.equal(f.el('draft').value, '보존할 한글 초안'); video = find(f, 'video')[0];
  await video.play(); await f.el('logout').onclick(); assert.equal(video.src, undefined); assert.equal(video.paused, true); assert.equal(f.ui.state.videos.size, 0);
  assert.equal(find(f, 'video').length, 0); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
