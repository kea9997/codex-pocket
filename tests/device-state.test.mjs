import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { browser, deviceStorage } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';
const source = readFileSync(new URL('../web/device-state.js', import.meta.url), 'utf8'), scope = 'a'.repeat(64), key = 'codex-phone-device-v2';
function device(storage, report) { const context = vm.createContext({}); vm.runInContext(source, context); return new context.DeviceState(storage, report); }
const plain = value => JSON.parse(JSON.stringify(value));
test('device storage is versioned/session-scoped/whitelisted/bounded, preserving Korean multiline and only request identifiers, never credentials or raw chats', () => {
  const storage = deviceStorage(), state = device(storage); state.bind(scope);
  state.save({ selected: 'original', drafts: [['original', '한글\n둘째 줄']], favorites: [{ id: 'off-page', title: '즐겨찾기' }],
    reads: [{ id: 'original', version: 'b'.repeat(64), seen: ['c'.repeat(64)], preview: { text: 'PRIVATE_CHAT' }, csrf: 'SECRET' }],
    cookie: 'SECRET', csrf: 'SECRET', reasoning: 'PRIVATE_REASONING', fullChat: 'PRIVATE_CHAT', pending: { threadId: 'original', requestId: '11111111-1111-4111-8111-111111111111', text: 'PRIVATE_SEND', token: 'SECRET' } });
  const text = storage.getItem(key); for (const value of ['SECRET', 'PRIVATE_CHAT', 'PRIVATE_REASONING', 'PRIVATE_SEND']) assert.ok(!text.includes(value));
  const restart = device(storage), saved = restart.bind(scope); assert.equal(saved.selected, 'original'); assert.equal(saved.drafts[0][1], '한글\n둘째 줄'); assert.equal(saved.pending.threadId, 'original');
  state.save({ drafts: Array.from({ length: 100 }, (_, n) => [`thread-${n}`, '한'.repeat(17000)]), favorites: Array.from({ length: 100 }, (_, n) => ({ id: `thread-${n}`, title: '제목'.repeat(1000) })), reads: Array.from({ length: 200 }, (_, n) => ({ id: `thread-${n}`, seen: Array(20).fill('b'.repeat(64)) })) });
  const bounded = JSON.parse(storage.getItem(key)); assert.ok(bounded.drafts.length <= 8); assert.ok(bounded.drafts.every(r => r[1].length <= 16000)); assert.ok(bounded.favorites.length <= 32); assert.ok(bounded.reads.length <= 96); assert.ok(storage.getItem(key).length <= 180000);
  assert.equal(device(storage).bind('f'.repeat(64)).drafts.length, 0); assert.equal(storage.getItem(key), null);
});
test('answer display preference accepts only a boolean in the existing session whitelist, defaulting safely for legacy/malformed/foreign records', () => {
  const storage = deviceStorage(), state = device(storage); state.bind(scope);
  for (const value of [false, true, 'false', 0, null, { text: 'PRIVATE_ANSWER', token: 'SECRET' }]) {
    state.save({ smoothAnswers: value, fullChat: 'PRIVATE_ANSWER' });
    const saved = JSON.parse(storage.getItem(key)); assert.equal(saved.smoothAnswers, typeof value === 'boolean' ? value : true);
    assert.ok(!JSON.stringify(saved).includes('PRIVATE_ANSWER')); assert.ok(!JSON.stringify(saved).includes('SECRET'));
  }
  storage.setItem(key, JSON.stringify({ version: 2, scope, drafts: [['fixture', '기존 초안']] }));
  const legacy = device(storage).bind(scope); assert.equal(legacy.smoothAnswers, true); assert.equal(legacy.drafts[0][1], '기존 초안');
  state.save({ smoothAnswers: false }); assert.equal(device(storage).bind('b'.repeat(64)).smoothAnswers, true);
});
test('next-message choices and creation recovery extend v2 with bounded whitelist only, preserving legacy defaults and clearing foreign scope', () => {
  const storage = deviceStorage(), state = device(storage), requestId = '11111111-1111-4111-8111-111111111111'; state.bind(scope);
  state.save({ modelChoices: Array.from({ length: 40 }, (_, i) => [`thread-${i}`, { model: 'fixture-next', thinking: 'high', token: 'SECRET', raw: 'PRIVATE' }]),
    pending: { threadId: 'thread-39', requestId, selection: { model: 'fixture-next', thinking: 'high', token: 'SECRET' } },
    creation: { requestId, text: 'PRIVATE', target: { path: 'PRIVATE' }, model: 'PRIVATE', clientThreadId: 'PRIVATE' } });
  const data = JSON.parse(storage.getItem(key)); assert.equal(data.modelChoices.length, 32); assert.equal(data.modelChoices[0][0], 'thread-8');
  assert.deepEqual(data.modelChoices.at(-1)[1], { model: 'fixture-next', thinking: 'high' }); assert.deepEqual(data.pending.selection, data.modelChoices.at(-1)[1]);
  assert.deepEqual(data.creation, { requestId }); assert.ok(!JSON.stringify(data).includes('SECRET')); assert.ok(!JSON.stringify(data).includes('PRIVATE'));
  assert.deepEqual(plain(device(storage).bind(scope)).creation, { requestId });
  for (const choice of [{ thinking: 'high' }, { model: '../path' }, { model: 'x'.repeat(101) }, { model: 'fixture-next', thinking: 'invented' }, { model: null }]) {
    state.save({ modelChoices: [['valid', choice], ['../path', { model: 'fixture-next' }]], pending: { threadId: 'valid', requestId, selection: choice }, creation: { requestId: 'not-a-uuid' } });
    assert.equal(state.data.modelChoices.length, 0); assert.equal('selection' in state.data.pending, false); assert.equal(state.data.creation, null);
  }
  storage.setItem(key, JSON.stringify({ version: 2, scope, selected: 'legacy', drafts: [['legacy', '기존 초안']] }));
  const legacy = device(storage).bind(scope); assert.equal(legacy.modelChoices.length, 0); assert.equal(legacy.creation, null); assert.equal(legacy.drafts[0][1], '기존 초안');
  assert.equal(device(storage).bind('b'.repeat(64)).modelChoices.length, 0);
});
test('unavailable/corrupt/oversize storage and quota errors are explicit, RAM draft survives save failure; clear/new scope never restores old data even when removal fails', () => {
  let fail = false; const storage = deviceStorage(), reports = [], nativeSet = storage.setItem;
  storage.setItem = (key, value) => { if (fail) throw new Error('quota'); nativeSet(key, value); };
  const state = device(storage, ok => reports.push(ok)); state.bind(scope); state.save({ drafts: [['original', '보존']] });
  fail = true; assert.equal(state.save({ drafts: [['original', '새 초안\n한글']] }), false); assert.equal(state.data.drafts[0][1], '새 초안\n한글'); assert.equal(reports.at(-1), false);
  storage.removeItem = () => { throw 0; }; state.clear(); assert.equal(state.scope, null); assert.equal(state.bind('b'.repeat(64)).drafts.length, 0);
  nativeSet(key, '{malformed'); assert.equal(device(storage).bind(scope).drafts.length, 0);
  nativeSet(key, 'x'.repeat(180001)); assert.equal(device(storage).bind(scope).drafts.length, 0);
});
test('complete independent WebView restart restores last chat, per-thread draft, favorites and read fingerprints without auto-send; session switch/logout discard old state', async () => {
  const storage = deviceStorage(), first = await browser({ selected: false, storage }); await first.ui.openThread('fixture');
  first.el('draft').value = '복원할 한글\n다음 줄'; first.el('draft').oninput(); first.ui.state.threadNodes.get('fixture').star.onclick(); first.windowEvents.get('pagehide')();
  const second = await browser({ selected: false, storage }); await waitFor(() => second.ui.state.connected && !second.ui.state.restoring);
  assert.equal(second.ui.state.selected, 'fixture'); assert.equal(second.el('draft').value, '복원할 한글\n다음 줄'); assert.equal(second.ui.state.favorites[0].id, 'fixture');
  assert.ok(!second.calls.some(c => c.path === '/api/send'));
  const other = await browser({ selected: false, storage, scope: 'b'.repeat(64) }); assert.equal(other.ui.state.selected, null); assert.equal(other.ui.state.drafts.size, 0); assert.equal(other.ui.state.favorites.length, 0);
  other.ui.showPair(); assert.equal(storage.getItem(key), null);
});
test('favorites stay local, touch-sized sibling actions (no nested buttons), include off-page rows without forced precedence and respect search/filter while polls retain focus/draft/cursor', async () => {
  const f = await browser(); await f.ui.openThread('fixture'); const draft = f.el('draft').value = '초안';
  f.ui.state.favorites = [{ id: 'off-page', title: '목록 밖 즐겨찾기' }]; await f.ui.loadList();
  assert.ok(f.el('threads').children.includes(f.ui.state.threadNodes.get('off-page').root));
  assert.equal(f.el('threads').children[0], f.ui.state.threadNodes.get('fixture').root); // Unknown-date ties use stable IDs, not favorite rank.
  const ui = f.ui.state.threadNodes.get('fixture'); assert.equal(ui.root.children[0], ui.button); assert.equal(ui.root.children[1], ui.star); assert.ok(!ui.button.children.includes(ui.star));
  ui.star.onclick(); ui.star.focus(); const root = ui.root; await f.ui.refreshActivity(); assert.equal(f.document.activeElement, ui.star); assert.equal(f.ui.state.threadNodes.get('fixture').root, root); assert.equal(f.el('draft').value, draft);
  f.el('filterFavorites').onclick(); assert.equal(f.el('threads').children.length, 2); assert.equal(f.el('moreThreads').hidden, true);
  f.el('search').value = '목록 밖'; f.el('filterFavorites').onclick(); assert.equal(f.el('threads').children.length, 1);
  assert.ok(!f.calls.some(c => /pin|favorite/.test(c.path))); assert.ok(f.calls.every(c => c.options.method === 'GET'));
});
test('saved real cursor/anchor restores older position with bounded reads, no transient latest mark-read, actual latest cursor chain retained; missing anchor falls back truthfully', async () => {
  const storage = deviceStorage(), saved = device(storage); saved.bind(scope);
  const anchor = JSON.stringify(['older', 'old-item', 'agentMessage']);
  saved.save({ selected: 'fixture', drafts: [['fixture', '保持\n한글']], positions: [{ id: 'fixture', key: anchor, cursor: 'real-saved-cursor', offset: -20, bottom: false }], reads: [{ id: 'fixture', unread: true, baseline: true, version: 'b'.repeat(64), seenAt: -1, seen: [] }] });
  let release, arrived = false;
  const f = await browser({ selected: false, storage, requestHook: async path => {
    if (path === '/api/threads/fixture/history') return { data: { data: [{ id: 'latest', status: 'completed', startedAt: 2, items: [{ id: 'new', type: 'agentMessage', text: '새 답변' }] }], nextCursor: 'current-real-chain', status: 'idle', preview: { version: 'c'.repeat(64), text: '새 답변' }, previewCheckedAt: 200 } };
    if (path.includes('cursor=real-saved-cursor')) { arrived = true; await new Promise(resolve => { release = resolve; }); return { data: { data: [{ id: 'older', startedAt: 1, status: 'completed', items: [{ id: 'old-item', type: 'agentMessage', text: '읽던 곳' }] }], nextCursor: null } }; }
    if (path.includes('/history?cursor=')) return { data: { data: [], nextCursor: 'still-missing' } };
  } });
  await waitFor(() => arrived); assert.equal(f.ui.state.restoring, true); assert.equal(f.ui.state.activity.get('fixture').unread, true); assert.equal(f.ui.state.activity.get('fixture').seen.has('c'.repeat(64)), false);
  release(); await waitFor(() => !f.ui.state.restoring); assert.ok(f.ui.state.historyNodes.has(anchor)); assert.equal(f.ui.state.historyCursor, 'current-real-chain'); assert.equal(f.ui.state.activity.get('fixture').unread, true); assert.equal(f.el('draft').value, '保持\n한글');
  const before = f.calls.length; await f.ui.restorePosition({ key: 'gone', cursor: 'missing', offset: 0, bottom: false }, 'fixture', f.ui.state.epoch);
  assert.ok(f.calls.length - before <= 3); assert.match(f.el('historyStatus').textContent, /위치를 찾지 못해 최신/); assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('position capture follows visible DOM order, not node insertion order or offscreen latest records; restart fetches that real older page and keeps Korean draft/unread', async () => {
  const storage = deviceStorage(), latest = { id: 'latest', status: 'completed', items: [{ id: 'new', type: 'agentMessage', text: '최신 답변' }] }, older = { id: 'older', status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: '읽던 이전 답변' }] };
  const requestHook = path => path === '/api/threads/fixture/history' ? { data: { data: [latest], nextCursor: 'real-older-page', status: 'idle' } } : path === '/api/threads/fixture/history?cursor=real-older-page' ? { data: { data: [older], nextCursor: null } } : null;
  const first = await browser({ selected: false, storage, requestHook }); await first.ui.openThread('fixture'); await first.el('moreHistory').onclick();
  const oldKey = JSON.stringify(['older', 'old', 'agentMessage']), newKey = JSON.stringify(['latest', 'new', 'agentMessage']);
  assert.equal([...first.ui.state.historyNodes.keys()][0], newKey); assert.equal(first.el('messages').children[0], first.ui.state.historyNodes.get(oldKey).root);
  Object.assign(first.el('history'), { rect: { top: 140, bottom: 796 }, scrollTop: 0, scrollHeight: 1564, clientHeight: 656 });
  first.ui.state.historyNodes.get(oldKey).root.rect = { top: 140, bottom: 700 }; first.ui.state.historyNodes.get(newKey).root.rect = { top: 1000, bottom: 1500 };
  first.el('draft').value = '복원할 한글\n두 번째 줄'; first.ui.state.activity.get('fixture').unread = true; first.ui.persistDevice(true);
  const position = JSON.parse(storage.getItem(key)).positions[0]; assert.equal(position.key, oldKey); assert.equal(position.cursor, 'real-older-page'); assert.equal(position.offset, 0); assert.equal(position.bottom, false);
  const second = await browser({ selected: false, storage, requestHook }); await waitFor(() => second.ui.state.connected && !second.ui.state.restoring);
  assert.ok(second.calls.some(c => c.path.endsWith('history?cursor=real-older-page'))); assert.ok(second.ui.state.historyNodes.has(oldKey)); assert.equal(second.el('draft').value, '복원할 한글\n두 번째 줄'); assert.equal(second.ui.state.activity.get('fixture').unread, true);
  first.ui.state.historyNodes.get(oldKey).root.rect = { top: -500, bottom: -10 }; first.ui.capturePosition(); assert.equal(first.ui.state.positions.get('fixture').key, oldKey); // No visible anchor: do not replace it with a far-below node.
});
test('far restored page keeps an explicit gap until real latest cursor chain connects, then continues further older without holes, duplicates, reordering or detached restored nodes', async () => {
  const storage = deviceStorage(), saved = device(storage); saved.bind(scope);
  const make = n => ({ id: `turn-${n}`, status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: `기록 ${n}` }] }); let latest = 8;
  saved.save({ selected: 'fixture', positions: [{ id: 'fixture', key: JSON.stringify(['turn-3', 'a', 'agentMessage']), cursor: 'cursor-3', offset: 0, bottom: false }] });
  const f = await browser({ selected: false, storage, requestHook: path => {
    if (path === '/api/threads/fixture/history') return { data: { data: [make(latest)], status: 'idle', nextCursor: `cursor-${latest - 1}` } };
    const match = /history\?cursor=cursor-(\d+)$/.exec(path); if (match) { const n = Number(match[1]); return { data: { data: [make(n)], nextCursor: n ? `cursor-${n - 1}` : null } }; }
  } });
  await waitFor(() => f.ui.state.connected && !f.ui.state.restoring); assert.equal(f.ui.state.historyCursor, 'cursor-7'); assert.match(f.el('historyStatus').textContent, /사이에 아직 불러오지 않은 기록/);
  assert.equal(f.calls.filter(c => c.path.includes('history?')).length, 1);
  const root = f.ui.state.historyNodes.get(JSON.stringify(['turn-3', 'a', 'agentMessage'])).root, detached = root.detachCount;
  latest = 9; await f.ui.refreshCurrent(); assert.equal(f.ui.state.historyCursor, 'cursor-8'); assert.match(f.el('historyStatus').textContent, /사이에 아직/);
  for (let n = 8; n >= 0; n--) {
    assert.equal(f.ui.state.historyCursor, `cursor-${n}`); await f.el('moreHistory').onclick();
    assert.equal(f.ui.state.historyNodes.get(JSON.stringify(['turn-3', 'a', 'agentMessage'])).root, root); assert.equal(root.detachCount, detached);
    assert.equal(Boolean(f.ui.state.historyGap), n > 3);
  }
  assert.deepEqual([...f.ui.state.turns.keys()], Array.from({ length: 10 }, (_, n) => `turn-${n}`)); assert.equal(f.ui.state.historyCursor, null); assert.equal(f.el('moreHistory').hidden, true); assert.doesNotMatch(f.el('historyStatus').textContent, /사이에 아직/);
  assert.ok(!f.calls.some(c => c.path === '/api/send'));
});
test('if a real cursor chain ends before the restored segment, missing middle is explicit and its further older cursor remains user-recoverable, not silently hidden', async () => {
  const storage = deviceStorage(), saved = device(storage); saved.bind(scope); const make = n => ({ id: `turn-${n}`, status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: String(n) }] });
  saved.save({ selected: 'fixture', positions: [{ id: 'fixture', key: JSON.stringify(['turn-3', 'a', 'agentMessage']), cursor: 'saved-3', offset: 0, bottom: false }] });
  const f = await browser({ selected: false, storage, requestHook: path => path.endsWith('/history') ? { data: { data: [make(8)], status: 'idle', nextCursor: 'current-chain' } } : path.endsWith('cursor=saved-3') ? { data: { data: [make(3)], nextCursor: 'saved-2' } } : path.endsWith('cursor=saved-2') ? { data: { data: [make(2)], nextCursor: null } } : path.endsWith('cursor=current-chain') ? { data: { data: [], nextCursor: null } } : null });
  await waitFor(() => f.ui.state.connected && !f.ui.state.restoring); await f.el('moreHistory').onclick();
  assert.match(f.el('historyStatus').textContent, /接続|연결을 확인하지 못/); assert.equal(f.el('moreHistory').hidden, false); assert.match(f.el('moreHistory').textContent, /복원한 위치의 더 이전/);
  const before = f.calls.length; await f.el('moreHistory').onclick(); assert.equal(f.calls.length - before, 1); assert.deepEqual([...f.ui.state.turns.keys()], ['turn-2', 'turn-3', 'turn-8']); assert.equal(f.el('moreHistory').hidden, true); assert.match(f.el('historyStatus').textContent, /일부 중간 기록은 PC/);
});
test('restart pending is session scoped and identifier-only; uncertain receipts retain draft, never auto-send/ack; legacy/foreign/malformed pending cannot cross pairing', async () => {
  const requestId = '11111111-1111-4111-8111-111111111111', pendingKey = 'codex-phone-pending';
  for (const storageScope of [scope, 'b'.repeat(64), undefined]) {
    const session = deviceStorage(), storage = deviceStorage(), saved = device(storage); saved.bind(scope); saved.save({ drafts: [['fixture', '중복 전송하면 안 되는 초안']] });
    session.setItem(pendingKey, JSON.stringify({ requestId, threadId: 'fixture', storageScope, rawText: 'MUST_NOT_RESTORE' }));
    const f = await browser({ selected: false, session, storage, requestHook: path => path === '/api/requests/' + requestId ? { data: { requestId, threadId: 'fixture', state: 'uncertain' } } : null });
    await waitFor(() => storageScope === scope ? f.ui.state.errorCode === 'SEND_UNCERTAIN' : f.ui.state.activityRows.length === 2);
    if (storageScope === scope) { assert.equal(f.ui.state.pending.requestId, requestId); assert.equal(f.ui.state.pending.rawText, undefined); assert.equal(f.el('draft').value, '중복 전송하면 안 되는 초안'); assert.equal(f.el('send').disabled, true); }
    else { assert.equal(f.ui.state.pending, null); assert.ok(!f.calls.some(c => c.path.startsWith('/api/requests/'))); }
    assert.ok(!f.calls.some(c => c.path === '/api/send' || c.path.endsWith('/acknowledge')));
  }
  const session = deviceStorage(); session.setItem(pendingKey, JSON.stringify({ requestId, threadId: '../../escape', storageScope: scope }));
  const f = await browser({ selected: false, session }); assert.equal(f.ui.state.pending, null); assert.ok(!f.calls.some(c => /escape/.test(c.path)));
});
test('temporary boot network failure and failed local save do not erase RAM draft; 401 does clear it; native intent never sends or acknowledges unseen text early', async () => {
  const f = await browser({ selected: false }); await f.ui.openThread('fixture'); f.el('draft').value = '네트워크 실패에도 유지'; f.el('draft').oninput(); f.ui.persistDevice(true);
  f.storage.setItem = () => { throw 0; }; f.offline(true); await f.ui.boot(); assert.equal(f.ui.state.drafts.get('fixture'), '네트워크 실패에도 유지'); assert.match(f.el('storageStatus').textContent, /저장 실패/);
  f.offline(false); await f.ui.boot(); assert.equal(f.el('draft').value, '네트워크 실패에도 유지');
  f.windowEvents.get('codexOpenThread')({ detail: { threadId: 'other' } }); await waitFor(() => f.ui.state.selected === 'other' && !f.ui.state.restoring);
  assert.ok(!f.calls.some(c => c.path === '/api/send' || c.path.endsWith('/acknowledge'))); assert.equal(f.ui.state.drafts.get('fixture'), '네트워크 실패에도 유지');
  f.hook(path => path === '/api/session' ? { status: 401, data: { error: 'AUTH_REQUIRED' } } : null); await f.ui.boot(); assert.equal(f.ui.state.drafts.size, 0); assert.equal(f.ui.durable.scope, null);
});
