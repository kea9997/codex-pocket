import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';
import { optionsView } from './options-fixture.mjs';
async function setup(userAgent = '') {
  const f = await browser({ selected: false, userAgent, requestHook: path => path === '/api/options' ? { data: optionsView() } : null }); await waitFor(() => !f.ui.state.booting && !f.ui.state.creation.checking); await f.ui.openThread('fixture');
  f.el('draft').value = '유지할 초안'; f.el('draft').oninput(); return f;
}
function pick(f, count = 3) {
  f.el('attachFiles').click(); const input = f.el('attachmentPicker'); input.files = Array.from({ length: count }, (_, n) => new File(['abc'], `파일${n}.txt`)); input.onchange();
}
function complete(f, index, expiresAt = Date.now() + 86400000) {
  f.uploads[index].respond({ handle: String.fromCharCode(107 + index).repeat(43), sha256: String(index + 1).repeat(64), size: 3, expiresAt });
}
const upload = (f, row = 0) => f.evaluate(`attachments.upload('fixture', attachments.rows('fixture')[${row}])`);
const row = (f, n = 0) => f.el('attachments').children[n];
test('explicit retry waits behind two active uploads, then runs exactly once; completed/active/removing cannot upload twice', async () => {
  const f = await setup(); pick(f); assert.equal(f.uploads.length, 2);
  f.uploads[0].onerror(); assert.equal(f.uploads.length, 3); row(f).children[1].onclick();
  assert.equal(f.uploads.length, 3); assert.equal(f.evaluate('attachments.rows("fixture")[0].status'), 'waiting'); assert.match(row(f).children[0].children[1].textContent, /차례/);
  upload(f); upload(f, 1); assert.equal(f.uploads.length, 3);
  complete(f, 1); assert.equal(f.uploads.length, 4); upload(f, 1); upload(f); assert.equal(f.uploads.length, 4);
  complete(f, 2); complete(f, 3); for (let n = 0; n < 3; n++) upload(f, n); assert.equal(f.uploads.length, 4);
  let release; f.hook(path => path.endsWith('/cancel') ? new Promise(done => { release = done; }) : null);
  const removing = row(f).children[2].onclick(); await waitFor(() => release); upload(f); assert.equal(f.uploads.length, 4); release({ data: { removed: true } }); await removing;
  assert.equal(f.el('draft').value, '유지할 초안'); assert.ok(!f.calls.some(c => ['/api/send', '/api/create'].includes(c.path)));
});
test('waiting cancellation/removal survive failure and thread switching; six files still finish at most two at a time', async () => {
  const f = await setup(); pick(f, 6); row(f, 2).children[1].onclick(); assert.equal(f.evaluate('attachments.rows("fixture")[2].status'), 'cancelled');
  await row(f, 3).children[2].onclick(); assert.equal(f.evaluate('attachments.rows("fixture").length'), 5);
  f.uploads[0].onerror(); assert.equal(f.uploads.length, 3); await f.ui.openThread('other'); complete(f, 1); assert.equal(f.uploads.length, 4); assert.equal(f.el('attachments').children.length, 0);
  complete(f, 2); complete(f, 3); assert.equal(f.uploads.length, 4); await f.ui.openThread('fixture');
  assert.equal(f.evaluate('attachments.rows("fixture")[0].status'), 'error'); assert.equal(f.evaluate('attachments.rows("fixture")[2].status'), 'cancelled');
  const g = await setup(); pick(g, 6); for (let n = 0; n < 6; n++) { assert.ok(g.evaluate('[...attachments.groups.values()].flat().filter(r => r.xhr).length') <= 2); complete(g, n); }
  assert.equal(g.uploads.length, 6); assert.equal(g.evaluate('attachments.ready("fixture")'), true);
});
test('expired ready handle is visibly blocked with explicit reupload, no online replay; busy/type failures use useful Korean', async () => {
  const f = await setup(); pick(f, 1); complete(f, 0, Date.now() - 1);
  assert.equal(f.el('send').disabled, true); assert.match(row(f).children[0].children[1].textContent, /보관 만료/); assert.equal(row(f).children[1].hidden, false);
  await f.windowEvents.get('online')(); assert.equal(f.uploads.length, 1); row(f).children[1].onclick(); assert.equal(f.uploads.length, 2); assert.equal(f.evaluate('attachments.rows("fixture")[0].file.name'), '파일0.txt');
  f.uploads[1].respond({ error: 'UPLOAD_BUSY' }, 429); assert.match(row(f).children[0].children[1].textContent, /다른 파일/);
  row(f).children[1].onclick(); f.uploads[2].respond({ error: 'UPLOAD_SIGNATURE' }, 415); assert.match(row(f).children[0].children[1].textContent, /실제 내용/); assert.ok(!row(f).children[0].children[1].textContent.includes('signature'));
  assert.equal(f.el('draft').value, '유지할 초안');
});
test('old/unknown native shells explicitly require app update instead of silently cancelled picker; 0.3.0 and browsers keep picker', async () => {
  for (const agent of ['CodexPhone/2 CodexPhoneApp/0.2.1', 'CodexPhone/2', 'CodexPhone/2 CodexPhoneApp/0.3.0', 'Mozilla/5.0 Chrome/140']) {
    const f = await setup(agent); f.el('attachFiles').click();
    if (agent === 'CodexPhone/2' || agent.includes('/0.2.1')) {
      assert.match(f.el('attachFiles').textContent, /업데이트 필요/); assert.match(f.el('attachmentStatus').textContent, /v0.3.0 이상/); assert.equal(f.el('attachmentPicker').pickKey, undefined);
      await f.el('newChat').onclick(); await waitFor(() => !f.ui.state.models.flight && !f.ui.state.creation.checking); f.el('attachNewFiles').click(); assert.match(f.el('newAttachmentStatus').textContent, /업데이트/); assert.equal(f.el('newAttachmentPicker').pickKey, undefined);
    } else assert.equal(f.el('attachmentPicker').pickKey, 'fixture');
    assert.equal(f.uploads.length, 0);
  }
});
