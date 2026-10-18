import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, deviceStorage } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

// Read actual text-node data, not the full-text search/copy metadata.
function displayed(root) {
  if (root.nodeType === 3) return root.data;
  if (root.tagName === 'BUTTON' || root.className === 'code-label') return '';
  return Array.from(root.childNodes || []).map(displayed).join('');
}
const nodes = root => [root, ...(root.children || []).flatMap(nodes)];
const message = (f, id = 'live') => f.ui.state.historyNodes.get(JSON.stringify(['current', id, 'agentMessage']));
const incoming = '새로 받은 한글 답변 👩🏽‍💻 🇰🇷 e\u0301 한 가족 👨‍👩‍👧‍👦. '.repeat(7);
async function setup(options = {}) {
  let items = [{ id: 'base', type: 'agentMessage', text: '처음부터 보이는 기존 답변' }], turnStatus = 'inProgress', status = 'active', checked = 100, error, liveId = 0;
  const f = await browser({ selected: false, ...options });
  f.hook(path => path.endsWith('/history') ? { data: JSON.parse(JSON.stringify({ data: [{ id: 'current', status: turnStatus, error, items }], nextCursor: 'older', status, previewCheckedAt: checked })) }
    : path.includes('/history?cursor=') ? { data: { data: [{ id: 'older', status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: '과거 기록 전체가 즉시 표시됩니다.' }] }], nextCursor: null } }
      : path.endsWith('/questions') ? { data: { state: 'ready', data: [] } } : null);
  await f.ui.openThread('fixture');
  const poll = async () => { checked++; await f.ui.refreshCurrent(); };
  return { ...f, poll, items: value => { items = value; }, currentItems: () => items,
    checked: value => { checked = value; }, turn: (value, fault) => { turnStatus = value; error = fault; status = value === 'completed' || value === 'interrupted' ? 'idle' : 'active'; },
    async start(text = incoming) { const id = liveId++ ? `live-${liveId}` : 'live'; items = [...items, { id, type: 'agentMessage', text }]; await poll(); return message(f, id); } };
}
function complete(f, ui, expected) {
  f.frame(1000); assert.equal(displayed(ui.body), expected); assert.equal(f.ui.state.reveal.active, null); assert.equal(f.frames.size, 0);
}

test('initial open/restoration, pagination, user/plan/notice and historical completed messages stay immediate', async () => {
  const f = await setup();
  assert.equal(displayed(message(f, 'base').body), '처음부터 보이는 기존 답변'); assert.equal(f.frames.size, 0);
  await f.el('moreHistory').onclick();
  const old = f.ui.state.historyNodes.get(JSON.stringify(['older', 'old', 'agentMessage']));
  assert.equal(displayed(old.body), '과거 기록 전체가 즉시 표시됩니다.'); assert.equal(f.frames.size, 0);
  f.items([...f.currentItems(), { id: 'u', type: 'userMessage', text: incoming }, { id: 'p', type: 'plan', text: incoming }, { id: 'n', type: 'requestNotice', text: incoming }]);
  await f.poll(); assert.equal(f.frames.size, 0);
  for (const kind of ['userMessage', 'plan', 'requestNotice']) assert.equal(displayed([...f.ui.state.historyNodes.values()].find(ui => ui.kind === kind).body), incoming);
  const history = f.ui.state.turns.get('older'); history.items[0].text += ' 수정';
  f.evaluate('renderHistory()'); assert.equal(displayed(old.body), '과거 기록 전체가 즉시 표시됩니다. 수정'); assert.equal(f.frames.size, 0);
  await f.ui.openThread('fixture'); assert.equal(f.frames.size, 0); assert.equal(f.ui.state.reveal.active, null);
});

test('fresh selected latest assistant text reveals actual safe text nodes in grapheme chunks within 700ms; polling/status remain independent', async () => {
  const f = await setup(), ui = await f.start(), target = incoming;
  assert.equal(displayed(ui.body), ''); assert.equal(f.frames.size, 1); assert.equal(f.ui.state.status, 'active');
  const leaves = [...f.ui.state.reveal.active.leaves].map(leaf => leaf.node), historyCalls = f.calls.filter(c => c.path.endsWith('/history')).length;
  const observation = JSON.stringify([...f.ui.state.activity]), notifications = JSON.stringify([...f.ui.state.notifications]);
  const boundaries = new Set([0, ...[...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(target)].map(p => p.index + p.segment.length)]);
  let previous = '';
  for (let ms = 0; ms < 700; ms += 50) {
    f.frame(50); const value = displayed(ui.body);
    assert.ok(value.startsWith(previous)); assert.ok(target.startsWith(value)); assert.ok(boundaries.has(value.length)); previous = value;
    if (ms === 100) assert.ok(value.length > 0 && value.length < target.length);
    assert.equal(f.calls.filter(c => c.path.endsWith('/history')).length, historyCalls);
    assert.equal(JSON.stringify([...f.ui.state.activity]), observation); assert.equal(JSON.stringify([...f.ui.state.notifications]), notifications);
  }
  assert.equal(displayed(ui.body), target); assert.equal(f.frames.size, 0); assert.equal(f.ui.state.status, 'active');
  assert.equal(ui.textParts[0].children[0].childNodes[0], leaves[0]);
  assert.equal(ui.visibleText, target.trimEnd());
});

test('unchanged polls never restart a reveal; appends keep the already visible prefix, one RAF and an absolute bounded deadline', async () => {
  const f = await setup(), ui = await f.start(); f.frame(200);
  const active = f.ui.state.reveal.active, shown = displayed(ui.body); await f.poll();
  assert.equal(f.ui.state.reveal.active, active); assert.equal(displayed(ui.body), shown); assert.equal(f.frames.size, 1);
  const firstDeadline = active.limit; let expected = incoming;
  for (let n = 0; n < 4; n++) {
    const before = displayed(ui.body); expected += ` 추가 ${n} 👩🏽‍💻`;
    f.items(f.currentItems().map(i => i.id === 'live' ? { ...i, text: expected } : i)); await f.poll();
    assert.ok(displayed(ui.body).startsWith(before)); assert.ok(expected.startsWith(displayed(ui.body)));
    assert.equal(f.frames.size, 1); assert.equal(f.ui.state.reveal.active.limit, firstDeadline); f.frame(100);
  }
  f.frame(300); assert.equal(displayed(ui.body), expected); assert.equal(f.frames.size, 0);
  await f.poll(); assert.equal(f.frames.size, 0); assert.equal(displayed(ui.body), expected);
});

test('rewrites, completion, interruption, error and removal flush without loss or a synthetic generation/completion state', async () => {
  for (const change of ['rewrite', 'completed', 'interrupted', 'error', 'remove']) {
    const f = await setup(), ui = await f.start(); f.frame(100);
    if (change === 'rewrite') f.items(f.currentItems().map(i => i.id === 'live' ? { ...i, text: '고쳐 쓴 최종 본문 👩🏽‍💻' } : i));
    else if (change === 'remove') f.items(f.currentItems().filter(i => i.id !== 'live'));
    else f.turn(change === 'error' ? 'inProgress' : change, change === 'error' ? { code: 'fixture' } : undefined);
    await f.poll(); assert.equal(f.frames.size, 0); assert.equal(f.ui.state.reveal.active, null);
    if (change === 'remove') { assert.equal(message(f), undefined); assert.equal(ui.root.isConnected, false); }
    else assert.equal(displayed(ui.body), change === 'rewrite' ? '고쳐 쓴 최종 본문 👩🏽‍💻' : incoming);
    assert.equal(f.ui.state.status, change === 'completed' || change === 'interrupted' ? 'idle' : 'active');
  }
});

test('closing a Markdown delimiter that changes the displayed prefix falls back to intact immediate markup, not lost or duplicated characters', async () => {
  const f = await setup(), ui = await f.start('첫 문장 **한글 강조'); f.frame(50);
  f.items(f.currentItems().map(i => i.id === 'live' ? { ...i, text: i.text + '**\n\n다음 문장 <script>문자 그대로</script>' } : i)); await f.poll();
  assert.equal(f.frames.size, 0); assert.equal(displayed(ui.body), '첫 문장 한글 강조다음 문장 <script>문자 그대로</script>');
  assert.equal(nodes(ui.body).filter(n => n.tagName === 'STRONG').length, 1); assert.equal(nodes(ui.body).filter(n => n.tagName === 'SCRIPT').length, 0);
});

test('explicit pointer/keyboard/selection/wheel and open tools prevent animation without changing network cadence', async () => {
  for (const event of ['pointerdown', 'keydown', 'wheel', 'selection', 'tools']) {
    const f = await setup(), ui = await f.start(); f.frame(50);
    if (event === 'selection') { f.evaluate('window.getSelection = () => ({isCollapsed: false})'); f.frame(16); }
    else if (event === 'tools') f.el('chatTools').onclick();
    else f.el('history').events.get(event)({ deltaY: -1 });
    assert.equal(displayed(ui.body), incoming); assert.equal(f.frames.size, 0);
    assert.ok([...f.timers.values()].some(timer => timer.ms === 2000));
    f.items(f.currentItems().map(i => i.id === 'live' ? { ...i, text: incoming + ' 이번 조회는 즉시' } : i)); await f.poll();
    assert.equal(displayed(ui.body), incoming + ' 이번 조회는 즉시'); assert.equal(f.frames.size, 0);
    assert.ok(!f.calls.some(c => c.path === '/api/send'));
  }
});

test('a newly delivered final item may reveal after an observed active turn, but completed old text and unobserved completed backlogs are instant', async () => {
  const f = await setup(); f.turn('completed'); const ui = await f.start();
  assert.equal(f.ui.state.status, 'idle'); assert.equal(f.frames.size, 1); complete(f, ui, incoming);
  f.items(f.currentItems().map(i => i.id === 'live' ? { ...i, text: incoming + ' 완료 뒤 정정' } : i)); await f.poll();
  assert.equal(displayed(ui.body), incoming + ' 완료 뒤 정정'); assert.equal(f.frames.size, 0);
  f.items([...f.currentItems(), { id: 'old-final', type: 'agentMessage', text: incoming }]); await f.poll();
  assert.equal(displayed(message(f, 'old-final').body), incoming); assert.equal(f.frames.size, 0);
});

test('huge batches, large old messages, excessive Markdown nodes and missing grapheme support catch up immediately with no reveal queue', async () => {
  for (const text of ['한'.repeat(4097), '한'.repeat(100000), '**단어** '.repeat(300)]) {
    const f = await setup(); await f.start(); f.frame(50);
    f.items([...f.currentItems(), { id: 'huge', type: 'agentMessage', text }]); await f.poll();
    assert.equal(f.frames.size, 0); assert.equal(f.ui.state.reveal.active, null); assert.equal(displayed(message(f, 'huge').body), text.replaceAll('**', ''));
    assert.equal(displayed(message(f).body), incoming);
  }
  const f = await setup(); f.evaluate('Intl.Segmenter = undefined'); const ui = await f.start();
  assert.equal(displayed(ui.body), incoming); assert.equal(f.frames.size, 0);
});

test('nonadvancing snapshot timestamps, stale poll gaps and slow requests are immediate, never treated as fresh live text', async () => {
  const f = await setup(); f.checked(99); const ui = await f.start(); assert.equal(displayed(ui.body), incoming); assert.equal(f.frames.size, 0);
  f.frame(13000); f.items([...f.currentItems(), { id: 'gap', type: 'agentMessage', text: incoming }]); await f.poll();
  assert.equal(displayed(message(f, 'gap').body), incoming); assert.equal(f.frames.size, 0);
  let resolve;
  f.hook(path => path.endsWith('/history') ? new Promise(done => { resolve = done; }) : null);
  const pending = f.ui.refreshCurrent(); await waitFor(() => resolve); f.frame(11000);
  resolve({ data: { data: [{ id: 'current', status: 'inProgress', items: [{ id: 'slow', type: 'agentMessage', text: incoming }] }], status: 'active', previewCheckedAt: 500 } }); await pending;
  assert.equal(displayed(message(f, 'slow').body), incoming); assert.equal(f.frames.size, 0);
});

test('reduced motion overrides the default or saved smooth preference and a live media-query change flushes immediately', async () => {
  const reduced = await setup({ reducedMotion: true }), ui = await reduced.start();
  assert.equal(reduced.ui.state.reveal.enabled, true); assert.equal(displayed(ui.body), incoming); assert.equal(reduced.frames.size, 0);
  assert.match(reduced.el('answerDisplayNote').textContent, /동작 줄이기/);
  const f = await setup(), live = await f.start(); f.frame(100); f.reducedMotion(true);
  assert.equal(displayed(live.body), incoming); assert.equal(f.frames.size, 0);
  f.el('answerSmooth').onclick(); await f.poll(); assert.equal(f.frames.size, 0); assert.equal(f.ui.state.reveal.enabled, true);
});

test('answer display preference is a session-scoped boolean only, persists across restart and resets on logout/foreign scope', async () => {
  const storage = deviceStorage(), f = await setup({ storage }); f.el('chatTools').onclick(); f.el('answerInstant').onclick();
  assert.equal(f.el('answerInstant').getAttribute?.('aria-pressed') ?? f.el('answerInstant').attributes['aria-pressed'], 'true');
  assert.equal(f.ui.durable.data.smoothAnswers, false); f.el('closeTools').onclick();
  const ui = await f.start(); assert.equal(displayed(ui.body), incoming); assert.equal(f.frames.size, 0);
  const stored = JSON.stringify([...storage.values]); assert.ok(!stored.includes(incoming)); assert.ok(!stored.includes('csrf'));
  const again = await browser({ selected: false, storage }); await waitFor(() => again.ui.state.connected && !again.ui.state.restoring);
  assert.equal(again.ui.state.reveal.enabled, false);
  const foreign = await browser({ selected: false, storage, scope: 'b'.repeat(64) }); assert.equal(foreign.ui.state.reveal.enabled, true);
  f.ui.showPair(); assert.equal(f.ui.state.reveal.enabled, true); assert.equal(f.frames.size, 0);
});

test('hidden/offline/pagehide/back/thread switch/logout and connection errors flush and cancel pending frames; catch-up is instant', async () => {
  for (const change of ['hidden', 'offline', 'pagehide', 'back', 'switch', 'logout', 'error']) {
    const f = await setup(), ui = await f.start(); f.frame(100); const late = [...f.frames.values()][0];
    if (change === 'hidden') { f.document.hidden = true; f.events.get('visibilitychange')(); }
    if (change === 'offline') { f.offline(true); f.windowEvents.get('offline')(); }
    if (change === 'pagehide') f.windowEvents.get('pagehide')();
    if (change === 'back') f.el('back').onclick();
    if (change === 'switch') await f.ui.openThread('other');
    if (change === 'logout') f.ui.showPair();
    if (change === 'error') f.ui.showError({ code: 'NETWORK' });
    assert.equal(displayed(ui.body), incoming); assert.equal(f.frames.size, 0); assert.equal(f.ui.state.reveal.active, null);
    late(500); assert.equal(f.frames.size, 0);
    if (change === 'hidden' || change === 'offline') {
      f.document.hidden = false; f.offline(false);
      f.items([...f.currentItems(), { id: 'catch-up', type: 'agentMessage', text: incoming }]); await f.poll();
      assert.equal(displayed(message(f, 'catch-up').body), incoming); assert.equal(f.frames.size, 0);
      const fresh = await f.start('再개한 새 답변 '.repeat(20)); assert.equal(f.frames.size, 1); complete(f, fresh, '再개한 새 답변 '.repeat(20));
    }
  }
});

test('going offline/hidden during an in-flight fetch invalidates eligibility even if visible again before the response', async () => {
  const f = await setup(); let resolve;
  f.hook(path => path.endsWith('/history') ? new Promise(done => { resolve = done; }) : null);
  const pending = f.ui.refreshCurrent(); const cancelled = assert.rejects(pending, e => e.code === 'STALE_RESPONSE'); await waitFor(() => resolve);
  const before = displayed(message(f, 'base').body);
  f.document.hidden = true; f.events.get('visibilitychange')(); f.document.hidden = false;
  const response = { data: { data: [{ id: 'current', status: 'inProgress', items: [{ id: 'live', type: 'agentMessage', text: incoming }] }], previewCheckedAt: 500, status: 'active' } };
  resolve(response); await cancelled;
  assert.equal(displayed(message(f, 'base').body), before); assert.equal(message(f), undefined); assert.equal(f.frames.size, 0);
  f.hook(path => path.endsWith('/history') ? response : path.endsWith('/questions') ? { data: { state: 'ready', data: [] } } : null);
  await f.windowEvents.get('pageshow')();
  assert.equal(displayed(message(f).body), incoming); assert.equal(f.frames.size, 0);
});

test('gradual height follows only while at bottom; even a small manual upward scroll flushes without chasing bottom on this or subsequent polls', async () => {
  const f = await setup(), area = f.el('history'); let top = 0;
  Object.defineProperty(area, 'scrollHeight', { get: () => 800 + [...f.ui.state.historyNodes.values()].filter(ui => ui.kind === 'agentMessage').reduce((n, ui) => n + displayed(ui.body).length, 0) });
  Object.defineProperty(area, 'scrollTop', { get: () => top, set: value => { top = Math.max(0, Math.min(area.scrollHeight - area.clientHeight, value)); } });
  area.scrollTop = area.scrollHeight; f.ui.state.reveal.top = area.scrollTop;
  const ui = await f.start(); const start = top; f.frame(100); assert.ok(top > start); assert.equal(top, area.scrollHeight - area.clientHeight);
  area.scrollTop -= 30; const away = top; area.events.get('scroll')();
  assert.equal(displayed(ui.body), incoming); assert.equal(f.frames.size, 0); assert.equal(top, away); assert.equal(f.ui.state.reveal.away, true);
  f.items(f.currentItems().map(i => i.id === 'live' ? { ...i, text: incoming + ' 뒤에 도착한 문장' } : i)); await f.poll();
  assert.equal(top, away); assert.equal(f.frames.size, 0);
  area.scrollTop = area.scrollHeight; area.events.get('scroll')(); assert.equal(f.ui.state.reveal.away, false);
  await f.poll(); await f.start('최신으로 돌아온 새 문장 '.repeat(20)); assert.equal(f.frames.size, 1);
});

test('Markdown/links/code and retained video/file controls stay intact; active appends preserve video time, source, focus and draft', async () => {
  const f = await setup(), video = { state: 'ready', kind: 'video', url: '/api/media/' + 'v'.repeat(43), alt: '생성 영상' };
  const raw = '## 기존 제목\n\n![영상](<D:/sample/movie.mp4>)\n\n기존 본문';
  const item = { id: 'live', type: 'agentMessage', text: raw, images: [{ start: raw.indexOf('!['), end: raw.indexOf('\n\n기존'), media: video }], files: [{ file: { state: 'ready', url: '/api/files/' + 'f'.repeat(43), name: '샘플.pdf' } }] };
  f.items([...f.currentItems(), item]); await f.poll(); f.frame(1000);
  const ui = message(f), movie = nodes(ui.body).find(n => n.tagName === 'VIDEO'), file = nodes(ui.body).find(n => n.className === 'result-file');
  movie.currentTime = .4; await movie.play(); const src = movie.src, detached = movie.detachCount || 0;
  const draft = f.el('draft'); draft.value = '유지할 한글 초안'; draft.focus();
  f.items(f.currentItems().map(i => i.id === 'live' ? { ...i, text: raw + '\n\n' + incoming + '\n\n[표시 링크](https://fixture.invalid/hidden)\n\n```js\nconst text = "👩🏽‍💻";\n```' } : i)); await f.poll();
  assert.equal(f.frames.size, 1); const link = nodes(ui.body).find(n => n.tagName === 'A' && n.href?.includes('fixture.invalid'));
  const code = nodes(ui.body).find(n => n.tagName === 'PRE'), codeButton = nodes(ui.body).find(n => n.className === 'code-label').children[1];
  assert.equal(link.href, 'https://fixture.invalid/hidden'); assert.ok(code); assert.equal(codeButton.textContent, '복사');
  assert.equal(nodes(ui.body).find(n => n.className === 'result-file'), file); assert.ok(nodes(file).find(n => n.tagName === 'A').textContent);
  f.frame(200); assert.equal(nodes(ui.body).find(n => n.tagName === 'VIDEO'), movie); assert.equal(movie.currentTime, .4); assert.equal(movie.src, src); assert.equal(movie.paused, false); assert.equal(movie.detachCount || 0, detached);
  assert.equal(f.document.activeElement, draft); assert.equal(draft.value, '유지할 한글 초안');
  f.el('chatTools').onclick(); assert.equal(f.frames.size, 0); assert.match(displayed(ui.body), /표시 링크/); assert.equal(codeButton.textContent, '복사');
  assert.equal(nodes(ui.body).find(n => n.tagName === 'PRE'), code); assert.equal(movie.detachCount || 0, detached);
});

test('tools/search and individual/code copy flush first and use full received text, with no auto clipboard, send or persistent chat', async () => {
  const f = await setup(), ui = await f.start(incoming + ' 검색표적'); f.frame(50);
  assert.ok(!displayed(ui.body).includes('검색표적'));
  f.el('toolSearch').onclick(); f.el('messageSearch').value = '검색표적'; f.el('messageSearch').oninput();
  assert.equal(f.frames.size, 0); assert.equal(f.ui.state.tools.matches.length, 1); assert.match(displayed(ui.body), /검색표적/);
  f.el('closeTools').onclick(); await f.poll();
  f.items(f.currentItems().map(i => i.id === 'live' ? { ...i, text: incoming + ' 검색표적\n\n```js\nconst full = "한글";\n```' } : i)); await f.poll(); assert.equal(f.frames.size, 1);
  f.evaluate('globalThis.copies = []; navigator.clipboard = { async writeText(value) { copies.push(value); } };');
  const codeButton = nodes(ui.body).find(n => n.className === 'code-label').children[1]; await codeButton.onclick();
  assert.equal(f.frames.size, 0); assert.equal(f.evaluate('copies[0]'), 'const full = "한글";\n');
  await f.poll(); assert.equal(f.frames.size, 0); // Copy invalidates the live baseline; the next successful read is immediate.
  f.items(f.currentItems().map(i => i.id === 'live' ? { ...i, text: i.text + '\n\n개별 복사 직전 새 본문 👩🏽‍💻 '.repeat(15) } : i)); await f.poll(); assert.equal(f.frames.size, 1);
  await ui.copy.onclick(); assert.equal(f.frames.size, 0); assert.equal(f.evaluate('copies[1]'), ui.visibleText); assert.match(f.evaluate('copies[1]'), /개별 복사 직전 새 본문/); assert.equal(ui.copy.textContent, '복사됨');
  assert.ok(!f.calls.some(c => c.path === '/api/send')); f.ui.persistDevice(true); assert.ok(!JSON.stringify([...f.storage.values]).includes('검색표적'));
});
