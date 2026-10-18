import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

const text = root => typeof root === 'string' ? root : (root.textContent || '') + (root.children || []).map(text).join('');
const nodes = root => [root, ...(root.children || []).flatMap(child => typeof child === 'object' ? nodes(child) : [])];
const plain = value => JSON.parse(JSON.stringify(value));
const reference = now => ({ source: 'frankfurter', base: 'USD', quote: 'KRW', rate: '1339.49', date: new Date(now).toISOString().slice(0, 10), checkedAt: now, state: 'ready', stale: false });
const snapshot = now => ({ source: 'pc-codex', state: 'ready', checkedAt: now, attemptedAt: now, refreshAfter: now + 60000, stale: false, resetAvailableCount: 7, fx: reference(now),
  buckets: [{ id: 'codex', label: 'Codex', primary: { remainingPercent: 75, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 }, secondary: { remainingPercent: 30, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 86400 }, credits: { hasCredits: true, unlimited: false, balance: '1234.567890123456789012' } }] });
async function setup(options = {}) {
  let now = Date.now(), data = snapshot(now), override = null;
  const f = await browser({ ...options, requestHook: async path => path === '/api/usage' ? override ? override() : { data } : options.requestHook?.(path) });
  await waitFor(() => !f.ui.state.usage.flight && f.ui.state.usage.result);
  f.evaluate(`globalThis.usageNow = ${now}; Date.now = () => usageNow;`);
  return { ...f, advancePerformance: f.advance, data: value => { data = value; }, override: value => { override = value; }, now: () => now,
    async refresh(value) { now += 61000; f.evaluate('usageNow += 61000'); data = value ?? snapshot(now); await f.evaluate('refreshUsage()'); },
    async advance() { now += 61000; f.evaluate('usageNow += 61000'); } };
}
test('compact usage summary and chat/list tools expose separate windows, local reset context, accessible remaining meters, exact custom durations and scope', async () => {
  const f = await setup({ selected: false });
  f.el('toolUsage').textContent = '사용 한도';
  assert.equal(f.el('usageSummary').textContent, '5시간 75% (1시간 후) · 주간 30% (1일 후)\n토큰 활동 · 확인 불가');
  assert.doesNotMatch(f.el('usageSummary').textContent, /PC Codex|남음|7일|초기화권/);
  assert.match(f.el('usageSummary').attributes['aria-label'], /PC Codex 계정 잔여량.*5시간 75% 남음.*주간 · 7일 30% 남음.*크레딧 잔액 ≈66,148원.*상세 보기/);
  f.el('usageSummary').onclick(); assert.equal(f.el('toolsDialog').open, true); assert.equal(f.ui.state.tools.pane, 'usage'); assert.equal(f.el('usagePane').hidden, false); assert.equal(f.el('toolUsage').disabled, false);
  assert.equal(f.el('toolsTitle').textContent, '사용 한도'); assert.equal(f.el('toolUsage').attributes['aria-pressed'], 'true');
  assert.equal(f.calls.filter(c => c.path === '/api/usage').length, 1);
  const meters = nodes(f.el('usageBuckets')).filter(n => n.tagName === 'METER'); assert.equal(meters.length, 2); assert.equal(meters[0].value, 75); assert.equal(meters[1].value, 30); assert.match(meters[0].attributes['aria-label'], /남은 한도 75%/);
  assert.equal(f.el('usageChecked').textContent, `마지막 성공 확인: ${f.evaluate(`usageTime(${f.now()})`)}`); assert.match(text(f.el('usageBuckets')), /초기화 예정:/);
  assert.equal(f.el('usageStatus').hidden, true); assert.equal(f.el('usageStatus').textContent, '');
  assert.match(f.el('refreshUsage').title, /최소 60초 간격 · 캐시 사용/);
  assert.equal(f.evaluate('usageTime(2000000000000)'), new Date(2000000000000).toLocaleString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }));
  const data = snapshot(f.now() + 61000); data.buckets.unshift({ id: 'bucket-2', label: '추가 한도 2', primary: { remainingPercent: 100, windowDurationMins: 90, resetsAt: null }, secondary: null });
  data.buckets.push({ id: 'bucket-3', label: '추가 한도 3', primary: { remainingPercent: null, windowDurationMins: 15, resetsAt: null }, secondary: { remainingPercent: 12.5, windowDurationMins: 2880, resetsAt: null } });
  await f.refresh(data); assert.match(f.el('usageSummary').textContent, /^5시간 75% \(1시간 후\).*주간 30% \(1일 후\)/); assert.match(f.el('usageSummary').attributes['aria-label'], /\+2개 한도/); assert.equal(f.el('usageBuckets').children.length, 3);
  assert.match(text(f.el('usageBuckets')), /1시간 30분 · 100% 남음/); assert.match(text(f.el('usageBuckets')), /15분 · 확인 불가/); assert.match(text(f.el('usageBuckets')), /2일 · 12.5% 남음/);
  assert.equal(f.evaluate('usageDuration(20)'), '20분'); assert.equal(f.evaluate('usageDuration(null)'), '기간 확인 불가');
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const scope of ['PC Codex 앱에 로그인된 계정', '모든 ChatGPT 모델의 통합 사용량이 아닙니다', '다른 도구의 사용량은 포함하지 않습니다']) assert.ok(html.includes(scope));
  f.el('closeTools').onclick(); assert.equal(f.el('toolsDialog').open, false); assert.equal(f.ui.state.selected, null);
});
test('one shipped usage summary is an app-level top grid row outside both scroll panels, with a separate non-overlay notice row and compact safe-area mobile layout', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  const stack = [], parents = new Map(), voids = new Set(['meta', 'link', 'input', 'img', 'br']);
  for (const match of html.matchAll(/<\/?[a-z][^>]*>/g)) {
    const token = match[0], tag = token.match(/^<\/?([a-z][a-z0-9]*)/)[1];
    if (token.startsWith('</')) { stack.pop(); continue; }
    const id = token.match(/\bid="([^"]+)"/)?.[1];
    if (id) parents.set(id, stack.at(-1)?.id);
    if (!voids.has(tag)) stack.push({ tag, id });
  }
  assert.equal((html.match(/id="usageSummary"/g) || []).length, 1);
  for (const id of ['usageSummary', 'activityNotice', 'sidebar', 'conversation']) assert.equal(parents.get(id), 'appView');
  assert.ok(html.indexOf('id="usageSummary"') < html.indexOf('id="activityNotice"')); assert.ok(html.indexOf('id="activityNotice"') < html.indexOf('id="sidebar"'));
  assert.match(html, /id="usageSummary"[^>]*aria-haspopup="dialog"[^>]*aria-controls="toolsDialog"/);
  const app = css.match(/\.app\{([^}]+)\}/)[1], summary = css.match(/\.usage-summary\{([^}]+)\}/)[1], notice = css.match(/\.activity-notice\{([^}]+)\}/)[1];
  assert.match(app, /display:grid/); assert.match(app, /grid-template-rows:auto auto minmax\(0,1fr\)/); assert.match(app, /height:var\(--app-height,100dvh\)/); assert.match(app, /overflow:hidden;overflow:clip/); /* clip also forbids programmatic scrolling of the shared header. */
  assert.match(summary, /grid-column:1\/-1;grid-row:1/); assert.match(summary, /display:block;min-height:44px/); assert.doesNotMatch(summary, /line-clamp|overflow:hidden|text-overflow|max-height/); assert.match(summary, /font-variant-numeric:tabular-nums/);
  assert.match(summary, /min-width:0;width:100%/); assert.match(summary, /padding:max\(8px,var\(--safe-top\)\)/);
  for (const edge of ['left', 'right']) assert.ok(summary.includes(`var(--safe-${edge})`));
  assert.doesNotMatch(summary, /position:(?:fixed|absolute)|height:100/);
  assert.match(notice, /grid-column:1\/-1;grid-row:2;position:relative/); assert.doesNotMatch(notice, /position:fixed|transform|top:/);
  assert.match(css, /\.sidebar,\.conversation\{grid-row:3\}/);
  assert.match(css, /@media\(max-width:767px\)\{\.app\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.doesNotMatch(css, /\.app\{display:block\}|\.sidebar,\.conversation\{height:100%\}/);
  assert.match(css, /\.history\{[^}]*flex:1;overflow:auto;[^}]*min-height:0/);
  assert.match(css, /\.usage-summary\[data-warning=true\]\{color:var\(--danger\)\}/);
});
test('authenticated app CSS is a fixed viewport without locking pairing document flow; keyboard resize still uses visual viewport height', async () => {
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  const app = css.match(/\.app\{([^}]+)\}/)[1];
  assert.match(app, /position:fixed;inset:0 0 auto/);
  assert.match(app, /height:100dvh;height:var\(--app-height,100dvh\)/);
  assert.match(app, /overflow:hidden;overflow:clip/); /* clip also forbids programmatic scrolling of the shared header. */ assert.doesNotMatch(app, /(?:^|;)bottom:0/);
  for (const rule of [css.match(/html,body\{([^}]+)\}/)[1], css.match(/\}body\{([^}]+)\}/)[1], css.match(/\.pair-view\{([^}]+)\}/)[1]]) {
    assert.doesNotMatch(rule, /position:(?:fixed|absolute)|overflow(?:-[xy])?:(?:hidden|clip)/);
  }
  assert.match(css, /\.pair-view\{min-height:100%;/);
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  assert.match(css, /\.sidebar\{[^}]*min-height:0;overflow-y:auto/);
  assert.match(css, /\.history\{[^}]*overflow:auto;[^}]*min-height:0/);
  // DOM/contract regression only: actual root scrollHeight and fixed positioning need Chrome rendering.
  const f = await setup({ selected: false }), properties = new Map(); await f.ui.openThread('fixture');
  f.document.documentElement.style.setProperty = (name, value) => properties.set(name, value);
  f.el('draft').value = '키보드 높이 변경에도 유지'; f.el('history').scrollTop = 25; f.el('sidebar').scrollTop = 60;
  const count = f.calls.length;
  for (const height of [420, 844, 900]) {
    f.window.visualViewport = { height }; f.windowEvents.get('resize')();
    assert.equal(properties.get('--app-height'), `${height}px`); assert.equal(f.el('appView').hidden, false);
    assert.equal(f.el('draft').value, '키보드 높이 변경에도 유지'); assert.equal(f.el('history').scrollTop, 25); assert.equal(f.el('sidebar').scrollTop, 60);
  }
  assert.equal(f.calls.length, count);
  f.ui.showPair('다시 연결'); f.window.visualViewport.height = 220; f.windowEvents.get('resize')();
  assert.equal(properties.get('--app-height'), '220px'); assert.equal(f.el('appView').hidden, true); assert.equal(f.el('pairView').hidden, false);
  assert.equal(f.el('pairStatus').textContent, '다시 연결'); assert.equal(f.calls.length, count);
});
test('the same top summary opens existing details from list and scrolled chat, retains full accessible text and prioritizes warnings before unclipped metrics', async () => {
  const f = await setup({ selected: false }), summary = f.el('usageSummary');
  summary.onclick(); assert.equal(f.el('usagePane').hidden, false); assert.equal(f.ui.state.tools.pane, 'usage'); f.el('closeTools').onclick();
  await f.ui.openThread('fixture'); f.el('history').scrollTop = 20; f.el('sidebar').scrollTop = 90;
  summary.onclick(); assert.equal(f.el('usagePane').hidden, false); assert.equal(f.el('toolsDialog').open, true); assert.equal(f.el('history').scrollTop, 20); assert.equal(f.el('sidebar').scrollTop, 90);
  await f.refresh({ ...snapshot(f.now() - 120000), stale: true, state: 'unavailable' });
  assert.equal(f.el('usageSummary'), summary); assert.match(summary.attributes['aria-label'], /^PC Codex 계정 잔여량 · 조회 실패 · 오래됨.*크레딧 잔액 ≈66,148원/); assert.equal(summary.title, summary.attributes['aria-label']);
  assert.equal(summary.dataset.warning, 'true'); assert.match(summary.textContent, /^조회 실패 · 오래됨 · .*75%/); assert.match(summary.title, /크레딧 잔액 ≈66,148원/);
  f.ui.showPair(); assert.equal(summary.attributes['aria-label'], undefined); assert.equal(summary.title, ''); assert.equal(summary.dataset.warning, 'false');
});
test('shipped usage pane puts scope/warnings and metrics before compact controls and collapsed display criteria', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const pane = html.match(/<section id="usagePane"[^>]*>([\s\S]*?)<\/section>/)[1];
  const metrics = pane.indexOf('id="usageBuckets"'), controls = pane.indexOf('class="usage-controls"'), criteria = pane.indexOf('<details');
  assert.doesNotMatch(pane.slice(0, criteria), /PC Codex 로그인|PC Codex 앱에 로그인|usage-scope/);
  assert.ok(metrics < pane.indexOf('id="usageResets"')); assert.ok(pane.indexOf('id="usageResets"') < controls);
  assert.ok(pane.indexOf('id="usageStatus"') < metrics); assert.ok(metrics < controls); assert.ok(controls < criteria);
  assert.match(pane, /<p id="usageStatus"[^>]*role="status"[^>]*hidden/);
  assert.match(pane, /<button id="refreshUsage"[^>]*aria-label="사용 한도 다시 확인">다시 확인<\/button>/);
  const help = pane.slice(criteria); assert.match(help, /^<details id="usageCriteria" class="usage-criteria">\s*<summary>표시 기준<\/summary>/);
  assert.doesNotMatch(help.match(/^<details[^>]*>/)[0], /\bopen\b/);
  for (const explanation of ['PC Codex 앱에 로그인된 계정', '모든 ChatGPT 모델의 통합 사용량이 아닙니다', '다른 도구의 사용량은 포함하지 않습니다', '사용률을 100에서 뺀 값', '초기화 예정 시각이 지나도', '최소 60초', '기기 현지 시간', '최대 8개', '추가 한도', '획득한 한도 초기화 횟수', '미제공·잘못된 값은 0으로 추정하지 않습니다']) {
    assert.ok(help.includes(explanation)); assert.ok(!pane.slice(0, metrics).includes(explanation));
  }
  assert.ok(pane.indexOf('id="usageTokens"') < metrics);
  assert.ok(pane.indexOf('id="usageTokenChecked"') < metrics);
});
test('stale/failure/past-reset warnings stay above retained metrics during refresh; recovery hides normal prose without changing criteria focus/open state', async () => {
  for (const [kind, expected] of [['stale', /오래된 관찰값/], ['failure', /조회 실패/], ['expired', /초기화 예정 시각이 지난/]]) {
    const f = await setup(), data = snapshot(f.now() - 120000);
    data.stale = true;
    if (kind === 'failure') data.state = 'unavailable';
    if (kind === 'expired') data.buckets[0].primary.resetsAt = Math.floor(f.now() / 1000) - 1;
    await f.refresh(data);
    assert.equal(f.el('usageStatus').hidden, false); assert.equal(f.el('usageStatus').dataset.warning, 'true'); assert.match(f.el('usageStatus').textContent, expected);
    const meters = nodes(f.el('usageBuckets')).filter(n => n.tagName === 'METER'); assert.equal(meters[0].value, 75); assert.match(meters[0].attributes['aria-label'], /오래된 관찰값/);
    let release; f.override(async () => { await new Promise(resolve => { release = resolve; }); return { data: snapshot(f.now()) }; });
    f.el('usageCriteria').open = true; f.el('usageCriteria').focus(); await f.advance();
    const pending = f.evaluate('refreshUsage()'); await waitFor(() => release);
    assert.equal(f.el('usageStatus').hidden, false); assert.equal(f.el('usageStatus').dataset.warning, 'true'); assert.match(f.el('usageStatus').textContent, expected); assert.match(f.el('usageStatus').textContent, /확인하고 있습니다/);
    assert.equal(nodes(f.el('usageBuckets')).find(n => n.tagName === 'METER'), meters[0]);
    release(); await pending;
    assert.equal(f.el('usageStatus').hidden, true); assert.equal(f.el('usageStatus').textContent, ''); assert.equal(f.el('usageStatus').dataset.warning, 'false');
    assert.equal(f.el('usageCriteria').open, true); assert.equal(f.document.activeElement, f.el('usageCriteria'));
    assert.equal(f.el('draft').value, '보존할 한글 초안'); assert.ok(!f.calls.some(c => c.path === '/api/send'));
  }
});
test('credit summary distinguishes zero/unlimited/unknown, rounds exact decimal observations safely and never displays a tiny positive as zero', async () => {
  const f = await setup();
  for (const [credit, compact, exact] of [
    [{ hasCredits: true, unlimited: false, balance: '1234.567890123456789012' }, '≈66,148원', '≈66,148원'],
    [{ balance: '1000' }, '≈53,580원', '≈53,580원'],
    [{ hasCredits: false, unlimited: false, balance: '0' }, null, null],
    [{ hasCredits: true, unlimited: null, balance: '0.0000' }, null, null],
    [{ balance: '9.995' }, '≈536원', '≈536원'],
    [{ balance: '12.5000' }, '≈670원', '≈670원'],
    [{ balance: '0.01' }, '≈1원 미만', '≈1원 미만'],
    [{ balance: '0.009' }, '≈1원 미만', '≈1원 미만'],
    [{ balance: '0.000000000000000001' }, '≈1원 미만', '≈1원 미만'],
    [{ balance: '1000000' }, '≈5,357.96만원', '≈53,579,600원'],
    [{ balance: '999999999999.999999999999999999' }, '≈53.58조원', '≈53,579,600,000,000원'],
    [{ hasCredits: true, unlimited: true, balance: null }, '무제한', '무제한'],
    [{ hasCredits: true, unlimited: true, balance: '1234.5000' }, '무제한', '무제한'],
    [{ hasCredits: true, unlimited: true, balance: '0.000' }, '무제한', '무제한'],
    [{ hasCredits: false, unlimited: false, balance: null }, '확인 불가', '확인 불가'],
    [{ hasCredits: true, unlimited: null, balance: null }, '확인 불가', '확인 불가'],
    [null, '확인 불가', '확인 불가'],
    [{ hasCredits: false, unlimited: false, balance: '-1' }, '확인 불가', '확인 불가'],
    [{ balance: '0\n' }, '확인 불가', '확인 불가'],
    [{ balance: 0 }, '확인 불가', '확인 불가']
  ]) {
    const data = snapshot(f.now() + 61000); data.buckets[0].credits = credit;
    await f.refresh(data);
    assert.equal(f.el('usageSummary').textContent, '5시간 75% (1시간 후) · 주간 30% (1일 후)\n토큰 활동 · 확인 불가');
    if (compact !== null) assert.equal(f.evaluate('usageCredit(state.usage.result.buckets[0].credits, true)'), compact);
    const detail = nodes(f.el('usageBuckets')).find(n => n.className === 'usage-window usage-credit');
    if (compact === null) {
      assert.equal(detail, undefined); assert.doesNotMatch(f.el('usageSummary').title, /크레딧/); assert.doesNotMatch(text(f.el('usageBuckets')), /크레딧/);
      assert.equal(f.ui.state.usage.result.buckets[0].credits.balance, credit.balance);
    } else {
      assert.ok(f.el('usageSummary').title.includes(`크레딧 잔액 ${exact}`));
      assert.ok(text(detail).includes(`크레딧 잔액 · ${exact}`)); assert.equal(nodes(detail).filter(n => n.tagName === 'METER' || n.tagName === 'BUTTON').length, 0);
      if (typeof credit?.balance === 'string' && /^[0-9.]+$/.test(credit.balance) && /[1-9]/.test(credit.balance)) assert.ok(text(detail).includes(`원래 잔액: ${credit.balance} 크레딧`));
      if (credit?.unlimited === true && credit.balance === '0.000') assert.doesNotMatch(text(detail), /원래 잔액/);
      if (credit?.unlimited === null) assert.match(text(detail), /일부 크레딧 정보 확인 불가/);
    }
    assert.equal(f.el('usageResets').textContent, '초기화권 7회 · 크레딧 잔액과 별도');
    assert.doesNotMatch(f.el('usageSummary').textContent, /초기화권|남음|PC Codex|7일/);
  }
});
test('zero→tiny positive→zero removes/restores only credit rows, retains quota zero/meters, reset count, focus, draft and Back', async () => {
  const f = await setup({ selected: false }); await f.ui.openThread('fixture'); f.el('usageSummary').onclick();
  f.el('draft').value = '0 잔액 전환에도 보존'; f.el('draft').focus(); f.el('history').scrollTop = 35;
  const data = f.ui.state.usage.result; data.buckets[0].primary.remainingPercent = 0; data.resetAvailableCount = 0; f.evaluate('renderUsage()');
  const section = f.el('usageBuckets').children[0], meter = nodes(section).find(n => n.tagName === 'METER'), count = f.calls.length;
  for (const balance of ['0', '0.000', '0.000000000000000001', '0.000000000000000000']) {
    data.buckets[0].credits.balance = balance; f.evaluate('renderUsage()');
    assert.equal(f.el('usageBuckets').children[0], section); assert.equal(nodes(section).find(n => n.tagName === 'METER'), meter); assert.equal(meter.value, 0);
    assert.equal(nodes(section).filter(n => n.className === 'usage-window usage-credit').length, balance === '0.000000000000000001' ? 1 : 0);
    assert.match(f.el('usageSummary').textContent, /^5시간 0% \(1시간 후\) · 주간 30% \(1일 후\)/); assert.doesNotMatch(f.el('usageSummary').textContent, / · $| ·  · /);
    if (balance === '0.000000000000000001') assert.match(f.el('usageSummary').title, /크레딧 잔액 ≈1원 미만/);
    else assert.doesNotMatch(f.el('usageSummary').textContent, /크레딧/);
    assert.match(f.el('usageResets').textContent, /초기화권 0회/); assert.equal(f.el('draft').value, '0 잔액 전환에도 보존'); assert.equal(f.document.activeElement, f.el('draft')); assert.equal(f.el('history').scrollTop, 35);
  }
  assert.equal(f.window.codexPhoneBack(), 'handled'); f.advancePerformance(400); assert.equal(f.window.codexPhoneBack(), 'handled');
  assert.equal(f.document.body.dataset.chat, 'false'); assert.equal(f.el('draft').value, '0 잔액 전환에도 보존'); assert.equal(f.calls.length, count);
  data.buckets = [{ id: 'codex', label: 'Codex', primary: null, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '0.000' } }];
  f.evaluate('renderUsage()'); assert.equal(f.el('usageBuckets').children.length, 0); assert.equal(text(f.el('usageBuckets')), '');
});
test('reset count stays detail-only and independent of spendable credits; count-only rendering preserves metric nodes and semantic Back/drafts', async () => {
  const f = await setup({ selected: false }); await f.ui.openThread('fixture');
  f.el('draft').value = '잔액 확인 중에도 보존'; f.el('usageSummary').onclick();
  const meter = nodes(f.el('usageBuckets')).find(n => n.tagName === 'METER');
  for (const resetAvailableCount of [0, 3, null]) {
    // Keep freshness unchanged here: a real 60s refresh also changes stale meter semantics.
    f.ui.state.usage.result.resetAvailableCount = resetAvailableCount; f.evaluate('renderUsage()');
    assert.equal(nodes(f.el('usageBuckets')).find(n => n.tagName === 'METER'), meter);
    assert.equal(f.el('usageResets').textContent, `초기화권 ${resetAvailableCount === null ? '확인 불가' : `${resetAvailableCount}회`} · 크레딧 잔액과 별도`);
    assert.match(f.el('usageSummary').title, /크레딧 잔액 ≈66,148원/);
  }
  const count = f.calls.length;
  assert.equal(f.window.codexPhoneBack(), 'handled'); assert.equal(f.el('toolsDialog').open, false); assert.equal(f.document.body.dataset.chat, 'true');
  f.advancePerformance(400); assert.equal(f.window.codexPhoneBack(), 'handled'); assert.equal(f.document.body.dataset.chat, 'false');
  assert.equal(f.el('draft').value, '잔액 확인 중에도 보존'); assert.equal(f.calls.length, count); assert.equal(f.navigation.rootExits, 0);
});
test('usage 0% is valid, unknown/null never becomes 100%, past reset remains observed percent and requests recheck', async () => {
  const f = await setup(), data = snapshot(f.now() + 61000); data.buckets[0].primary.remainingPercent = 0; data.buckets[0].secondary = null;
  await f.refresh(data); assert.match(f.el('usageSummary').textContent, /5시간 0%/); assert.equal(nodes(f.el('usageBuckets')).find(n => n.tagName === 'METER').value, 0);
  data.buckets[0].primary.resetsAt = Math.floor(f.now() / 1000) - 1;
  await f.refresh(data); assert.match(f.el('usageSummary').textContent, /오래됨.*0%/); assert.match(f.el('usageStatus').textContent, /초기화 예정 시각이 지난/); assert.match(text(f.el('usageBuckets')), /지난 시각, 재확인 필요/);
  assert.ok(!text(f.el('usageBuckets')).includes('100%'));
  await f.refresh({ ...snapshot(f.now() + 61000), state: 'unknown', buckets: [{ id: 'codex', label: 'Codex', primary: { remainingPercent: null, windowDurationMins: null, resetsAt: null }, secondary: null }] });
  assert.match(f.el('usageSummary').textContent, /확인 불가/); assert.equal(nodes(f.el('usageBuckets')).filter(n => n.tagName === 'METER').length, 0); assert.match(f.el('usageStatus').textContent, /0% 또는 100%라는 뜻이 아닙니다/);
});
test('usage unsupported/unavailable/stale/error recover without changing the composer or treating prior success as fresh', async () => {
  const f = await setup(), draft = f.el('draft').value, capability = plain(f.ui.state.capability);
  await f.refresh({ source: 'pc-codex', state: 'unsupported', checkedAt: null, attemptedAt: f.now(), stale: false, buckets: [] });
  assert.match(f.el('usageSummary').textContent, /미지원/); assert.match(f.el('usageStatus').textContent, /제공하지 않습니다/);
  await f.refresh({ ...snapshot(f.now() - 120000), state: 'unavailable', stale: true }); assert.match(f.el('usageSummary').textContent, /오래됨.*75%/); assert.match(f.el('usageStatus').textContent, /조회 실패/);
  const previous = f.ui.state.usage.result;
  f.override(() => { throw new Error('PRIVATE-network-detail'); }); await f.refresh(); assert.equal(f.ui.state.usage.result, previous); assert.equal(f.ui.state.usage.failed, true); assert.ok(!text(f.el('usageBuckets')).includes('PRIVATE'));
  assert.match(f.el('usageSummary').textContent, /^조회 실패 · 오래됨.*75%/); assert.match(text(f.el('usageBuckets')), /원래 잔액: 1234\.567890123456789012 크레딧/); assert.match(f.el('usageResets').textContent, /초기화권 7회/);
  f.offline(true); f.windowEvents.get('offline')(); assert.match(f.el('usageSummary').textContent, /^오프라인 · 오래됨.*75%/);
  f.offline(false); f.override(null); await f.windowEvents.get('online')(); await f.refresh(); assert.equal(f.ui.state.usage.failed, false); assert.doesNotMatch(f.el('usageSummary').textContent, /오래됨/);
  assert.equal(f.el('draft').value, draft); assert.deepEqual(plain(f.ui.state.capability), capability); assert.equal(f.el('send').disabled, false);
});
test('usage manual/periodic reads share one flight, respect 60s cache, pause hidden/offline/pagehide and clear private state on logout', async () => {
  const f = await setup();
  for (let n = 0; n < 10; n++) await f.el('refreshUsage').onclick(); assert.equal(f.calls.filter(c => c.path === '/api/usage').length, 1);
  let release; f.override(async () => { await new Promise(resolve => { release = resolve; }); return { data: snapshot(f.now()) }; }); await f.advance();
  const a = f.evaluate('refreshUsage()'), b = f.evaluate('refreshUsage()'); assert.equal(a, b); await waitFor(() => release); assert.equal(f.el('refreshUsage').disabled, true); assert.match(f.el('usageStatus').textContent, /확인하고 있습니다/);
  f.document.hidden = true; f.events.get('visibilitychange')(); release(); await a;
  assert.equal(f.ui.state.usage.timer, null); const count = f.calls.filter(c => c.path === '/api/usage').length;
  await f.advance(); await f.evaluate('refreshUsage()'); assert.equal(f.calls.filter(c => c.path === '/api/usage').length, count);
  f.document.hidden = false; f.override(null); f.data(snapshot(f.now())); f.events.get('visibilitychange')(); await waitFor(() => f.calls.filter(c => c.path === '/api/usage').length > count && !f.ui.state.usage.flight);
  assert.ok(f.timers.get(f.ui.state.usage.timer).ms >= 60000);
  f.offline(true); f.windowEvents.get('offline')(); assert.equal(f.ui.state.usage.timer, null); assert.match(f.el('usageSummary').textContent, /오래됨/); await f.evaluate('refreshUsage()'); assert.equal(f.el('refreshUsage').disabled, true);
  f.offline(false); await f.windowEvents.get('online')(); assert.ok(f.ui.state.usage.timer != null);
  f.windowEvents.get('pagehide')(); assert.equal(f.ui.state.usage.timer, null); await f.evaluate('refreshUsage()');
  f.ui.showPair(); assert.equal(f.ui.state.usage.result, null); assert.equal(f.ui.state.usage.flight, null); assert.equal(f.ui.state.usage.timer, null); assert.equal(text(f.el('usageBuckets')), ''); assert.equal(f.el('usageSummary').textContent, '잔여량 · 확인 전'); assert.equal(f.el('usageResets').textContent, ''); assert.ok(!JSON.stringify(plain(f.ui.state.usage)).includes('1234.567890123456789012'));
  assert.ok(f.calls.filter(c => c.path === '/api/usage').every(c => c.options.method === 'GET' && c.options.cache === 'no-store' && c.options.body === undefined)); assert.ok(!f.calls.some(c => /send|reset/.test(c.path)));
});
test('scheduled usage refresh actually reads after expiry, never earlier, and keeps exactly one usage timer', async () => {
  const f = await setup(), original = f.ui.state.usage.timer;
  assert.equal(f.timers.get(original).ms, 60000);
  await f.el('refreshUsage').onclick(); assert.equal(f.calls.filter(c => c.path === '/api/usage').length, 1);
  const timer = f.timers.get(f.ui.state.usage.timer); f.timers.delete(f.ui.state.usage.timer);
  await f.advance(); f.data(snapshot(f.now())); timer.fn();
  await waitFor(() => f.calls.filter(c => c.path === '/api/usage').length === 2 && !f.ui.state.usage.flight);
  assert.equal([...f.timers.values()].filter(t => t.ms === 60000).length, 1);
  assert.equal(f.ui.state.usage.result.checkedAt, f.now());
});
test('usage late success/401 after logout cannot repopulate private UI or invalidate a new authenticated session', async () => {
  for (const status of [200, 401]) {
    const f = await setup(); let release;
    f.override(async () => { await new Promise(resolve => { release = resolve; }); return { status, data: status === 401 ? { error: 'AUTH_REQUIRED' } : snapshot(f.now()) }; });
    await f.advance(); const pending = f.evaluate('refreshUsage()'); await waitFor(() => release); f.ui.showPair(); f.override(null); await f.ui.boot();
    await waitFor(() => f.ui.state.usage.result && !f.ui.state.usage.flight); const current = f.ui.state.usage.result;
    release(); await pending; assert.equal(f.ui.state.usage.result, current); assert.ok(f.ui.state.csrf); assert.equal(f.el('pairView').hidden, true);
  }
});
test('usage current401 uses existing pairing flow and clears the usage snapshot', async () => {
  const f = await setup(); f.override(() => ({ status: 401, data: { error: 'AUTH_REQUIRED' } })); await f.refresh();
  assert.equal(f.ui.state.csrf, null); assert.equal(f.ui.state.usage.result, null); assert.equal(f.el('pairView').hidden, false); assert.equal(text(f.el('usageBuckets')), '');
});
test('background usage updates leave real live reveal, retained media/file nodes, draft, focus, scroll and activity untouched; no usage persistence or automatic send', async () => {
  const f = await setup({ selected: false }); let checked = 100;
  const movie = { state: 'ready', kind: 'video', url: '/api/media/' + 'v'.repeat(43), alt: '합성 영상' };
  let items = [{ id: 'media', type: 'imageView', media: movie }, { id: 'file', type: 'agentMessage', text: '결과', files: [{ file: { state: 'ready', url: '/api/files/' + 'f'.repeat(43), name: '합성.pdf' } }] }];
  f.hook(path => path.endsWith('/history') ? { data: JSON.parse(JSON.stringify({ data: [{ id: 'current', status: 'inProgress', items }], status: 'active', previewCheckedAt: checked })) } : path.endsWith('/questions') ? { data: { state: 'ready', data: [] } } : path === '/api/usage' ? { data: snapshot(f.now()) } : null);
  await f.ui.openThread('fixture'); const video = nodes(f.el('messages')).find(n => n.tagName === 'VIDEO'); await video.play(); video.currentTime = .4;
  const fileRoot = [...f.ui.state.historyNodes.values()].find(n => n.assets?.some(a => a.kind === 'file')).root;
  f.el('draft').value = '초안 유지'; f.el('draft').focus(); f.el('draft').setSelectionRange(2, 2); f.el('history').scrollTop = 30;
  items.push({ id: 'live', type: 'agentMessage', text: '새 답변 한글 👩🏽‍💻. '.repeat(30) }); checked++; await f.ui.refreshCurrent(); assert.equal(f.frames.size, 1);
  f.frame(100); const active = f.ui.state.reveal.active, shown = active.shown, scroll = f.el('history').scrollTop, observation = JSON.stringify([...f.ui.state.activity]), detached = video.detachCount;
  await f.advance(); await f.evaluate('refreshUsage()');
  assert.equal(f.ui.state.reveal.active, active); assert.equal(active.shown, shown); assert.equal(f.frames.size, 1); assert.equal(f.document.activeElement, f.el('draft')); assert.equal(f.el('draft').selectionStart, 2); assert.equal(f.el('draft').value, '초안 유지'); assert.equal(f.el('history').scrollTop, scroll);
  assert.equal(nodes(f.el('messages')).find(n => n.tagName === 'VIDEO'), video); assert.equal(video.detachCount, detached); assert.equal(video.currentTime, .4); assert.equal(video.paused, false); assert.equal([...f.ui.state.historyNodes.values()].find(n => n.assets?.some(a => a.kind === 'file')).root, fileRoot); assert.equal(JSON.stringify([...f.ui.state.activity]), observation);
  f.hook(path => { if (path === '/api/usage') throw new Error('usage only network failure'); return null; }); await f.advance(); await f.evaluate('refreshUsage()'); assert.equal(f.ui.state.reveal.active, active);
  f.ui.persistDevice(true); const saved = [...f.storage.values.values()].join('') + f.evaluate("[...sessionStorage.values.values()].join('')"); for (const privateField of ['remainingPercent', 'checkedAt', 'pc-codex', 'buckets', 'credits', 'resetAvailableCount', 'hasCredits', '1234.567890123456789012']) assert.ok(!saved.includes(privateField));
  assert.ok(!f.calls.some(c => c.path === '/api/send')); f.frame(1000); assert.equal(f.ui.state.reveal.active, null);
});
