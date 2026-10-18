import test from 'node:test';
import assert from 'node:assert/strict';
import { workTime, newestUpdate, compareWork } from '../server/work-order.mjs';
import { browser } from './browser-fixture.mjs';
import { fixture } from './helpers.mjs';

const seconds = 1792180800, ms = seconds * 1000;
const order = f => Array.from(f.el('threads').children, root => [...f.ui.state.threadNodes].find(([, ui]) => ui.root === root)[0]);
const receive = (f, rows) => f.ui.receiveActivity({ available: true, checkedAt: Date.now(), data: rows.map(row => ({ status: 'active', desktopUnread: true, previewState: 'pending', ...row })) });

test('server and shipped classic client normalize only finite actual work dates: seconds, milliseconds, numeric strings and explicit ISO zones', async () => {
  const f = await browser({ selected: false });
  for (const value of [seconds, ms, String(seconds), String(ms), new Date(ms).toISOString(), new Date(ms + 9 * 3600000).toISOString().replace('Z', '+09:00')]) {
    assert.equal(workTime(value), ms); assert.equal(f.evaluate(`workTime(${JSON.stringify(value)})`), ms);
  }
  for (const value of [null, undefined, false, true, {}, [], '', '1e9', '2026-10-17', '2026-02-30T00:00:00Z', '2026-10-17T24:00:00Z', 'invalid', 0, -1, Infinity, NaN, seconds * 1e6]) {
    assert.equal(workTime(value), null, String(value));
    const expression = value === undefined ? 'undefined' : typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value);
    assert.equal(f.evaluate(`workTime(${expression})`), null, String(value));
  }
  assert.equal(newestUpdate(ms, seconds - 1), ms); assert.equal(newestUpdate(null, seconds), seconds);
  const rows = [{ id: 'z' }, { id: 'b', updatedAt: seconds }, { id: 'a', updatedAt: ms }, { id: 'x', updatedAt: 'invalid' }];
  assert.deepEqual(rows.sort(compareWork).map(r => r.id), ['a', 'b', 'x', 'z']);
});
test('backend recent and pinned merge uses latest actual dates; stored pages keep native cursors/search and never downgrade newer stored work', async t => {
  const f = await fixture(t);
  const row = (id, updatedAt) => ({ ...f.desktop.thread(id), updatedAt });
  f.desktop.hook = async tool => tool === 'list_threads' ? { pinnedThreads: [row('pinned-old', seconds - 100), row('shared', ms)], threads: [row('fresh', seconds + 5), row('shared', seconds - 20), row('unknown', NaN)] } : undefined;
  assert.deepEqual((await f.engine.recentThreads()).map(r => r.id), ['fresh', 'shared', 'pinned-old', 'unknown']);
  const requests = [];
  f.rpc.request = async (method, params) => { requests.push({ method, params }); return { data: params.cursor ? [{ id: 'page-two', title: '이전 저장', updatedAt: seconds - 200 }] : [{ id: 'shared', title: '저장 제목', updatedAt: seconds + 10 }, { id: 'pinned-old', title: '저장 제목', updatedAt: seconds - 150 }], nextCursor: params.cursor ? null : 'opaque-native-cursor' }; };
  const first = await f.engine.list({ search: '제목' });
  assert.equal(first.data[0].id, 'shared'); assert.equal(first.data[0].updatedAt, seconds + 10); assert.equal(first.data[0].title, 'PC 실시간 제목');
  assert.equal(first.nextCursor, 'opaque-native-cursor'); assert.equal(first.data.length, 2); // No live injection into native pages.
  const next = await f.engine.list({ cursor: first.nextCursor, search: '제목' }); assert.equal(next.data[0].id, 'page-two'); assert.equal(next.nextCursor, null);
  assert.equal(requests[1].params.cursor, 'opaque-native-cursor'); assert.equal(requests[1].params.searchTerm, '제목'); assert.equal(requests[1].params.sortKey, 'updated_at'); assert.equal(requests[1].params.sortDirection, 'desc');
  f.engine.historyRpcFactory = null;
  const fallback = await f.engine.list(); assert.equal(fallback.scope, 'recent-desktop'); assert.match(fallback.warning, /최근 50개/); assert.equal(fallback.data[0].id, 'fresh');
  assert.ok(f.desktop.calls.every(c => c.tool === 'list_threads'));
});
test('ALL live recency replaces favorite precedence, includes off-page work and preserves focused moving row, stored pages, cursor, scroll, selection and draft', async () => {
  const f = await browser({ blurOnDetach: true });
  f.ui.state.rows = [{ id: 'fixture', title: '저장 제목', updatedAt: seconds }, { id: 'older-page', title: '이전 페이지', updatedAt: seconds - 100 }];
  f.ui.state.favorites = [{ id: 'older-page', title: '즐겨찾기 오래된 제목' }];
  receive(f, [{ id: 'fixture', title: '새 제목', updatedAt: ms }, { id: 'offpage', title: '다른 작업', updatedAt: seconds - 50 }]);
  assert.deepEqual(order(f), ['fixture', 'offpage', 'older-page']); assert.equal(f.ui.state.threadNodes.get('older-page').star.textContent, '★');
  const nodes = new Map(f.ui.state.threadNodes), stored = f.ui.state.rows, cursor = f.ui.state.listCursor;
  const focus = nodes.get('offpage').star; focus.focus(); f.el('sidebar').scrollTop = 250; const history = f.el('history').scrollTop;
  receive(f, [{ id: 'fixture', title: '새 제목', updatedAt: seconds }, { id: 'offpage', title: '다른 작업', updatedAt: seconds + 1 }]);
  assert.deepEqual(order(f), ['offpage', 'fixture', 'older-page']); assert.equal(f.document.activeElement, focus); assert.equal(f.el('sidebar').scrollTop, 250); assert.equal(f.el('history').scrollTop, history);
  for (const [id, ui] of nodes) assert.equal(f.ui.state.threadNodes.get(id), ui);
  assert.equal(f.ui.state.rows, stored); assert.equal(f.ui.state.listCursor, cursor); assert.equal(f.ui.state.selected, 'fixture'); assert.equal(f.el('draft').value, '보존할 한글 초안');
  const calls = f.calls.length; f.el('draft').focus(); f.el('draft').setSelectionRange(2, 4);
  receive(f, [{ id: 'fixture', title: '새 제목', updatedAt: seconds + 2 }, { id: 'offpage', title: '다른 작업', updatedAt: seconds + 1 }]);
  assert.equal(f.document.activeElement, f.el('draft')); assert.equal(f.el('draft').selectionStart, 2); assert.equal(f.el('draft').selectionEnd, 4); assert.equal(f.calls.length, calls);
});
test('all filters use deterministic recency; merged live titles participate in search, no observation/seen/open clocks promote rows and pagination loses none', async () => {
  const f = await browser({ selected: false });
  f.ui.state.rows = [{ id: 'fixture', title: '낡은 제목', updatedAt: seconds }, { id: 'loaded', title: '찾을 저장', updatedAt: seconds - 10 }];
  f.ui.state.favorites = [{ id: 'loaded', title: '즐겨찾기' }, { id: 'fixture', title: '즐겨찾기' }];
  const data = [{ id: 'fixture', title: '찾을 새 제목', updatedAt: seconds }, { id: 'offpage', title: '찾을 활동', updatedAt: seconds + 1 }, { id: 'unknown-z', title: '날짜 없음' }, { id: 'unknown-a', title: '날짜 없음', updatedAt: 'invalid' }];
  receive(f, data); assert.deepEqual(order(f), ['offpage', 'fixture', 'loaded', 'unknown-a', 'unknown-z']);
  f.el('filterFavorites').onclick(); assert.deepEqual(order(f), ['fixture', 'loaded']);
  f.el('filterWorking').onclick(); assert.deepEqual(order(f), ['offpage', 'fixture', 'unknown-a', 'unknown-z']);
  f.el('filterUnread').onclick(); assert.deepEqual(order(f), ['offpage', 'fixture', 'unknown-a', 'unknown-z']);
  f.el('filterAll').onclick(); f.el('search').value = '찾을'; f.el('search').setSelectionRange(1, 2); f.el('search').focus();
  receive(f, [...data].reverse().map(r => ({ ...r, previewCheckedAt: Date.now() + 1000, seenAt: Date.now(), preview: { observedAt: Date.now() + 5000 } })));
  assert.deepEqual(order(f), ['offpage', 'fixture', 'loaded']); assert.equal(f.document.activeElement, f.el('search')); assert.equal(f.el('search').selectionStart, 1);
  f.el('search').value = ''; await f.ui.openThread('fixture'); assert.equal(order(f)[0], 'offpage');
  const before = f.ui.state.listCursor;
  f.hook(path => path.startsWith('/api/threads?') ? { data: { data: [{ id: 'next-page', title: '추가 저장 페이지', updatedAt: seconds - 20 }, { id: 'fixture', title: '중복 이전 제목', updatedAt: seconds - 300 }], nextCursor: 'native-next', searchScope: '전체 저장 제목' } } : null);
  await f.ui.loadList(true);
  assert.ok(f.calls.some(c => c.path.includes('cursor=' + before))); assert.equal(f.ui.state.listCursor, 'native-next');
  assert.deepEqual(new Set(f.ui.state.rows.map(r => r.id)), new Set(['fixture', 'loaded', 'next-page'])); assert.equal(f.ui.state.rows.find(r => r.id === 'fixture').updatedAt, seconds);
  assert.deepEqual(order(f), ['offpage', 'fixture', 'loaded', 'next-page', 'unknown-a', 'unknown-z']); assert.match(f.el('listScope').textContent, /불러온 대화.*최근 작업순/); assert.equal(f.el('listStatus').textContent, '');
  receive(f, []); assert.equal(f.ui.state.threadNodes.get('fixture').title.textContent, '찾을 새 제목'); // Loaded metadata retained, not observed time.
  f.ui.persistDevice(true); const saved = JSON.parse(f.storage.getItem('codex-phone-device-v2')); assert.ok(saved.reads.every(r => !Object.hasOwn(r, 'listing')));
  assert.ok(!f.calls.some(c => c.options.method === 'POST'));
});
test('selected native metadata can advertise actual work updates, but opening and repeated reads do not invent recency', async () => {
  const f = await browser({ selected: false }); let updatedAt = seconds - 5;
  f.ui.state.rows = [{ id: 'fixture', title: '저장 제목', updatedAt: seconds - 10 }];
  receive(f, [{ id: 'offpage', title: '더 최근 작업', updatedAt: seconds }]);
  f.hook(path => path === '/api/threads/fixture' ? { data: { thread: { id: 'fixture', title: '실제 native 제목', updatedAt }, capability: { online: true, continuationEnabled: true } } } : null);
  await f.ui.openThread('fixture'); assert.equal(order(f)[0], 'offpage'); assert.equal(f.ui.state.threadNodes.get('fixture').title.textContent, '실제 native 제목');
  await f.ui.refreshCurrent(); assert.equal(order(f)[0], 'offpage');
  f.el('draft').value = '목록이 이동해도 보존'; f.el('draft').focus(); f.el('draft').setSelectionRange(1, 3);
  updatedAt = seconds + 5; await f.ui.refreshCurrent(); assert.equal(order(f)[0], 'fixture'); assert.equal(f.document.activeElement, f.el('draft')); assert.equal(f.el('draft').selectionStart, 1); assert.equal(f.el('draft').value, '목록이 이동해도 보존');
  assert.ok(f.calls.every(c => !c.options.method || c.options.method === 'GET'));
});
