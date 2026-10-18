import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

function nodes(root) { return [root, ...(root.children ?? []).flatMap(child => typeof child === 'object' ? nodes(child) : [])]; }
const find = (f, tag) => nodes(f.el('messages')).filter(n => n.tagName === tag.toUpperCase());
const ready = { state: 'ready', url: '/api/media/' + 'a'.repeat(43), alt: '무대 샘플' };
const turn = (id, items = [], startedAt = null) => ({ id, startedAt, status: 'completed', items });
const page = (data, nextCursor = null, extra = {}) => ({ data, nextCursor, status: 'idle', ...extra });

test('real img DOM for imageView, Markdown and user images; failure/retry/larger view, unchanged polls and logout cleanup', async () => {
  const f = await browser({ selected: false });
  const text = '앞 ![무대](<D:/space here/frame.png>) 뒤';
  const imageTurn = turn('images', [
    { type: 'agentMessage', text, images: [{ start: 2, end: text.indexOf(' 뒤'), media: ready }] },
    { type: 'userMessage', text: '첨부', images: [ready] }, { type: 'imageView', media: ready },
    { type: 'imageView', media: { state: 'unavailable', error: 'MEDIA_TYPE_UNSUPPORTED' } },
    { type: 'imageView', media: { state: 'ready', url: 'https://invalid/x.png' } }
  ]);
  f.hook(path => path.endsWith('/history') ? { data: page([imageTurn], 'older') } : null);
  await f.ui.openThread('fixture');
  const images = find(f, 'img'); assert.equal(images.length, 3);
  assert.ok(images.every(img => img.src === ready.url && img.loading === 'lazy' && img.decoding === 'async'));
  assert.ok(nodes(f.el('messages')).some(n => /동영상은 PC/.test(n.textContent)));
  assert.ok(!nodes(f.el('messages')).some(n => n.textContent.includes('D:/space')));
  images[0].onerror(); assert.equal(images[0].hidden, true);
  assert.ok(nodes(f.el('messages')).some(n => /만료되었을 수/.test(n.textContent)));
  const retry = find(f, 'button').find(n => n.textContent === '이미지 다시 확인');
  f.el('draft').value = '보존 초안'; f.el('history').scrollTop = 18; const cursor = f.ui.state.historyCursor;
  await retry.onclick(); assert.equal(f.el('draft').value, '보존 초안'); assert.equal(f.ui.state.historyCursor, cursor); assert.equal(f.el('history').scrollTop, 18);
  const current = find(f, 'img')[0]; current.onload(); assert.equal(current.hidden, false);
  const large = find(f, 'button').find(n => n.textContent === '크게 보기'); large.onclick();
  assert.equal(f.el('imageDialog').open, true); assert.equal(f.el('largeImage').src, ready.url); assert.equal(f.document.activeElement, f.el('closeImage'));
  const messages = f.el('messages').children[0]; large.focus(); await f.ui.refreshCurrent();
  assert.equal(f.el('messages').children[0], messages); assert.equal(f.document.activeElement, large);
  await f.el('logout').onclick(); assert.equal(f.el('imageDialog').open, false); assert.equal(f.el('largeImage').src, undefined);
  assert.equal(f.el('messages').children.length, 0); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('older-page image retry uses its exact cursor without resetting pagination/selection/draft; late retry cannot restore old conversation', async () => {
  const f = await browser({ selected: false });
  const older = turn('older', [{ type: 'imageView', media: { state: 'unavailable', error: 'MEDIA_MISSING' } }]);
  f.hook(path => path.endsWith('/history') ? { data: page([turn('latest')], 'actual + older') } : path.includes('/history?') ? { data: page([older], 'still-older') } : null);
  await f.ui.openThread('fixture'); await f.el('moreHistory').onclick();
  const retry = find(f, 'button').find(n => n.textContent === '이미지 다시 확인'); f.el('draft').value = '유지할 초안';
  await retry.onclick(); assert.equal(f.calls.at(-1).path, '/api/threads/fixture/history?cursor=actual%20%2B%20older');
  assert.equal(f.ui.state.historyCursor, 'still-older'); assert.equal(f.el('draft').value, '유지할 초안'); assert.equal(f.ui.state.selected, 'fixture');
  let release; f.hook(path => path.includes('/history?') ? new Promise(resolve => { release = resolve; }) : null);
  const pending = find(f, 'button').find(n => n.textContent === '이미지 다시 확인').onclick(); await waitFor(() => release);
  await f.ui.openThread('other'); release({ data: page([turn('older', [{ type: 'imageView', media: ready }])]) }); await pending;
  assert.equal(f.ui.state.selected, 'other'); assert.equal(find(f, 'img').length, 0); assert.equal(f.ui.state.drafts.get('fixture'), '유지할 초안');
});
test('single-turn cursor chain fills intervening turns after latest changes with no gaps/duplicates, even without timestamps', async () => {
  const f = await browser({ selected: false }); let latest = 3;
  f.hook(path => {
    if (!path.includes('/history')) return null;
    const cursor = path.includes('?cursor=') ? Number(path.split('=')[1].slice(1)) : latest;
    return { data: page([turn('t' + cursor)], cursor > 1 ? 'c' + (cursor - 1) : null) };
  });
  await f.ui.openThread('fixture'); await f.el('moreHistory').onclick(); await f.el('moreHistory').onclick();
  assert.deepEqual([...f.ui.state.turns.keys()], ['t1', 't2', 't3']);
  latest = 5; await f.ui.refreshCurrent(); assert.equal(f.ui.state.historyCursor, 'c4');
  while (f.ui.state.historyCursor) await f.el('moreHistory').onclick();
  assert.deepEqual([...f.ui.state.turns.keys()], ['t1', 't2', 't3', 't4', 't5']);
  assert.equal(f.ui.state.historyCursor, null); assert.ok(f.calls.some(c => c.path.endsWith('cursor=c4')));
});
test('late older page preserves new latest cursor chain and has no duplicates', async () => {
  const f = await browser({ selected: false }); let latest = 3, release;
  f.hook(path => {
    if (path.endsWith('/history')) return { data: page([turn('t' + latest, [], latest)], 'c' + (latest - 1)) };
    if (path.endsWith('cursor=c2')) return new Promise(resolve => { release = resolve; });
    if (path.endsWith('cursor=c4')) return { data: page([turn('t4', [], 4)], 'c3') };
    return null;
  });
  await f.ui.openThread('fixture'); const older = f.el('moreHistory').onclick(); await waitFor(() => release);
  latest = 5; await f.ui.refreshCurrent(); release({ data: page([turn('t2', [], 2)], 'c1') }); await older;
  assert.equal(f.ui.state.historyCursor, 'c4'); await f.el('moreHistory').onclick();
  assert.deepEqual([...f.ui.state.turns.keys()], ['t2', 't3', 't4', 't5']); assert.equal(f.ui.state.historyCursor, 'c3');
});
test('explicit minimal history limit stops automatic conversation polling, reports history not offline and manual recovery preserves draft', async () => {
  const f = await browser({ selected: false });
  f.hook(path => path.endsWith('/history') ? { status: 502, data: { error: 'HISTORY_SIZE_LIMIT' } } : null);
  await f.ui.openThread('fixture'); assert.match(f.el('connection').textContent, /기록 확인 필요/);
  assert.equal(f.ui.state.turns.size, 0); assert.equal(f.ui.state.timer, null);
  assert.ok(![...f.timers.values()].some(timer => timer.ms === 2000 || timer.ms === 8000));
  assert.ok(nodes(f.el('chatError')).some(n => /출력 생략으로도/.test(n.textContent)));
  f.el('draft').value = '아직 보내지 않은 초안'; f.hook(null); f.el('chatError').children[1].onclick();
  await waitFor(() => f.el('chatError').hidden); assert.equal(f.el('draft').value, '아직 보내지 않은 초안');
  assert.equal(f.ui.state.selected, 'fixture'); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
