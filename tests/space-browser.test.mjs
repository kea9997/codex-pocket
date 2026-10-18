import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

async function setup(options = {}) {
  const f = await browser({ asyncHistory: true, ...options });
  await waitFor(() => !f.ui.state.booting && f.ui.state.creation.checked);
  Object.assign(f.el('listMenu'), { tagName: 'DETAILS', open: false });
  Object.assign(f.el('listMenuToggle'), { tagName: 'SUMMARY' });
  f.el('listMenu').append(f.el('listMenuToggle'), f.el('listDiagnostics'), f.el('listUpdates'), f.el('logout'));
  f.advance(400);
  return f;
}
const writes = f => f.calls.filter(c => c.options.method === 'POST' && c.path !== '/api/accounts/presence');

test('list management disclosure consumes Escape or native Back locally, invalidates root proof and preserves the draft without history traversal or writes', async () => {
  for (const exit of ['escape', 'back']) {
    const f = await setup(), draft = f.el('draft').value, calls = f.calls.length;
    const proof = f.window.codexPhoneBack(); assert.match(proof, /^root:/);
    f.el('listMenuToggle').click(); assert.equal(f.el('listMenu').open, true);
    assert.equal(f.window.codexPhoneConfirmBack(proof), false);
    if (exit === 'escape') {
      let prevented = false; f.events.get('keydown')({ key: 'Escape', preventDefault() { prevented = true; } }); assert.equal(prevented, true);
    } else {
      assert.equal(f.window.codexPhoneBack(), 'handled'); assert.equal(f.window.codexPhoneBack(), 'busy');
    }
    assert.equal(f.el('listMenu').open, false); assert.equal(f.document.activeElement, f.el('listMenuToggle'));
    assert.equal(f.el('draft').value, draft); assert.equal(f.calls.length, calls); assert.equal(f.navigation.pending, 0);
    assert.equal(f.navigation.rootExits, 0); assert.equal(writes(f).length, 0);
  }
});

test('management disclosure keeps internal interactions and poll focus, closes on outside click without moving that focus', async () => {
  const f = await setup(); f.el('listMenuToggle').click(); f.el('listUpdates').focus();
  f.events.get('click')({ target: f.el('listUpdates') }); assert.equal(f.el('listMenu').open, true);
  await f.ui.loadList(); await f.ui.refreshActivity();
  assert.equal(f.el('listMenu').open, true); assert.equal(f.document.activeElement, f.el('listUpdates'));
  f.el('search').focus(); f.events.get('click')({ target: f.el('search') });
  assert.equal(f.el('listMenu').open, false); assert.equal(f.document.activeElement, f.el('search')); assert.equal(writes(f).length, 0);
});

test('management-to-dialog and session transitions close only the disclosure; monitor failures remain visible after it closes', async () => {
  const f = await setup(), draft = f.el('draft').value;
  f.el('listMenuToggle').click(); f.el('listDiagnostics').click();
  assert.equal(f.el('listMenu').open, false); assert.equal(f.el('toolsDialog').open, true); assert.equal(f.ui.state.tools.pane, 'diagnostics');
  assert.equal(f.el('draft').value, draft); assert.equal(writes(f).length, 0);
  f.el('closeTools').click(); f.navigation.flush(); f.advance(400);
  f.el('listMenuToggle').click();
  f.windowEvents.get('codexNative')({ detail: { version: 2, monitor: false, message: '알림 확인 실패 · PC 연결을 확인해 주세요.' } });
  f.events.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(f.el('nativeStatus').hidden, false); assert.match(f.el('nativeStatus').textContent, /알림 확인 실패/);
  f.el('listMenuToggle').click(); f.ui.showPair(); assert.equal(f.el('listMenu').open, false); assert.equal(writes(f).length, 0);
});

test('healthy list and activity omit repeated helper rows, but warning, empty, offline and recovery results remain visible outside management', async () => {
  const f = await setup(); assert.equal(f.el('listStatus').textContent, ''); assert.equal(f.el('activityStatus').textContent, '');
  assert.match(f.el('listScope').textContent, /최근 작업순/);
  f.hook(path => path.startsWith('/api/threads?') ? { data: { data: [], nextCursor: null, searchScope: '저장 제목 범위', warning: '실시간 조회 지연', scope: 'recent-desktop' } } : null);
  await f.ui.loadList(); assert.match(f.el('listStatus').textContent, /결과가 없습니다.*실시간 조회 지연/);
  assert.ok(!f.el('listStatus').textContent.includes('저장 제목 범위')); assert.match(f.el('listScope').textContent, /저장 제목 범위/);
  f.ui.receiveActivity({ available: false, data: [] }); assert.match(f.el('activityStatus').textContent, /확인 지연/);
  f.hook(null); f.offline(true); await f.ui.loadList(); assert.match(f.el('listStatus').textContent, /연결할 수 없습니다/);
  f.offline(false); await f.ui.loadList(); await f.ui.refreshActivity();
  assert.equal(f.el('listStatus').textContent, ''); assert.equal(f.el('activityStatus').textContent, ''); assert.equal(writes(f).length, 0);
});

test('all seven tool navigation buttons reveal the chosen control once, preserve focus and draft on polling, and use one Back layer', async () => {
  const f = await setup(); await f.ui.openThread('fixture'); const draft = f.el('draft').value;
  f.el('chatTools').click(); const historyLength = f.navigation.history.length;
  for (const [button, pane, section] of [['toolQuick', 'quick', 'quickPane'], ['toolSearch', 'search', 'messageSearchPane'], ['toolResults', 'results', 'resultsPane'], ['toolDiagnostics', 'diagnostics', 'diagnosticsPane'], ['toolUsage', 'usage', 'usagePane'], ['toolUpdates', 'updates', 'updatesPane'], ['toolAccounts', 'accounts', 'accountsPane']]) {
    const control = f.el(button), before = control.scrollRequests?.length || 0;
    control.focus(); control.click();
    assert.equal(f.ui.state.tools.pane, pane); assert.equal(f.el(section).hidden, false); assert.equal(control.attributes['aria-pressed'], 'true');
    assert.equal(control.scrollRequests.length, before + 1); assert.equal(control.scrollRequests.at(-1).inline, 'nearest');
    const focus = pane === 'search' ? f.el('messageSearch') : control; assert.equal(f.document.activeElement, focus);
    await f.ui.refreshCurrent(); assert.equal(f.document.activeElement, focus); assert.equal(control.scrollRequests.length, before + 1);
    assert.equal(f.el('draft').value, draft); assert.equal(f.navigation.history.length, historyLength);
  }
  f.advance(400); assert.equal(f.window.codexPhoneBack(), 'handled'); f.navigation.flush();
  assert.equal(f.el('toolsDialog').open, false); assert.equal(f.document.body.dataset.chat, 'true'); assert.equal(f.el('draft').value, draft); assert.equal(writes(f).length, 0);
});

test('open tool navigation reveals the active button horizontally only on actual nav width changes, preserving focus, vertical scroll and manual pan across polling and IME', async () => {
  const viewportEvents = new Map(), visualViewport = { height: 900, addEventListener(name, fn) { viewportEvents.set(name, fn); } };
  const f = await setup({ innerHeight: 900, visualViewport }), nav = f.el('toolsNav'), active = f.el('toolAccounts');
  let pan = 0, pans = 0;
  Object.defineProperty(nav, 'scrollLeft', { get: () => pan, set(value) { pan = value; pans++; } });
  nav.clientWidth = 500; nav.rect = { left: 20 }; active.rect = { left: 420, right: 488 };
  f.el('listAccounts').click();
  const reveals = active.scrollRequests.length, historyLength = f.navigation.history.length, draft = f.el('draft').value;
  f.el('accountLabel').focus(); f.el('accountsPane').scrollTop = 87; f.el('toolsDialog').scrollTop = 12; f.document.body.scrollTop = 19; f.el('history').scrollTop = 41;
  const retained = () => {
    assert.equal(f.document.activeElement, f.el('accountLabel')); assert.equal(f.el('accountsPane').scrollTop, 87);
    assert.equal(f.el('toolsDialog').scrollTop, 12); assert.equal(f.document.body.scrollTop, 19); assert.equal(f.el('history').scrollTop, 41);
    assert.equal(active.scrollRequests.length, reveals); assert.equal(f.navigation.history.length, historyLength); assert.equal(f.el('draft').value, draft);
  };
  nav.clientWidth = 300; f.windowEvents.get('resize')();
  assert.equal(pan, 168); assert.equal(pans, 1); retained();
  f.frame(16); assert.equal(pans, 1); retained();
  nav.scrollLeft = 0; const manualPans = pans;
  await f.ui.refreshCurrent(); await f.ui.refreshActivity();
  f.window.innerHeight = 700; visualViewport.height = 420; viewportEvents.get('resize')(); f.frame(16);
  f.windowEvents.get('resize')(); f.frame(16);
  assert.equal(pan, 0); assert.equal(pans, manualPans); retained();
  nav.clientWidth = 400; active.rect = { left: 100, right: 168 }; f.windowEvents.get('resize')();
  assert.equal(pans, manualPans); retained();
  nav.scrollLeft = 420; active.rect = { left: -60, right: 8 }; nav.clientWidth = 360;
  f.windowEvents.get('resize')(); assert.equal(pan, 340); assert.equal(pans, manualPans + 2); retained();
  f.el('closeTools').click(); f.navigation.flush(); const closedPans = pans;
  nav.clientWidth = 280; f.windowEvents.get('resize')(); f.frame(16);
  assert.equal(pans, closedPans); assert.equal(writes(f).length, 0);
});

test('user-initiated rename opens the existing management disclosure and focuses its input; later refresh never reopens or refocuses it', async () => {
  const revision = randomUUID(), id = randomUUID();
  const result = { revision, supported: true, switchSupported: false, busy: false, recovery: false, profiles: [{ id, label: '저장 이름', email: 'sample@example.invalid', current: false }], current: null };
  const f = await setup({ requestHook: path => path === '/api/session' ? { data: { csrf: 'fixture-csrf', storageScope: 'a'.repeat(64), accountRevision: revision } } : path === '/api/accounts' ? { data: result } : path === '/api/accounts/presence' ? { data: { revision, busy: false, recovery: false } } : null });
  const details = f.document.createElement('details'), summary = f.document.createElement('summary'); details.open = false; details.append(summary, f.el('accountLabel'));
  f.el('listAccounts').click(); await f.evaluate('refreshAccounts()');
  const row = f.el('accountProfiles').children[0]; row.choose.click(); row.rename.focus(); row.rename.click();
  assert.equal(details.open, true); assert.equal(f.document.activeElement, f.el('accountLabel')); assert.equal(f.el('accountLabel').value, '저장 이름');
  assert.equal(f.el('accountLabel').scrollRequests.at(-1).block, 'nearest');
  f.el('accountLabel').value = '아직 저장하지 않은 이름'; summary.click(); const scrolls = f.el('accountLabel').scrollRequests.length;
  await f.evaluate('refreshAccounts()');
  assert.equal(details.open, false); assert.equal(f.document.activeElement, summary); assert.equal(f.el('accountLabel').value, '아직 저장하지 않은 이름');
  assert.equal(f.el('accountLabel').scrollRequests.length, scrolls); assert.equal(writes(f).length, 0);
});
