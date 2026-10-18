import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

const media = { state: 'ready', url: '/api/media/' + 'a'.repeat(43), alt: '합성 이미지' };
const nodes = root => [root, ...(root.children || []).flatMap(n => typeof n === 'object' ? nodes(n) : [])];
const view = f => JSON.parse(f.evaluate('JSON.stringify({scale:imageView.scale,x:imageView.x,y:imageView.y,width:imageView.width,height:imageView.height,fitWidth:imageView.fitWidth,fitHeight:imageView.fitHeight,ready:imageView.ready,source:imageView.source,pointers:imageView.pointers.size,gesture:imageView.gesture,tap:imageView.tap,opener:!!imageView.opener})'));
function event(f, name, { id = 1, x = 150, y = 190, type = 'touch', ...rest } = {}) {
  const e = { pointerId: id, clientX: x, clientY: y, pointerType: type, button: 0, preventDefault() { this.prevented = true; }, ...rest };
  f.el('imageStage').events.get(name)(e); return e;
}
async function setup({ width = 280, height = 180, naturalWidth = 640, naturalHeight = 360, loaded = true, ...options } = {}) {
  const f = await browser({ selected: false, ...options });
  await waitFor(() => !f.ui.state.booting && !f.ui.state.usage.flight);
  await f.ui.openThread('fixture');
  f.el('imageStage').rect = { left: 10, top: 100, width, height };
  f.el('largeImage').naturalWidth = naturalWidth; f.el('largeImage').naturalHeight = naturalHeight;
  await f.evaluate(`openImage(${JSON.stringify(media)}, '합성 이미지', document.getElementById('imageOpener'))`);
  if (loaded) f.el('largeImage').onload();
  return f;
}
function assertClean(f) {
  const v = view(f);
  assert.equal(v.ready, false); assert.equal(v.source, null); assert.equal(v.pointers, 0); assert.equal(v.gesture, null); assert.equal(v.tap, null); assert.equal(v.opener, false);
  assert.equal(v.scale, 1); assert.equal(v.x, 0); assert.equal(v.y, 0); assert.equal(v.fitWidth, 0);
  assert.equal(f.el('largeImage').src, undefined); assert.equal(f.el('largeImage').onload, null); assert.equal(f.el('largeImage').onerror, null);
  assert.equal(f.el('imageStage').captures?.size || 0, 0);
  for (const id of ['imageZoomIn', 'imageZoomOut', 'imageFit']) assert.equal(f.el(id).disabled, true);
}

test('fit is aspect-preserving and never initially upscales; real transforms reach bounded 600%, pan clamps and fit resets without source reload', async () => {
  const f = await setup(); const source = f.el('largeImage').src, count = f.calls.length;
  assert.equal(view(f).fitWidth, 280); assert.equal(view(f).fitHeight, 157.5); assert.equal(view(f).scale, 1);
  assert.equal(f.el('largeImage').style.transform, 'translate(0px, 11.25px) scale(1)');
  assert.equal(f.el('imageZoomOut').disabled, true); assert.equal(f.el('imageFit').disabled, true); assert.equal(f.el('imageZoomIn').disabled, false);
  f.el('imageZoomIn').onclick(); assert.equal(view(f).scale, 1.5); assert.match(f.el('largeImage').style.transform, /scale\(1.5\)/); assert.equal(f.el('imageZoom').textContent, '150%');
  for (let n = 0; n < 20; n++) f.el('imageZoomIn').onclick();
  assert.equal(view(f).scale, 6); assert.equal(f.el('imageZoomIn').disabled, true); assert.equal(f.el('imageZoom').textContent, '600%');
  event(f, 'pointerdown', { type: 'mouse' }); event(f, 'pointermove', { type: 'mouse', x: 10000, y: -10000 });
  assert.equal(view(f).x, 700); assert.equal(view(f).y, -382.5);
  event(f, 'pointerup', { type: 'mouse', x: 10000, y: -10000 }); assert.equal(view(f).pointers, 0);
  f.el('imageFit').onclick(); assert.equal(view(f).scale, 1); assert.equal(view(f).x, 0); assert.equal(view(f).y, 0);
  for (let n = 0; n < 20; n++) f.el('imageZoomOut').onclick(); assert.equal(view(f).scale, 1);
  assert.equal(f.el('largeImage').src, source); assert.equal(f.calls.length, count);
  const small = await setup({ naturalWidth: 100, naturalHeight: 50 });
  assert.equal(view(small).fitWidth, 100); small.evaluate('zoomImage(2)');
  event(small, 'pointerdown'); event(small, 'pointermove', { x: 999, y: 999 });
  assert.equal(view(small).x, 0); assert.equal(view(small).y, 0); assert.match(small.el('largeImage').style.transform, /translate\(40px, 40px\) scale\(2\)/);
});
test('two-pointer pinch tracks distance and midpoint; pinch-to-pan rebases without a jump, third touches are ignored and cancellation releases all captures', async () => {
  const f = await setup();
  event(f, 'pointerdown', { id: 1, x: 110 }); event(f, 'pointerdown', { id: 2, x: 190 });
  assert.equal(view(f).pointers, 2); assert.equal(f.el('imageStage').captures.size, 2);
  assert.equal(event(f, 'pointerdown', { id: 3 }).prevented, undefined); assert.equal(view(f).pointers, 2);
  event(f, 'pointermove', { id: 2, x: 270 }); assert.equal(view(f).scale, 2); assert.equal(view(f).x, 40);
  event(f, 'pointermove', { id: 1, x: 30 }); assert.equal(view(f).scale, 3); assert.equal(view(f).x, 0);
  event(f, 'pointerup', { id: 2, x: 270 }); event(f, 'pointermove', { id: 1, x: 70 }); assert.equal(view(f).x, 40); assert.equal(view(f).scale, 3);
  event(f, 'pointercancel', { id: 1 }); assert.equal(view(f).pointers, 0); assert.equal(f.el('imageStage').captures.size, 0); assert.equal(view(f).tap, null);
  event(f, 'pointermove', { id: 1, x: 900 }); assert.equal(view(f).x, 40);
  event(f, 'pointerdown', { id: 4 }); event(f, 'lostpointercapture', { id: 4 }); assert.equal(view(f).pointers, 0);
  event(f, 'pointerdown', { id: 1, x: 149 }); event(f, 'pointerdown', { id: 2, x: 151 });
  event(f, 'pointermove', { id: 2, x: 10000 }); assert.equal(view(f).scale, 6);
  event(f, 'pointermove', { id: 2, x: 149 }); assert.equal(view(f).scale, 1); assert.equal(view(f).x, 0);
});
test('touch double tap and desktop double click toggle useful anchored zoom/reset without synthetic double toggles; drags are not taps and keyboard works', async () => {
  const f = await setup();
  const tap = () => { event(f, 'pointerdown', { x: 200 }); event(f, 'pointerup', { x: 200 }); };
  tap(); f.advance(120); tap(); assert.equal(view(f).scale, 2.5); assert.equal(view(f).x, -75);
  event(f, 'dblclick', { x: 200 }); assert.equal(view(f).scale, 2.5);
  f.advance(120); tap(); f.advance(120); tap(); assert.equal(view(f).scale, 1);
  f.advance(600); event(f, 'dblclick', { type: 'mouse' }); assert.equal(view(f).scale, 2.5);
  event(f, 'dblclick', { type: 'mouse' }); assert.equal(view(f).scale, 1);
  event(f, 'pointerdown'); event(f, 'pointermove', { x: 210 }); event(f, 'pointerup', { x: 210 });
  f.advance(100); tap(); assert.equal(view(f).scale, 1);
  event(f, 'keydown', { key: '+' }); assert.equal(view(f).scale, 1.5);
  event(f, 'keydown', { key: 'ArrowRight' }); assert.equal(view(f).x, -40);
  event(f, 'keydown', { key: 'Home' }); assert.equal(view(f).scale, 1);
  assert.equal(event(f, 'keydown', { key: 'Escape' }).prevented, undefined);
});
test('loading/error/source changes reject stale callbacks, clear gestures and private references, and never permit arbitrary media URLs', async () => {
  const f = await setup({ loaded: false });
  assert.equal(f.el('imageZoomIn').disabled, true); assert.equal(event(f, 'pointerdown').prevented, undefined);
  f.el('imageZoomIn').onclick(); assert.equal(view(f).scale, 1);
  const staleLoad = f.el('largeImage').onload, staleError = f.el('largeImage').onerror;
  const other = { ...media, url: '/api/media/' + 'b'.repeat(43) };
  await f.evaluate(`openImage(${JSON.stringify(other)}, '다른 합성 이미지')`);
  staleLoad(); staleError(); assert.equal(view(f).source, other.url); assert.equal(view(f).ready, false);
  f.el('largeImage').onload(); f.el('imageZoomIn').onclick(); event(f, 'pointerdown');
  const lateLoad = f.el('largeImage').onload; f.el('largeImage').onerror(); assertClean(f);
  assert.equal(f.el('imageDialog').open, true); assert.match(f.el('imageViewerStatus').textContent, /불러오지 못했습니다/);
  lateLoad(); assertClean(f);
  for (const url of ['https://other.invalid/a.png', 'file:///secret', '/api/media/not-an-opaque-handle']) {
    await f.evaluate(`openImage(${JSON.stringify({ ...media, url })}, '거부 대상')`); assertClean(f);
  }
});
test('late dialog close events cannot erase a newly opened image; zero geometry/invalid decode stay disabled and source writes are absent during zoom', async () => {
  const f = await setup({ asyncHistory: true });
  f.el('closeImage').onclick(); f.navigation.flush();
  await f.evaluate(`openImage(${JSON.stringify(media)}, '재개한 이미지')`); f.el('largeImage').onload();
  f.el('imageDialog').events.get('close')(); assert.equal(view(f).ready, true); assert.equal(f.el('largeImage').src, media.url);
  let writes = 0, source = f.el('largeImage').src;
  Object.defineProperty(f.el('largeImage'), 'src', { configurable: true, get: () => source, set: value => { writes++; source = value; } });
  f.el('imageZoomIn').onclick(); event(f, 'pointerdown'); event(f, 'pointermove', { x: 190 }); event(f, 'pointerup', { x: 190 }); f.el('imageFit').onclick();
  assert.equal(writes, 0); assert.equal(source, media.url);
  const zero = await setup({ width: 0, height: 0 }); zero.el('imageZoomIn').onclick(); assert.equal(view(zero).scale, 1); assert.equal(zero.el('imageZoomIn').disabled, true);
  zero.el('imageStage').rect.width = 280; zero.el('imageStage').rect.height = 180; zero.windowEvents.get('resize')(); assert.equal(zero.el('imageZoomIn').disabled, false);
  const invalid = await setup({ naturalWidth: 0 }); assertClean(invalid); assert.match(invalid.el('imageViewerStatus').textContent, /불러오지 못했습니다/);
});
test('resize/orientation resets to accessible fit and releases pointer capture; ResizeObserver handles layout-only changes and is disconnected on cleanup', async () => {
  const f = await setup();
  f.evaluate('globalThis.ResizeObserver = class { constructor(fn) { globalThis.observedImage = this; this.fn = fn; } observe(target) { this.target = target; } disconnect() { this.disconnected = true; this.target = null; } }');
  await f.evaluate(`openImage(${JSON.stringify(media)}, '합성 이미지')`); f.el('largeImage').onload();
  f.el('imageZoomIn').onclick(); event(f, 'pointerdown');
  f.el('imageStage').rect = { left: 10, top: 60, width: 180, height: 260 }; f.windowEvents.get('resize')();
  assert.equal(view(f).scale, 1); assert.equal(view(f).fitWidth, 180); assert.equal(view(f).fitHeight, 101.25); assert.equal(view(f).pointers, 0);
  f.el('imageStage').rect.width = 300; f.el('imageStage').rect.height = 120;
  f.evaluate('observedImage.fn()'); assert.ok(Math.abs(view(f).fitWidth - 120 * 640 / 360) < 1e-9); assert.equal(view(f).fitHeight, 120);
  const count = f.calls.length; f.el('closeImage').onclick(); assert.equal(f.evaluate('observedImage.disconnected'), true); assertClean(f); assert.equal(f.calls.length, count);
});
test('close, Escape, browser/native semantic Back, tool transitions, logout and pagehide clean zoom without losing draft/history or making reads', async () => {
  for (const method of ['button', 'escape', 'browser', 'native', 'tools', 'logout', 'pagehide']) {
    const f = await setup({ asyncHistory: true });
    f.el('draft').value = '확대해도 유지되는 초안'; f.el('history').scrollTop = 25;
    f.el('imageZoomIn').onclick(); event(f, 'pointerdown'); const count = f.calls.length;
    if (method === 'button') f.el('closeImage').onclick();
    else if (method === 'escape') f.el('imageDialog').events.get('cancel')({ preventDefault() {} });
    else if (method === 'browser') { f.navigation.history.back(); f.navigation.flush(); }
    else if (method === 'native') assert.equal(f.window.codexPhoneBack(), 'handled');
    else if (method === 'tools') f.el('chatTools').onclick();
    else if (method === 'logout') await f.el('logout').onclick();
    else f.windowEvents.get('pagehide')();
    assertClean(f);
    if (method === 'pagehide') { assert.equal(f.navigation.pending, 0); assert.match(f.el('imageViewerStatus').textContent, /다시 열어/); }
    else if (method !== 'logout') assert.equal(f.el('imageDialog').open, false);
    if (method !== 'logout') {
      assert.equal(f.el('draft').value, '확대해도 유지되는 초안'); assert.equal(f.el('history').scrollTop, 25); assert.equal(f.document.body.dataset.chat, 'true'); assert.equal(f.calls.length, count);
      if (method === 'button' || method === 'escape' || method === 'browser' || method === 'native') assert.equal(f.document.activeElement, f.el('imageOpener'));
    } else assert.equal(f.el('draft').value, '');
    if (f.navigation.pending) f.navigation.flush();
  }
});
test('queued viewer open is cancelled by newer Back/auth changes; image zoom never reloads retained video/file nodes or changes source/draft on polls', async () => {
  const f = await browser({ selected: false, asyncHistory: true });
  await waitFor(() => !f.ui.state.booting && !f.ui.state.usage.flight);
  f.hook(path => path.endsWith('/history') ? { data: { data: [{ id: 'media', status: 'completed', items: [
    { id: 'image', type: 'imageView', media }, { id: 'video', type: 'imageView', media: { ...media, kind: 'video', url: '/api/media/' + 'v'.repeat(43) } },
    { id: 'file', type: 'agentMessage', text: '합성 파일', files: [{ file: { state: 'ready', url: '/api/files/' + 'f'.repeat(43), name: '합성.pdf' } }] }
  ] }], status: 'idle', nextCursor: null } } : null);
  await f.ui.openThread('fixture');
  f.el('imageStage').rect = { left: 0, top: 0, width: 280, height: 180 }; f.el('largeImage').naturalWidth = 640; f.el('largeImage').naturalHeight = 360;
  const video = nodes(f.el('messages')).find(n => n.tagName === 'VIDEO'), file = [...f.ui.state.historyNodes.values()].find(n => n.assets?.some(a => a.kind === 'file')).root;
  await video.play(); video.currentTime = 0.4; const detached = video.detachCount, loads = video.loadCalls;
  const img = nodes(f.el('messages')).find(n => n.tagName === 'IMG'); img.onload();
  const large = nodes(f.el('messages')).find(n => n.textContent === '크게 보기'); large.onclick(); f.el('largeImage').onload(); f.el('imageZoomIn').onclick();
  f.el('draft').value = '동영상도 보존'; await f.ui.refreshCurrent();
  assert.equal(video.currentTime, 0.4); assert.equal(video.paused, false); assert.equal(video.loadCalls, loads); assert.equal(video.detachCount, detached); assert.equal(nodes(f.el('messages')).find(n => n.tagName === 'VIDEO'), video);
  assert.equal([...f.ui.state.historyNodes.values()].find(n => n.assets?.some(a => a.kind === 'file')).root, file); assert.equal(f.el('largeImage').src, media.url); assert.equal(view(f).scale, 1.5);
  f.el('closeImage').onclick(); const queued = f.evaluate(`openImage(${JSON.stringify(media)}, '취소될 열기')`);
  assert.equal(f.window.codexPhoneBack(), 'busy'); f.navigation.flush(); await queued; assertClean(f); assert.equal(f.el('imageDialog').open, false);
  f.advance(400); await f.evaluate(`openImage(${JSON.stringify(media)}, '다시 열기')`); f.el('closeImage').onclick();
  const old = f.evaluate(`openImage(${JSON.stringify(media)}, '만료된 열기')`); f.ui.showPair(); f.navigation.flush(); await old; assertClean(f);
});
test('shipped image viewer scopes touch-action to its clipped stage and keeps 44px labelled controls outside the transform with viewport-bounded layout', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(html, /id="imageStage"[^>]*tabindex="0"[^>]*aria-describedby="imageZoomHelp"/);
  for (const label of ['이미지 축소', '이미지 확대', '화면 맞춤 기준 확대율', '화면 맞춤']) assert.ok(html.includes(label));
  assert.match(html, /id="largeImage"[^>]*draggable="false"[^>]*hidden/);
  assert.match(css, /\.image-dialog\{[^}]*height:min\(800px,calc\(var\(--app-height,100dvh\) - 24px\)\)[^}]*overflow:hidden/);
  assert.match(css, /\.image-dialog\[open\]\{display:flex;flex-direction:column/);
  assert.match(css, /\.image-dialog button\{[^}]*min-height:44px/);
  assert.match(css, /\.image-stage\{[^}]*flex:1;min-height:0;min-width:0;overflow:hidden;touch-action:none/);
  assert.equal((css.match(/touch-action:none/g) || []).length, 1);
  assert.match(css, /\.image-stage img\{[^}]*max-width:none;max-height:none;transform-origin:0 0;pointer-events:none/);
  // Geometry/event/contract tests do not establish real browser layout or actual Fold6 pinch behavior.
});
