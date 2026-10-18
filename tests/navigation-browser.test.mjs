import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browser, deviceStorage } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';
import { optionsView } from './options-fixture.mjs';

const back = f => f.window.codexPhoneBack();
const root = f => { f.advance(400); const proof = back(f); assert.match(proof, /^root:\d+:\d+$/); assert.equal(f.window.codexPhoneConfirmBack(proof), true); return proof; };
async function setup(options = {}) {
  const f = await browser({ selected: false, ...options });
  await waitFor(() => !f.ui.state.booting && !f.ui.state.restoring && !f.ui.state.usage.flight);
  return f;
}
const nativeSource = readFileSync(new URL('../android/app/src/main/java/kr/optiwork/codexphone/MainActivity.java', import.meta.url), 'utf8');
const script = name => {
  const expression = nativeSource.match(new RegExp(`String ${name} = (.*);`))[1];
  // Same Java concatenation with the isolated fixture's generated build-time origin.
  return expression.split(' + org.json.JSONObject.quote(PocketConfig.ORIGIN) + ').map((part, i) => (i ? JSON.stringify('http://100.64.0.10:47831') : '') + JSON.parse(part)).join('');
};
const dispatch = (f, document = f.window.codexPhoneDocument) => f.evaluate(script('BACK_SCRIPT').replace('%s', JSON.stringify(document)));
const confirm = (f, proof, document = f.window.codexPhoneDocument) => f.evaluate(script('BACK_CONFIRM_SCRIPT').replace('%s', JSON.stringify(document)).replace('%p', JSON.stringify(proof)));

test('cold fragment without a saved selection is a real list, and notification deep-open builds its own prior list without sending', async () => {
  const f = await setup({ initialHash: '#conversation' });
  assert.equal(f.navigation.history.length, 1); assert.equal(f.navigation.location.hash, ''); assert.equal(f.navigation.history.state.view, 'list'); root(f);
  f.windowEvents.get('codexOpenThread')({ detail: { threadId: 'fixture' } });
  await waitFor(() => f.ui.state.selected === 'fixture' && !f.ui.state.restoring);
  assert.equal(f.navigation.history.length, 2); assert.equal(f.navigation.location.hash, '#conversation');
  const count = f.calls.length;
  assert.equal(dispatch(f), 'handled'); assert.equal(f.document.body.dataset.chat, 'false'); assert.equal(f.navigation.location.hash, '');
  assert.equal(dispatch(f), 'busy'); root(f);
  assert.equal(f.calls.length, count); assert.equal(f.navigation.rootExits, 0);
});

test('cold/restored conversations, with or without an initial fragment/history, Back to list preserving private draft and reading position', async () => {
  for (const initialHash of ['', '#conversation']) {
    const storage = deviceStorage(), session = deviceStorage(), first = await setup({ storage, session });
    await first.ui.openThread('fixture'); first.el('draft').value = '복원한 초안 👩🏽‍💻'; first.ui.persistDevice(true);
    const f = await setup({ storage, session, initialHash, asyncHistory: true });
    assert.equal(f.ui.state.selected, 'fixture'); assert.equal(f.el('draft').value, '복원한 초안 👩🏽‍💻');
    assert.equal(f.navigation.entries[0].hash, ''); assert.equal(f.navigation.history.length, 2); assert.equal(f.navigation.index, 1);
    f.el('history').scrollHeight = 1000; f.el('history').scrollTop = 300; f.ui.persistDevice(true);
    const savedPosition = JSON.stringify(f.ui.state.positions.get('fixture')); assert.equal(f.ui.state.positions.get('fixture').bottom, false);
    const count = f.calls.length;
    assert.equal(back(f), 'handled'); assert.equal(f.document.body.dataset.chat, 'false'); assert.equal(f.navigation.pending, 1);
    for (let n = 0; n < 10; n++) assert.equal(back(f), 'busy');
    assert.equal(f.navigation.pending, 1); assert.equal(f.navigation.rootExits, 0);
    f.navigation.flush(); assert.equal(f.navigation.location.hash, ''); root(f);
    assert.equal(f.ui.state.selected, 'fixture'); assert.equal(f.el('draft').value, '복원한 초안 👩🏽‍💻');
    assert.equal(JSON.stringify(f.ui.state.positions.get('fixture')), savedPosition);
    const restored = await setup({ storage, session, initialHash: '#conversation' });
    assert.equal(restored.el('draft').value, '복원한 초안 👩🏽‍💻');
    assert.equal(f.calls.length, count); assert.ok(!f.calls.some(c => c.path === '/api/send'));
  }
});

test('normal open/thread switch creates only one chat entry; screen list button and browser Back use semantic local navigation', async () => {
  for (const route of ['button', 'browser']) {
    const f = await setup(); await f.ui.openThread('fixture');
    f.el('draft').value = '첫 초안'; await f.ui.openThread('other'); f.el('draft').value = '두 번째 초안';
    assert.equal(f.navigation.history.length, 2);
    const count = f.calls.length;
    if (route === 'button') f.el('back').onclick(); else f.navigation.history.back();
    assert.equal(f.document.body.dataset.chat, 'false'); assert.equal(f.navigation.location.hash, '');
    assert.equal(f.ui.state.drafts.get('fixture'), '첫 초안'); assert.equal(f.ui.state.drafts.get('other'), '두 번째 초안');
    assert.equal(f.calls.length, count); assert.equal(f.navigation.rootExits, 0); root(f);
    // Browser Forward uses the already loaded conversation, never fetches/sends on traversal.
    f.navigation.history.forward(); assert.equal(f.document.body.dataset.chat, 'true'); assert.equal(f.el('draft').value, '두 번째 초안');
    assert.equal(f.calls.length, count);
  }
});

test('direct composer choices create no layer/history entry; semantic Back preserves the choice and goes straight to list without I/O', async () => {
  const f = await setup({ asyncHistory: true, requestHook: path => path === '/api/options' ? { data: optionsView() } : null });
  await f.ui.openThread('fixture'); await waitFor(() => !f.ui.state.models.flight);
  f.el('draft').value = '선택 후에도 남길 초안'; f.el('draft').oninput();
  const count = f.calls.length, length = f.navigation.history.length;
  f.el('sendModel').value = 'fixture-fast'; f.el('sendModel').onchange(); f.el('sendThinking').value = 'high'; f.el('sendThinking').onchange();
  assert.equal(f.ui.state.models.preferences.get('fixture').thinking, 'high'); assert.equal(f.navigation.history.length, length); assert.equal(Boolean(f.ui.state.tools.layer), false); assert.equal(f.calls.length, count);
  assert.equal(back(f), 'handled'); assert.equal(f.document.body.dataset.chat, 'false'); f.navigation.flush(); root(f);
  assert.equal(f.el('draft').value, '선택 후에도 남길 초안'); assert.equal(f.ui.state.models.preferences.get('fixture').thinking, 'high'); assert.equal(f.calls.length, count);
  f.navigation.history.forward(); f.navigation.flush(); assert.equal(f.document.body.dataset.chat, 'true'); assert.equal(f.el('sendModel').value, 'fixture-fast'); assert.equal(f.el('sendThinking').value, 'high'); assert.equal(f.calls.length, count);
});
test('image/copy/tool layer consumes exactly one asynchronous Back, then chat Back goes to list; rapid Back never skips to OS root', async () => {
  for (const id of ['imageDialog', 'copyDialog', 'toolsDialog']) {
    const f = await setup({ asyncHistory: true }); await f.ui.openThread('fixture');
    f.el('draft').value = '닫아도 남는 초안'; f.el('manualCopy').value = '이 메시지만'; f.el('largeImage').src = '/api/media/fixture';
    f.evaluate(`openToolLayer('${id}')`); assert.equal(f.el(id).open, true);
    const count = f.calls.length, epoch = f.ui.state.epoch;
    assert.equal(back(f), 'handled'); assert.equal(f.el(id).open, false); assert.equal(f.navigation.pending, 1);
    assert.equal(f.document.body.dataset.chat, 'true'); assert.equal(f.ui.state.epoch, epoch);
    f.advance(1000); for (let n = 0; n < 6; n++) assert.equal(back(f), 'busy');
    assert.equal(f.navigation.pending, 1); f.navigation.flush();
    assert.equal(f.ui.state.tools.layer, null); assert.equal(f.navigation.history.state.view, 'chat');
    if (id === 'copyDialog') assert.equal(f.el('manualCopy').value, '');
    if (id === 'imageDialog') assert.equal(f.el('largeImage').src, undefined);
    f.advance(400); assert.equal(back(f), 'handled'); assert.equal(back(f), 'busy');
    f.navigation.flush(); assert.equal(f.document.body.dataset.chat, 'false'); root(f);
    assert.equal(f.el('draft').value, '닫아도 남는 초안'); assert.equal(f.calls.length, count); assert.equal(f.navigation.rootExits, 0);
  }
});

test('browser Back and Escape close image/copy/tool layers without dismissing chat or issuing requests; forward never resurrects private modal text', async () => {
  for (const id of ['imageDialog', 'copyDialog', 'toolsDialog']) for (const method of ['browser', 'escape']) {
    const f = await setup(); await f.ui.openThread('fixture'); f.evaluate(`openToolLayer('${id}')`);
    f.el('manualCopy').value = '비공개 본문'; const count = f.calls.length;
    if (method === 'browser') f.navigation.history.back();
    else { let prevented = false; f.el(id).events.get('cancel')({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); }
    assert.equal(f.el(id).open, false); assert.equal(f.document.body.dataset.chat, 'true'); assert.equal(f.navigation.location.hash, '#conversation');
    assert.equal(f.calls.length, count);
    f.navigation.history.forward(); assert.equal(f.el(id).open, false); assert.equal(f.ui.state.tools.layer, null); assert.equal(f.calls.length, count);
  }
});

test('tool close/thread-open promise and rapid Back are serialized; a newer Back cancels the queued old open', async () => {
  const f = await setup({ asyncHistory: true }); await f.ui.openThread('fixture');
  f.el('toolSearch').onclick(); f.el('closeTools').onclick();
  const count = f.calls.length, pending = f.ui.openThread('other');
  f.el('toolResults').onclick(); // A queued pane switch must not reopen after the newer Back either.
  assert.equal(f.navigation.pending, 1); assert.equal(back(f), 'busy'); assert.equal(f.navigation.pending, 1);
  f.navigation.flush(); await pending;
  assert.equal(f.ui.state.selected, 'fixture'); assert.equal(f.navigation.history.state.view, 'chat'); assert.equal(f.calls.length, count);
  assert.equal(f.el('toolsDialog').open, false); assert.equal(f.ui.state.tools.layer, null);
  f.advance(400); f.el('back').onclick(); f.navigation.flush(); root(f);
});

test('Back cancels rendering/restoration after an already issued history response without another read, unread transition, send or draft loss', async () => {
  const f = await setup(); let release;
  f.hook(path => path.endsWith('/history') ? new Promise(resolve => { release = () => resolve({ data: { data: [], nextCursor: 'must-not-read', status: 'idle' } }); }) : null);
  const opening = f.ui.openThread('fixture'); await waitFor(() => release);
  f.el('draft').value = '읽는 중 입력'; const count = f.calls.length, activity = JSON.stringify([...f.ui.state.activity]);
  assert.equal(back(f), 'handled'); release(); await opening;
  assert.equal(f.document.body.dataset.chat, 'false'); assert.equal(f.ui.state.restoring, false); assert.equal(f.el('draft').value, '읽는 중 입력');
  assert.equal(f.calls.length, count); assert.equal(JSON.stringify([...f.ui.state.activity]), activity);
  assert.equal(f.ui.state.timer == null || !f.timers.has(f.ui.state.timer), true); root(f);
});

test('missing/corrupt same-document chat history falls back to a list replacement, never browser root traversal', async () => {
  const f = await setup(); f.ui.state.selected = 'fixture';
  f.document.body.dataset.chat = 'true'; f.navigation.location.hash = '#conversation';
  f.navigation.history.replaceState({}, '', '#conversation');
  const count = f.calls.length;
  assert.equal(back(f), 'handled'); assert.equal(f.document.body.dataset.chat, 'false'); assert.equal(f.navigation.location.hash, '');
  assert.equal(f.navigation.index, 0); assert.equal(f.navigation.history.length, 1); assert.equal(f.navigation.rootExits, 0); assert.equal(f.calls.length, count); root(f);
});

test('delayed root proof is rejected after layer/chat/auth/boot/logout/hidden transitions; logout plus pending popstate cannot restore private chat', async () => {
  const f = await setup({ asyncHistory: true }); const proof = root(f);
  f.evaluate("openToolLayer('toolsDialog')"); assert.equal(confirm(f, proof), false);
  f.el('closeTools').onclick(); f.navigation.flush(); f.advance(400); assert.equal(confirm(f, proof), false);
  const next = root(f); await f.ui.openThread('fixture'); assert.equal(confirm(f, next), false);
  f.evaluate("openToolLayer('copyDialog')"); f.el('closeCopy').onclick(); f.ui.showPair('만료');
  assert.equal(back(f), 'busy'); f.navigation.flush(); assert.equal(f.document.body.dataset.chat, 'false');
  f.advance(400); assert.equal(back(f), 'blocked'); assert.equal(confirm(f, next), false);
  await f.ui.boot(); await waitFor(() => !f.ui.state.booting); assert.equal(confirm(f, proof), false);
  if (f.document.body.dataset.chat === 'true') { f.advance(400); back(f); f.navigation.flush(); }
  const current = root(f); let release;
  f.hook(path => path === '/api/session' ? new Promise(resolve => { release = () => resolve({ data: { csrf: 'fixture-csrf', storageScope: 'a'.repeat(64) } }); }) : null);
  const booting = f.ui.boot(); await waitFor(() => release); assert.equal(back(f), 'blocked'); assert.equal(confirm(f, current), false);
  release(); await booting;
  const afterBoot = root(f);
  f.document.hidden = true; assert.equal(back(f), 'blocked'); assert.equal(confirm(f, afterBoot), false); f.document.hidden = false;
  f.hook(path => path === '/api/logout' ? new Promise(resolve => { release = () => resolve({ data: { revoked: true } }); }) : null);
  const logout = f.el('logout').onclick(); await waitFor(() => f.ui.state.loggingOut);
  assert.equal(back(f), 'blocked'); assert.equal(confirm(f, afterBoot), false); release(); await logout;
  assert.equal(f.ui.state.csrf, null); assert.equal(f.el('draft').value, ''); assert.equal(f.navigation.rootExits, 0);
});

test('Back preserves uncertain receipt/session locks without lookup, acknowledge or send, and old authenticated history cannot select a new-session chat', async () => {
  const f = await setup(); await f.ui.openThread('fixture');
  const pending = { threadId: 'fixture', requestId: '11111111-1111-4111-8111-111111111111' };
  f.ui.state.pending = pending; f.el('draft').value = '전송하지 않은 초안'; f.evaluate('savePending()');
  const csrf = f.ui.state.csrf, epoch = f.ui.state.authEpoch, receipt = f.evaluate("sessionStorage.getItem('codex-phone-pending')"), count = f.calls.length;
  assert.equal(back(f), 'handled');
  assert.equal(f.ui.state.pending, pending); assert.equal(f.ui.state.csrf, csrf); assert.equal(f.ui.state.authEpoch, epoch);
  assert.equal(f.evaluate("sessionStorage.getItem('codex-phone-pending')"), receipt); assert.equal(f.el('draft').value, '전송하지 않은 초안'); assert.equal(f.calls.length, count);
  const oldChatEntry = f.navigation.entries[1].state, oldDocument = f.window.codexPhoneDocument;
  f.ui.showPair('연결 변경'); await f.ui.boot(); await f.ui.openThread('other'); f.el('draft').value = '새 연결 초안';
  const nextCount = f.calls.length;
  assert.notEqual(f.window.codexPhoneDocument, oldDocument);
  assert.equal(dispatch(f, oldDocument), 'blocked'); assert.equal(f.document.body.dataset.chat, 'true'); assert.equal(f.calls.length, nextCount);
  // A stale forward/back entry from the previous pairing must not make the retained new selection visible.
  f.navigation.history.replaceState(oldChatEntry, '', '#conversation');
  f.windowEvents.get('popstate')({ state: oldChatEntry });
  assert.equal(f.document.body.dataset.chat, 'false'); assert.equal(f.navigation.history.state.view, 'list');
  assert.equal(f.navigation.history.state.authEpoch, f.ui.state.authEpoch); assert.equal(f.ui.state.selected, 'other');
  assert.equal(f.el('draft').value, '새 연결 초안'); assert.equal(f.calls.length, nextCount); assert.equal(f.navigation.rootExits, 0);
});
test('actual fixed native scripts reject unavailable listeners, other origins/paths/queries and replaced document tokens before routing', async () => {
  const f = await setup(); await f.ui.openThread('fixture'); const count = f.calls.length;
  assert.equal(f.evaluate(script('BACK_READY_SCRIPT')), f.window.codexPhoneDocument);
  for (const patch of [{ origin: 'https://other.invalid' }, { pathname: '/api/usage' }, { search: '?anything' }]) {
    const saved = { ...f.navigation.location }; Object.assign(f.navigation.location, patch);
    assert.equal(dispatch(f), 'blocked'); assert.equal(confirm(f, 'root:0:0'), false); assert.equal(f.evaluate(script('BACK_READY_SCRIPT')), null);
    Object.assign(f.navigation.location, saved);
  }
  f.window.codexPhoneReady = false; assert.equal(dispatch(f), 'blocked'); f.window.codexPhoneReady = true;
  const newer = await setup(); assert.notEqual(newer.window.codexPhoneDocument, f.window.codexPhoneDocument);
  assert.equal(dispatch(f, newer.window.codexPhoneDocument), 'blocked'); assert.equal(f.document.body.dataset.chat, 'true');
  assert.equal(f.calls.length, count); assert.equal(dispatch(f), 'handled'); const proof = root(f);
  assert.equal(confirm(f, proof, newer.window.codexPhoneDocument), false); assert.equal(confirm(f, proof), true);
});
