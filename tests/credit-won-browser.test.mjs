import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

const text = root => (root.textContent || '') + (root.children || []).map(text).join('');
const nodes = root => [root, ...(root.children || []).flatMap(nodes)];
const day = 86400000;
const reference = now => ({ source: 'frankfurter', base: 'USD', quote: 'KRW', state: 'ready', rate: '1339.49', date: new Date(now).toISOString().slice(0, 10), checkedAt: now, stale: false });
async function setup() {
  const now = Date.now();
  const data = { source: 'pc-codex', state: 'ready', checkedAt: now, refreshAfter: now + 60000, resetAvailableCount: 7, stale: false, fx: reference(now),
    buckets: [{ id: 'codex', label: 'Codex', primary: { remainingPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 }, credits: { balance: '1000.0000', hasCredits: true, unlimited: false } }] };
  const f = await browser({ requestHook: path => path === '/api/usage' ? { data } : null });
  await waitFor(() => !f.ui.state.usage.flight && !f.ui.state.booting && !f.ui.state.creation.checking);
  f.evaluate(`Date.now = () => ${now};`);
  return { ...f, now, data, render: () => f.evaluate('renderUsage()') };
}
test('shipped fixed-point conversion rounds ties safely, keeps tiny positives and handles maximum decimals without Number overflow or lost fractional precision', async () => {
  const f = await setup();
  for (const [balance, rate, compact, expected] of [
    ['1000', '1339.49', true, '≈53,580원'], ['1000', '1339.49', false, '≈53,580원'],
    ['1.01', '1250', false, '≈51원'], ['1.009999999999999999', '1250', false, '≈50원'],
    ['0.000000000000000001', '1339.49', true, '≈1원 미만'], ['0.019999999999999999', '1250', false, '≈1원 미만'], ['0.02', '1250', false, '≈1원'],
    ['1000000', '1250', true, '≈5,000만원'], ['2000000', '1250', true, '≈1억원'], ['20000000000', '1250', true, '≈1조원'],
    ['999999999999.999999999999999999', '100000', false, '≈4,000,000,000,000,000원'], ['999999999999.999999999999999999', '100000', true, '≈4,000조원'],
    ['0.000000000000000001', '1', false, '≈1원 미만']
  ]) assert.equal(f.evaluate(`usageWon(${JSON.stringify(balance)}, ${JSON.stringify(rate)}, ${compact})`), expected);
});
test('KRW summary/detail/accessibility retain exact credits and reference/date; FX-only changes update credit nodes without replacing quota meters or private UI state', async () => {
  const f = await setup(), buckets = f.el('usageBuckets');
  assert.equal(f.el('usageSummary').textContent, '5시간 0% (1시간 후)\n토큰 활동 · 확인 불가');
  assert.doesNotMatch(f.el('usageSummary').textContent, /크레딧/); // Credits now live in details/full accessible name, not the crowded top lines.
  assert.match(f.el('usageSummary').attributes['aria-label'], /크레딧 잔액 ≈53,580원/);
  assert.match(text(buckets), /원래 잔액: 1000\.0000 크레딧/); assert.match(text(buckets), /1크레딧 = 0.04 USD/); assert.match(text(buckets), /1 USD = 1339.49 KRW/); assert.ok(text(buckets).includes(f.data.fx.date)); assert.match(text(buckets), /Frankfurter/);
  f.el('usageSummary').onclick(); f.el('usageCriteria').open = true; f.el('usageCriteria').focus(); f.el('draft').value = '환산 중에도 보존'; f.el('history').scrollTop = 38;
  const meter = nodes(buckets).find(n => n.tagName === 'METER'), calls = f.calls.length;
  f.data.fx.rate = '1250'; f.render(); assert.match(f.el('usageSummary').title, /≈50,000원/); assert.equal(nodes(buckets).find(n => n.tagName === 'METER'), meter); assert.equal(meter.value, 0);
  f.data.fx.state = 'stale'; f.data.fx.stale = true; f.data.fx.date = new Date(f.now - 2 * day).toISOString().slice(0, 10); f.render();
  assert.match(f.el('usageSummary').title, /환율 오래됨/); assert.ok(f.el('usageSummary').title.includes(f.data.fx.date)); assert.match(text(buckets), /오래된 환율/);
  f.data.fx = reference(f.now); f.render(); assert.doesNotMatch(text(buckets), /오래된 환율/); assert.equal(nodes(buckets).find(n => n.tagName === 'METER'), meter);
  assert.equal(f.document.activeElement, f.el('usageCriteria')); assert.equal(f.el('usageCriteria').open, true); assert.equal(f.el('draft').value, '환산 중에도 보존'); assert.equal(f.el('history').scrollTop, 38); assert.equal(f.calls.length, calls);
  assert.equal(f.el('usageResets').textContent, '초기화권 7회 · 크레딧 잔액과 별도');
  f.ui.persistDevice(true); const saved = [...f.storage.values.values()].join('') + f.evaluate("[...sessionStorage.values.values()].join('')");
  for (const value of ['1000.0000', '1339.49', 'frankfurter', 'checkedAt']) assert.ok(!saved.includes(value));
  assert.ok(f.calls.every(c => c.path.startsWith('/api/'))); assert.ok(!f.calls.some(c => /send|create$/.test(c.path)));
});
test('missing/invalid/too-old FX never invents a rate or zero/USD balance; unknown and unlimited retain their own semantics and opaque additional units are never converted', async () => {
  const f = await setup();
  const invalid = [undefined, { ...reference(f.now), state: 'unavailable', rate: null }, { ...reference(f.now), rate: 1339.49 },
    ...['0', '-1', '1e3', 'Infinity', '100001', '100000.1', '1339.123456789'].map(rate => ({ ...reference(f.now), rate })),
    { ...reference(f.now), base: 'EUR' }, { ...reference(f.now), source: 'other' }, { ...reference(f.now), date: '2026-02-30' },
    { ...reference(f.now), date: new Date(f.now + day).toISOString().slice(0, 10) }, { ...reference(f.now), checkedAt: f.now - 7 * day },
    { ...reference(f.now), date: new Date(f.now - 8 * day).toISOString().slice(0, 10) }];
  for (const fx of invalid) {
    f.data.fx = fx; f.render(); assert.match(f.el('usageSummary').title, /크레딧 잔액 원화 환산 확인 불가/); assert.doesNotMatch(f.el('usageSummary').title, /≈|0원|1000/);
    assert.match(text(f.el('usageBuckets')), /원래 잔액: 1000\.0000 크레딧/); assert.match(text(f.el('usageBuckets')), /환율 확인 불가/); assert.doesNotMatch(text(f.el('usageBuckets')), /1 USD =/);
    assert.equal(f.data.buckets[0].credits.balance, '1000.0000'); assert.equal(f.data.state, 'ready'); assert.equal(f.el('usageSummary').dataset.warning, 'true'); assert.equal(f.el('usageStatus').hidden, true);
  }
  f.data.fx = reference(f.now); const credit = f.data.buckets[0].credits;
  credit.balance = null; f.render(); assert.match(f.el('usageSummary').title, /크레딧 잔액 확인 불가/); assert.doesNotMatch(text(f.el('usageBuckets')), /원래 잔액|환율:/);
  credit.balance = '0.0000'; f.render(); assert.doesNotMatch(f.el('usageSummary').title, /크레딧/); assert.doesNotMatch(text(f.el('usageBuckets')), /크레딧|환율:/);
  credit.unlimited = true; f.render(); assert.match(f.el('usageSummary').title, /크레딧 잔액 무제한/); assert.doesNotMatch(text(f.el('usageBuckets')), /환율:|원래 잔액/);
  credit.unlimited = false; credit.balance = '1000.0000'; f.data.buckets[0].id = 'bucket-2'; f.render();
  assert.match(f.el('usageSummary').title, /1000\.0000 \(단위 미확인\)/); assert.doesNotMatch(text(f.el('usageBuckets')), /원$|환율:|공개 참고가/); assert.match(text(f.el('usageBuckets')), /단위 미확인/);
});
test('offline and aged FX are explicitly dated/stale while native usage failure stays independent of a valid public FX reference', async () => {
  const f = await setup(); f.data.state = 'unavailable'; f.data.stale = true; f.render();
  assert.match(f.el('usageSummary').title, /^PC Codex 계정 잔여량 · 조회 실패 · 오래됨.*≈53,580원/); assert.doesNotMatch(text(f.el('usageBuckets')), /오래된 환율/);
  f.offline(true); f.windowEvents.get('offline')(); assert.match(f.el('usageSummary').title, /^PC Codex 계정 잔여량 · 오프라인.*환율 오래됨/); assert.match(text(f.el('usageBuckets')), /오래된 환율/); assert.ok(f.el('usageSummary').title.includes(f.data.fx.date));
  f.offline(false); f.data.state = 'ready'; f.data.stale = false; f.data.fx.checkedAt = f.now - day; f.render(); assert.match(text(f.el('usageBuckets')), /오래된 환율/);
  f.data.fx.checkedAt = f.now - 7 * day; f.render(); assert.match(f.el('usageSummary').title, /원화 환산 확인 불가/); assert.doesNotMatch(text(f.el('usageBuckets')), /1 USD =/);
});
