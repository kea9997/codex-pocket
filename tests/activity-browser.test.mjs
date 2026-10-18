import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

function row(version = 'baseline', at = 100, extra = {}) {
  return { id: 'fixture', title: '기존 제목', status: 'active', desktopUnread: false, stale: false,
    preview: version ? { version, turnId: 'existing', itemId: 'a', text: `답변 ${version}`, turnStatus: 'inProgress', observedAt: at } : null,
    previewCheckedAt: at, previewState: 'ready', ...extra };
}
function receive(f, rows) { f.ui.receiveActivity({ data: rows, available: true, checkedAt: Math.max(...rows.map(r => r.previewCheckedAt)) }); }

test('list-visible assistant changes are unread even with selected chat; unchanged polls, completion and dismissal do not re-alert', async () => {
  const f = await browser();
  assert.equal(f.ui.state.notifications.size, 0); assert.equal(f.ui.state.activity.get('fixture').unread, false);
  receive(f, [row('commentary', 200)]);
  assert.equal(f.ui.state.activity.get('fixture').unread, true); assert.equal(f.el('activityNotice').hidden, false);
  assert.match(f.el('noticeTitle').textContent, /기존 제목/); assert.match(f.el('noticeSnippet').textContent, /commentary/);
  await f.ui.refreshCurrent(); // Selected is retained, but mobile is actually on the list.
  assert.equal(f.ui.state.activity.get('fixture').unread, true);
  f.el('dismissActivityNotice').onclick(); assert.equal(f.el('activityNotice').hidden, true);
  receive(f, [row('commentary', 250)]); assert.equal(f.ui.state.notifications.size, 0);
  receive(f, [row('commentary', 300, { status: 'idle' })]);
  assert.equal(f.ui.state.notifications.size, 0); assert.equal(f.el('filterWorking').textContent, '작업 중 0');
  receive(f, [row('final', 400, { status: 'idle' })]); assert.equal(f.ui.state.notifications.size, 1);
  assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('initial baseline, pending previews and user/tool-only latest turn never create new-response alerts', async () => {
  const f = await browser({ selected: false });
  receive(f, [row('existing', 200, { id: 'new', previewState: 'pending' })]);
  assert.equal(f.ui.state.notifications.size, 0);
  receive(f, [row('existing', 250, { id: 'new' })]); assert.equal(f.ui.state.notifications.size, 0);
  receive(f, [row(null, 300, { id: 'new' })]); assert.equal(f.ui.state.notifications.size, 0);
  receive(f, [row('actual-assistant', 400, { id: 'new' })]); assert.equal(f.ui.state.notifications.size, 1);
});
test('only successfully rendered latest visible history acknowledges exact seen version; older response and stale activity cannot clear/re-alert newer text', async () => {
  const f = await browser({ selected: false });
  receive(f, [row('newest', 300)]);
  f.historyPreview({ preview: row('older', 200).preview, previewCheckedAt: 200 });
  await f.ui.openThread('fixture'); assert.equal(f.ui.state.activity.get('fixture').unread, true);
  f.historyPreview({ preview: row('newest', 400).preview, previewCheckedAt: 400 });
  await f.ui.refreshCurrent(); assert.equal(f.ui.state.activity.get('fixture').unread, false); assert.equal(f.ui.state.notifications.size, 0);
  receive(f, [row('older', 250)]); assert.equal(f.ui.state.activity.get('fixture').unread, false); assert.equal(f.ui.state.notifications.size, 0);
  f.el('back').onclick(); receive(f, [row('later', 500)]);
  assert.equal(f.ui.state.activity.get('fixture').unread, true);
  await f.ui.refreshCurrent(); assert.equal(f.ui.state.activity.get('fixture').unread, true);
});
test('hidden/offscreen history and failed open do not mark read; tappable banner opens original chat, retaining other draft', async () => {
  const f = await browser({ selected: false });
  await f.ui.openThread('other'); f.el('draft').value = '다른 대화 초안';
  receive(f, [row('new', 200)]); assert.equal(f.ui.state.notifications.size, 1);
  f.historyPreview({ preview: row('new', 250).preview, previewCheckedAt: 250 });
  f.offline(true); await f.ui.openThread('fixture'); assert.equal(f.ui.state.activity.get('fixture').unread, true);
  assert.equal(f.ui.state.drafts.get('other'), '다른 대화 초안');
  f.offline(false); await f.el('openActivityNotice').onclick();
  await waitFor(() => !f.ui.state.activity.get('fixture').unread);
  assert.equal(f.ui.state.selected, 'fixture');
  receive(f, [row('newer', 300)]);
  f.el('history').scrollHeight = 2000; f.el('history').scrollTop = 0;
  f.ui.state.renderedPreview = { id: 'fixture', preview: row('newer', 350).preview, at: 350 };
  f.ui.markViewed(); assert.equal(f.ui.state.activity.get('fixture').unread, true);
  f.document.hidden = true; f.el('history').scrollTop = 2000; f.ui.markViewed(); assert.equal(f.ui.state.activity.get('fixture').unread, true);
  f.document.hidden = false; f.ui.markViewed(); assert.equal(f.ui.state.activity.get('fixture').unread, false);
});
test('poll updates preserve search, stored pages/cursor/order, row focus, sidebar scroll, selected ID and unsent draft; filters expose active off-page chats', async () => {
  const f = await browser();
  await f.ui.loadList(true); const cursor = f.ui.state.listCursor, rows = f.ui.state.rows;
  const button = f.el('threads').children[0]; button.focus(); f.el('sidebar').scrollTop = 250;
  f.el('search').value = '제목'; const calls = f.calls.length;
  receive(f, [row('new', 200), row('other-new', 200, { id: 'offpage', title: '다른 제목', status: 'waiting' })]);
  assert.equal(f.el('search').value, '제목'); assert.equal(f.ui.state.rows, rows); assert.equal(f.ui.state.listCursor, cursor);
  assert.equal(f.el('threads').children[0], button); assert.equal(f.document.activeElement, button); assert.equal(f.el('sidebar').scrollTop, 250);
  assert.equal(f.ui.state.selected, 'fixture'); assert.equal(f.el('draft').value, '보존할 한글 초안'); assert.equal(f.calls.length, calls);
  assert.equal(f.el('filterWorking').textContent, '작업 중 2'); f.el('filterWorking').onclick();
  assert.equal(f.el('threads').children.length, 2); assert.equal(f.el('moreThreads').hidden, true);
  f.el('filterAll').onclick(); assert.equal(f.ui.state.listCursor, cursor);
});
test('foreground polling works without selection, is single-flight, pauses hidden and recovers immediately without overlapping polls', async () => {
  const f = await browser({ selected: false }); assert.equal(f.ui.state.selected, null);
  assert.ok([...f.timers.values()].some(t => t.ms === 4000));
  let release;
  f.hook(async path => { if (path === '/api/activity') return new Promise(r => { release = r; }); });
  const first = f.ui.refreshActivity(), second = f.ui.refreshActivity(); assert.equal(first, second);
  await waitFor(() => release); f.document.hidden = true; f.events.get('visibilitychange')();
  release({ data: { available: true, data: [row('hidden-new', 200)] } }); await first;
  assert.equal(f.ui.state.notifications.size, 0); assert.equal(f.timers.size, 0);
  const count = f.calls.length; await f.ui.refreshActivity(); assert.equal(f.calls.length, count);
  f.hook(null); f.activity([row('resumed', 300)]); f.document.hidden = false; f.events.get('visibilitychange')();
  await waitFor(() => f.ui.state.notifications.size === 1); assert.equal(f.ui.state.selected, null);
});
test('desktop unread is labelled without initial alert and locally cleared only after viewing; same desktop flag does not re-alert', async () => {
  const f = await browser({ selected: false });
  receive(f, [row('baseline', 150, { desktopUnread: true })]);
  assert.equal(f.ui.state.notifications.size, 0); assert.equal(f.el('filterUnread').textContent, '새 응답 1');
  f.historyPreview({ preview: row('baseline', 200).preview, previewCheckedAt: 200 }); await f.ui.openThread('fixture');
  receive(f, [row('baseline', 250, { desktopUnread: true })]);
  assert.equal(f.el('filterUnread').textContent, '새 응답 0'); assert.equal(f.ui.state.notifications.size, 0);
});
test('only observed active-to-idle with the same completed assistant turn labels work ended; idle baseline and tool-only finish do not', async () => {
  const f = await browser({ selected: false });
  assert.ok(!f.ui.state.threadNodes.get('fixture').status.textContent.includes('작업 종료'));
  receive(f, [row('progress', 200)]); f.el('dismissActivityNotice').onclick();
  const completed = { ...row('progress', 300).preview, turnStatus: 'completed' };
  receive(f, [row('progress', 300, { status: 'idle', preview: completed })]);
  assert.match(f.ui.state.threadNodes.get('fixture').status.textContent, /작업 종료/);
  assert.equal(f.ui.state.notifications.size, 0);
  receive(f, [row(null, 400)]); receive(f, [row(null, 500, { status: 'idle' })]);
  assert.ok(!f.ui.state.threadNodes.get('fixture').status.textContent.includes('작업 종료'));
});
test('activity recovery retries a failed stored page without resetting loaded pages/search/cursor; late search response is ignored', async () => {
  const f = await browser({ selected: false });
  f.el('search').value = '제목'; const rows = f.ui.state.rows, cursor = f.ui.state.listCursor;
  f.offline(true); await f.ui.loadList(true); assert.match(f.el('listStatus').textContent, /연결할 수 없습니다/);
  f.offline(false); await f.ui.refreshActivity();
  assert.equal(f.el('search').value, '제목'); assert.equal(f.ui.state.rows[0].id, rows[0].id); assert.equal(f.ui.state.listCursor, cursor);
  assert.ok(!f.el('listStatus').textContent.includes('연결할 수 없습니다'));
  let release; f.hook(path => path.includes('search=old') ? new Promise(r => { release = r; }) : null);
  f.el('search').value = 'old'; const old = f.ui.loadList(); await waitFor(() => release);
  f.el('search').value = 'new'; await f.ui.loadList();
  release({ data: { data: [{ id: 'must-not-appear', title: 'old' }], nextCursor: null } }); await old;
  assert.equal(f.el('search').value, 'new'); assert.ok(!f.ui.state.rows.some(r => r.id === 'must-not-appear'));
});
test('logout clears activity/notifications/content; late successful response and late401 cannot repopulate or invalidate next session', async () => {
  const f = await browser(); receive(f, [row('new', 200)]);
  let release; f.hook(path => path === '/api/activity' ? new Promise(r => { release = r; }) : null);
  const old = f.ui.refreshActivity(); await waitFor(() => release);
  await f.el('logout').onclick();
  assert.equal(f.ui.state.activity.size, 0); assert.equal(f.ui.state.notifications.size, 0); assert.equal(f.ui.state.drafts.size, 0);
  assert.equal(f.el('threads').children.length, 0); assert.equal(f.el('messages').children.length, 0); assert.equal(f.el('activityNotice').hidden, true);
  f.hook(null); await f.ui.boot(); release({ status: 401, data: { error: 'AUTH_REQUIRED' } }); await old;
  assert.ok(f.ui.state.csrf); assert.equal(f.el('appView').hidden, false); assert.equal(f.ui.state.notifications.size, 0);
  await f.ui.refreshActivity(); // Boot's new-session GET may still be settling after cancelled old I/O.
  let releaseSuccess; f.hook(path => path === '/api/activity' ? new Promise(r => { releaseSuccess = r; }) : null);
  const stale = f.ui.refreshActivity(); await waitFor(() => releaseSuccess); f.ui.showPair();
  releaseSuccess({ data: { available: true, data: [row('must-not-reappear', 500)] } }); await stale;
  assert.equal(f.ui.state.activity.size, 0); assert.equal(f.el('threads').children.length, 0);
});
