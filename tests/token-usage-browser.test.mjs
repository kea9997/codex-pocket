import test from 'node:test';
import assert from 'node:assert/strict';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';

test('visible local minute countdown pairs resets, never requests or rebuilds detail/focus; hidden, IME, logout stop clock', async () => {
  const f = await browser(); await waitFor(() => !f.ui.state.usage.flight);
  const now = 1800000000000;
  f.evaluate(`globalThis.testNow = ${now}; Date.now = () => testNow;`);
  f.ui.state.usage.result = { state: 'ready', checkedAt: now, buckets: [{ id: 'codex', label: 'Codex', primary: { remainingPercent: 12, windowDurationMins: 300, resetsAt: now / 1000 + 61 }, secondary: { remainingPercent: 0, windowDurationMins: 10080, resetsAt: null } }], tokenActivity: { state: 'ready', checkedAt: now, lifetimeTokens: 0, daily: [] } };
  f.evaluate('renderUsage()'); f.el('draft').focus(); f.el('history').scrollTop = 40;
  const bucket = f.el('usageBuckets').children[0], calls = f.calls.length;
  assert.match(f.el('usageSummary').textContent, /5시간 12% \(2분 후\).*주간 0% \(초기화 미상\)\n토큰 활동 · 누적 0/);
  const timer = f.timers.get(f.ui.state.usage.clock); assert.equal(timer.ms, 60000);
  f.evaluate('testNow += 60000'); timer.fn(); assert.match(f.el('usageSummary').textContent, /12% \(1분 후\)/);
  assert.equal(f.el('usageBuckets').children[0], bucket); assert.equal(f.document.activeElement, f.el('draft')); assert.equal(f.el('history').scrollTop, 40); assert.equal(f.calls.length, calls);
  assert.equal(f.timers.get(f.ui.state.usage.clock).ms, 1000); // Exact reset boundary is earlier than the next minute.
  f.evaluate('testNow += 1000'); f.timers.get(f.ui.state.usage.clock).fn(); assert.match(f.el('usageSummary').textContent, /12% \(지남·재확인\)/); assert.doesNotMatch(f.el('usageSummary').textContent, /100%/);
  f.window.visualViewport = { height: 240 }; f.windowEvents.get('resize')(); assert.equal(f.document.activeElement, f.el('draft')); assert.equal(f.calls.length, calls);
  const clock = f.ui.state.usage.clock; f.document.hidden = true; f.events.get('visibilitychange')(); assert.ok(!f.timers.has(clock)); assert.equal(f.ui.state.usage.clock, null);
  f.document.hidden = false; f.evaluate('renderUsage()'); const resumed = f.ui.state.usage.clock; assert.ok(resumed);
  f.ui.showPair(); assert.ok(!f.timers.has(resumed)); assert.equal(f.el('usageTokens').textContent, '');
});
test('token status independent of quota, safe zero, explicit recent date and stale failure; account invalidation rejects late response', async () => {
  const f = await browser(); await waitFor(() => !f.ui.state.usage.flight);
  const quota = { state: 'ready', checkedAt: Date.now(), buckets: [{ id: 'codex', primary: { remainingPercent: 75, windowDurationMins: 300, resetsAt: null }, credits: { hasCredits: true, unlimited: false, balance: '12.123456789012345678' } }] };
  f.ui.state.usage.result = quota; f.evaluate('renderUsage()');
  const credit = f.el('usageBuckets').children[0].credit, details = credit.children.find(n => n.tagName === 'DETAILS');
  assert.ok(details); assert.ok(!details.open);
  assert.match(credit.children[0].textContent, /크레딧 잔액/);
  assert.ok(details.children.some(n => /12\.123456789012345678/.test(n.textContent)));
  assert.ok(credit.children.some(n => n.tagName === 'P' && /환율 확인 불가.*다시 확인/.test(n.textContent)));
  details.open = true; details.focus(); f.evaluate('renderUsage()');
  assert.equal(f.el('usageBuckets').children[0].credit, credit); assert.equal(details.open, true); assert.equal(f.document.activeElement, details);
  for (const [tokenActivity, expected] of [
    [{ state: 'ready', lifetimeTokens: 0 }, /누적 0/],
    [{ state: 'ready', lifetimeTokens: 9007199254740991, daily: [{ startDate: '2024-02-29', tokens: 1234 }] }, /누적 9,007,199,254,740,991 · 2024-02-29 · 1,234/],
    [{ state: 'ready', lifetimeTokens: null, daily: [{ startDate: '2024-02-29', tokens: 1234 }] }, /2024-02-29 · 1,234/],
    [{ state: 'unknown', lifetimeTokens: null }, /확인 불가/],
    [{ state: 'unsupported' }, /미지원/],
    [{ state: 'unavailable', stale: true, lifetimeTokens: 123 }, /누적 123 · 조회 실패 · 오래됨/]
  ]) {
    f.ui.state.usage.result = { ...quota, tokenActivity }; f.evaluate('renderUsage()');
    assert.match(f.el('usageSummary').textContent, /5시간 75%/); assert.match(f.el('usageTokens').textContent, expected); assert.equal(f.el('usageStatus').hidden, true);
  }
  f.ui.state.usage.nextAt = 0; let release;
  f.hook(async path => path === '/api/usage' ? new Promise(resolve => { release = () => resolve({ data: { ...quota, tokenActivity: { lifetimeTokens: 999999 } } }); }) : null);
  const pending = f.evaluate('refreshUsage()'); await waitFor(() => release); f.evaluate('clearUsage()'); release(); await pending;
  assert.equal(f.ui.state.usage.result, null); assert.doesNotMatch(f.el('usageSummary').textContent, /999999/); assert.equal(f.ui.state.usage.clock, undefined);
});
