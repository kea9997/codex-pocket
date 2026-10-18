import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreview } from '../tools/ui-preview.mjs';
import { assets } from '../server/http.mjs';
import { browser } from './browser-fixture.mjs';
import { httpCall, waitFor } from './helpers.mjs';

const nodes = root => [root, ...(root.children || []).flatMap(child => typeof child === 'object' ? nodes(child) : [])];
test('isolated preview exercises all five shipped conveniences, explicit update unavailable/recovery and transfer protection without any real writer', async t => {
  const server = createPreview(); await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, options = {}) => httpCall(server.address().port, path, { ...options, headers: { Host: '127.0.0.1:47832', Origin: 'http://127.0.0.1:47832', ...options.headers } });
  const post = (path, data = {}) => call(path, { method: 'POST', data });
  const html = (await call('/')).text;
  for (const id of ['sampleUpdate', 'sampleUpdateBlock', 'expandDraft', 'snippetForm', 'updatesPane', 'latestResponse']) assert.ok(html.includes(`id="${id}"`));
  for (const file of ['/app.js', '/convenience.js', '/markdown-blocks.js']) assert.equal((await call(file)).text, assets.get(file).data.toString());
  assert.equal((await post('/sample/update?')).status, 400); assert.equal((await post('/sample/update', { path: 'not allowed' })).status, 400);
  const f = await browser({ selected: false });
  f.hook(async (path, options) => {
    const r = await call(path, { method: options.method || 'GET', data: options.body, headers: { 'Content-Type': 'application/json', 'X-Codex-CSRF': 'sample-not-a-credential' } });
    return { status: r.status, data: r.json };
  });
  await f.ui.openThread('sample-11'); assert.equal(nodes(f.el('messages')).filter(n => n.tagName === 'TABLE').length, 1);
  f.el('expandDraft').onclick(); f.el('expandedDraft').value = '합성 긴 초안\n둘째 줄'; f.el('expandedDraft').oninput(); f.el('closeEditor').onclick();
  assert.equal(f.el('draft').value, '합성 긴 초안\n둘째 줄');
  f.el('toolQuick').onclick(); f.el('snippetLabel').value = '합성 내 지시'; f.el('snippetText').value = '검토만 해줘'; f.el('snippetForm').onsubmit({ preventDefault() {} });
  f.el('snippetList').children[0].apply.onclick(); assert.equal(f.el('draft').value, '합성 긴 초안\n둘째 줄\n\n검토만 해줘');
  await f.ui.openThread('sample-10'); const area = f.el('history'); area.scrollHeight = 3000; area.clientHeight = 400; area.scrollTop = 100; area.events.get('scroll')();
  await post('/sample/reveal'); await f.ui.refreshCurrent(); assert.equal(f.el('latestResponse').hidden, false); assert.equal(area.scrollTop, 100); f.el('latestResponse').onclick(); assert.equal(f.el('latestResponse').hidden, true);
  await waitFor(() => !f.ui.state.updates.flight); f.evaluate('globalThis.releaseNow = Date.now() + 10000; Date.now = () => releaseNow;');
  const retry = async () => { f.evaluate('releaseNow += 4000'); await f.el('retryUpdate').onclick(); };
  await post('/sample/update'); await retry(); assert.equal(f.el('applyUpdate').hidden, false); assert.equal(f.el('applyUpdate').disabled, false);
  f.window.dispatchEvent({ type: 'codexNative', detail: { transfer: '합성 전송', transferDone: false } }); f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, undefined); assert.match(f.el('updateStatus').textContent, /파일/);
  await post('/sample/update'); await retry(); assert.equal(f.el('applyUpdate').disabled, true); assert.match(f.el('updateStatus').textContent, /확인 불가/);
  await post('/sample/update'); await retry(); f.window.dispatchEvent({ type: 'codexNative', detail: { transfer: '합성 종료', transferDone: true } });
  f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, 1); f.el('applyUpdate').onclick(); assert.equal(f.navigation.location.reloads, 1);
  const saved = f.ui.durable.data.drafts.find(([id]) => id === 'sample-11'); assert.equal(saved[1], '합성 긴 초안\n둘째 줄\n\n검토만 해줘');
  assert.ok(f.calls.every(c => c.options.method !== 'POST')); assert.equal(f.ui.state.snippets.length, 1);
});
