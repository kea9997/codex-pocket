import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Usage, usageBuckets, USAGE_TTL } from '../server/usage.mjs';
import { createBridge } from '../server/http.mjs';
import { fixture, httpCall, waitFor } from './helpers.mjs';

const window = (usedPercent = 25, windowDurationMins = 300, resetsAt = 2000000000) => ({ usedPercent, windowDurationMins, resetsAt });
const credit = (balance = '1234.567890123456789012') => ({ hasCredits: true, unlimited: false, balance });
const payload = () => ({ rateLimitsByLimitId: { codex: { primary: window(), secondary: window(70, 10080), credits: credit() } }, rateLimitResetCredits: { availableCount: 7, credits: [{ id: 'SECRET-reset', title: 'SECRET-title', description: 'SECRET-description' }] } });
test('usage prefers the modern map (even empty), keeps independent buckets and falls back only without a valid map', () => {
  const data = payload(); data.rateLimits = { limitId: 'legacy', primary: window(99) };
  data.rateLimitsByLimitId.other = { primary: window(5, 90), secondary: null };
  assert.deepEqual(usageBuckets(data), [
    { id: 'codex', label: 'Codex', primary: { remainingPercent: 75, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { remainingPercent: 30, windowDurationMins: 10080, resetsAt: 2000000000 }, credits: credit() },
    { id: 'bucket-2', label: '추가 한도 2', primary: { remainingPercent: 95, windowDurationMins: 90, resetsAt: 2000000000 }, secondary: null, credits: null }
  ]);
  assert.deepEqual(usageBuckets({ ...data, rateLimitsByLimitId: {} }), []);
  for (const rateLimitsByLimitId of [null, undefined, [], 'bad']) assert.equal(usageBuckets({ rateLimitsByLimitId, rateLimits: { limitId: 'codex', primary: window(0) } })[0].primary.remainingPercent, 100);
  assert.deepEqual(usageBuckets({}), []); assert.deepEqual(usageBuckets(null), []);
});
test('usage null/missing/invalid is not zero; percentages clamp; duration/reset accept bounded finite integer numbers only', () => {
  for (const [used, remaining] of [[0, 100], [100, 0], [-10, 100], [110, 0], [12.5, 87.5], [null, null], [undefined, null], ['0', null], [true, null], [NaN, null], [Infinity, null], [{}, null]]) {
    assert.equal(usageBuckets({ rateLimits: { primary: { ...window(), usedPercent: used } } })[0].primary.remainingPercent, remaining);
  }
  const missing = usageBuckets({ rateLimits: { primary: {}, secondary: null } })[0];
  assert.deepEqual(missing.primary, { remainingPercent: null, windowDurationMins: null, resetsAt: null }); assert.equal(missing.secondary, null);
  for (const bad of [0, -1, NaN, Infinity, '300', true, null, {}, 1.5, Number.MAX_SAFE_INTEGER]) {
    const w = usageBuckets({ rateLimits: { primary: window(100, bad, bad) } })[0].primary;
    assert.equal(w.remainingPercent, 0); assert.equal(w.windowDurationMins, null); assert.equal(w.resetsAt, null);
  }
  for (const bad of [false, [], 'text', 0]) assert.equal(usageBuckets({ rateLimits: { primary: bad } })[0].primary, null);
});
test('usage bounds eight buckets, prioritizes codex and projects only whitelisted windows/credit observations, never native names or private fields', () => {
  const data = { accountId: 'SECRET-account', ordinaryUsageAllowed: false, credits: { balance: 'SECRET-balance' }, rateLimitResetCredits: { credits: [{ id: 'SECRET-reset' }] }, rateLimitsByLimitId: {} };
  for (let n = 0; n < 20; n++) data.rateLimitsByLimitId[`SECRET-${n}`] = { limitId: 'SECRET-id', limitName: '<img>SECRET-name', accountId: 'SECRET-account', primary: { ...window(), token: 'SECRET-token' } };
  data.rateLimitsByLimitId.codex = { primary: window(100), secondary: window(0), credits: { ...credit('0'), accountId: 'SECRET-credit-account', planType: 'SECRET-plan', title: 'SECRET-title' } };
  const buckets = usageBuckets(data); assert.equal(buckets.length, 8); assert.equal(buckets[0].id, 'codex'); assert.ok(!JSON.stringify(buckets).includes('SECRET'));
  assert.ok(!JSON.stringify(buckets).includes('<img>')); assert.deepEqual(Object.keys(buckets[0]), ['id', 'label', 'primary', 'secondary', 'credits']);
  assert.deepEqual(buckets[0].credits, credit('0')); assert.deepEqual(Object.keys(buckets[0].credits), ['hasCredits', 'unlimited', 'balance']);
});
test('credit decimal observations are exact, bounded, string-only and independent of booleans; modern/legacy precedence is unchanged', () => {
  const parse = credits => usageBuckets({ rateLimits: { credits } })[0].credits;
  for (const balance of ['0', '0.0000', '1', '1234.567890123456789012', '0.000000000000000001', '999999999999.999999999999999999']) {
    assert.deepEqual(parse(credit(balance)), credit(balance));
  }
  for (const balance of [undefined, null, '', ' ', ' 0', '0 ', '0\n', '1\r\n', '+1', '-0', '-1', '01', '.1', '1.', '1e3', '1,000', 'NaN', 'Infinity', '1000000000000', '0.0000000000000000001', '9'.repeat(10000), '<img>', true, false, 0, 1.5, NaN, Infinity, {}, []]) {
    assert.equal(parse({ ...credit(), balance }).balance, null, `invalid ${String(balance).slice(0, 40)}`);
  }
  for (const value of [null, undefined, false, 0, [], '0']) assert.equal(parse(value), null);
  for (const flag of [null, undefined, 0, 1, 'true', [], {}]) assert.deepEqual(parse({ balance: '0', hasCredits: flag, unlimited: flag }), { balance: '0', hasCredits: null, unlimited: null });
  assert.deepEqual(parse({ hasCredits: false, unlimited: false }), { balance: null, hasCredits: false, unlimited: false });
  assert.deepEqual(parse({ hasCredits: true, unlimited: true, balance: null }), { balance: null, hasCredits: true, unlimited: true });
  const data = { rateLimitsByLimitId: { codex: { credits: credit('2.30') } }, rateLimits: { limitId: 'codex', credits: credit('9') } };
  assert.equal(usageBuckets(data)[0].credits.balance, '2.30');
  assert.deepEqual(usageBuckets({ ...data, rateLimitsByLimitId: {} }), []);
  assert.equal(usageBuckets({ ...data, rateLimitsByLimitId: null })[0].credits.balance, '9');
});
test('reset count is a bounded authoritative number, never opaque detail length; credit-only and reset-only observations can be ready', async () => {
  const observe = async data => new Usage({ async call() { return data; } }).snapshot();
  for (const availableCount of [0, 7, 1000000]) for (const details of [null, [], [{ id: 'SECRET-id', title: 'SECRET-title' }]]) {
    const result = await observe({ rateLimitResetCredits: { availableCount, credits: details } });
    assert.equal(result.resetAvailableCount, availableCount); assert.equal(result.state, 'ready'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
  for (const availableCount of [null, undefined, -1, 0.1, '0', false, true, NaN, Infinity, 1000001, Number.MAX_SAFE_INTEGER]) {
    const result = await observe({ rateLimitResetCredits: { availableCount, credits: [{ id: 'SECRET-id' }] } });
    assert.equal(result.resetAvailableCount, null); assert.equal(result.state, 'unknown');
  }
  for (const credits of [credit('0'), credit('0.000000000000000001'), { unlimited: true }]) assert.equal((await observe({ rateLimits: { credits } })).state, 'ready');
  for (const credits of [{ hasCredits: false }, { hasCredits: true, balance: null }, { unlimited: false }, credit('-1')]) assert.equal((await observe({ rateLimits: { credits } })).state, 'unknown');
  assert.equal((await observe({})).resetAvailableCount, null);
});
test('usage shared single-flight caches successes and failures for 60s; no fallback, send or reset; past reset never invents new remaining', async () => {
  let now = 1000000, calls = 0, release, mode = 'ready';
  const usage = new Usage({ async call(tool, args) { calls++; assert.equal(tool, 'get_usage_limits'); assert.deepEqual(args, {});
    if (mode === 'ready') { await new Promise(resolve => { release = resolve; }); return payload(); }
    throw Object.assign(new Error('SECRET-native-detail'), { code: mode === 'unsupported' ? 'DESKTOP_TOOL_UNSUPPORTED' : 'SECRET-raw-code' });
  } }, { now: () => now });
  const a = usage.snapshot(), b = usage.snapshot(); assert.equal(a, b); await waitFor(() => release); release();
  const ready = await a; assert.equal(ready.state, 'ready'); assert.equal(ready.stale, false); assert.equal(ready.checkedAt, now); assert.equal(calls, 1);
  assert.equal(ready.resetAvailableCount, 7); assert.deepEqual(ready.buckets[0].credits, credit());
  for (let n = 0; n < 30; n++) await usage.snapshot(); assert.equal(calls, 1);
  now += USAGE_TTL - 1; await usage.snapshot(); assert.equal(calls, 1);
  now++; mode = 'failure'; const failed = await usage.snapshot(); assert.equal(calls, 2); assert.equal(failed.state, 'unavailable'); assert.equal(failed.stale, true); assert.equal(failed.checkedAt, 1000000); assert.deepEqual(failed.buckets, ready.buckets); assert.equal(failed.resetAvailableCount, 7); assert.ok(!JSON.stringify(failed).includes('SECRET'));
  await usage.snapshot(); assert.equal(calls, 2);
  now += USAGE_TTL; mode = 'unsupported'; assert.equal((await usage.snapshot()).state, 'unsupported'); assert.equal(calls, 3);
  now += USAGE_TTL; mode = 'ready'; release = null; const recovering = usage.snapshot(); await waitFor(() => release); release(); assert.equal((await recovering).state, 'ready'); assert.equal(calls, 4);
  usage.buckets[0].primary.resetsAt = Math.floor(now / 1000) - 1;
  const expired = await usage.snapshot(); assert.equal(expired.stale, true); assert.equal(expired.buckets[0].primary.remainingPercent, 75); assert.equal(calls, 4);
});
test('credit/reset cache retains only sanitized observations on failure and replaces them, including unknown, on the next success', async () => {
  let now = 1, data = payload(), failed = false, calls = 0;
  const usage = new Usage({ async call(tool) { calls++; assert.equal(tool, 'get_usage_limits'); if (failed) throw new Error('SECRET-detail'); return data; } }, { now: () => now });
  await usage.snapshot(); now += USAGE_TTL; failed = true;
  const stale = await usage.snapshot(); assert.equal(stale.stale, true); assert.deepEqual(stale.buckets[0].credits, credit()); assert.equal(stale.resetAvailableCount, 7);
  assert.ok(!JSON.stringify(usage).includes('SECRET')); await usage.snapshot(); assert.equal(calls, 2);
  now += USAGE_TTL; failed = false; data = { rateLimits: { credits: credit('0') }, rateLimitResetCredits: { availableCount: 0, credits: Array(3).fill({ id: 'SECRET-id' }) } };
  const recovered = await usage.snapshot(); assert.equal(recovered.stale, false); assert.equal(recovered.state, 'ready'); assert.equal(recovered.buckets[0].credits.balance, '0'); assert.equal(recovered.resetAvailableCount, 0);
  now += USAGE_TTL; data = { rateLimits: { credits: { hasCredits: false, unlimited: false } } };
  const unknown = await usage.snapshot(); assert.equal(unknown.state, 'unknown'); assert.equal(unknown.buckets[0].credits.balance, null); assert.equal(unknown.resetAvailableCount, null); assert.equal(unknown.stale, false);
});
test('usage unavailable without baseline is empty/unknown, recovery can be valid 0%, malformed successful windows stay unknown', async () => {
  let now = 1, data = null;
  const usage = new Usage({ async call() { if (data === null) throw new Error('private'); return data; } }, { now: () => now });
  const first = await usage.snapshot(); assert.equal(first.state, 'unavailable'); assert.equal(first.checkedAt, null); assert.deepEqual(first.buckets, []);
  now += USAGE_TTL; data = { rateLimits: { primary: {} } }; assert.equal((await usage.snapshot()).state, 'unknown');
  now += USAGE_TTL; data = { rateLimits: { primary: window(100) } }; const zero = await usage.snapshot(); assert.equal(zero.state, 'ready'); assert.equal(zero.buckets[0].primary.remainingPercent, 0);
});
test('authenticated usage GET rejects every query/mutation, sanitizes errors/payload and persists no snapshot; chat capability stays independent', async t => {
  const f = await fixture(t); f.desktop.hook = async tool => { assert.equal(tool, 'get_usage_limits'); return { ...payload(), accountId: 'SECRET-account', ordinaryUsageAllowed: false, credits: { balance: 7 } }; };
  const server = createBridge(f); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, options) => httpCall(server.address().port, path, options);
  assert.equal((await call('/api/usage')).status, 401); assert.equal(f.desktop.calls.length, 0);
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1'), headers = { Cookie: `codex_phone=${paired.token}` };
  for (const q of ['?', '?refresh=1', '?tool=consume_usage_reset', '?x=1&x=2', '?path=secret']) assert.equal((await call('/api/usage' + q, { headers })).status, 400);
  const result = await call('/api/usage', { headers }); assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.json.state, 'ready');
  assert.deepEqual(Object.keys(result.json).sort(), ['attemptedAt', 'buckets', 'checkedAt', 'fx', 'refreshAfter', 'resetAvailableCount', 'source', 'stale', 'state', 'tokenActivity']);
  assert.deepEqual(result.json.buckets, usageBuckets(payload())); assert.equal(result.json.resetAvailableCount, 7);
  for (const secret of ['SECRET', paired.token, paired.session.csrf, 'accountId', 'rateLimitResetCredits', 'planType', 'description', 'ordinaryUsageAllowed']) assert.ok(!result.text.includes(secret));
  assert.equal(f.engine.capability().continuationEnabled, true);
  const mutate = { ...headers, Origin: 'http://100.64.0.10:47831', 'X-Codex-CSRF': paired.session.csrf };
  assert.equal((await call('/api/usage', { method: 'POST', headers: mutate, data: {} })).status, 404);
  assert.equal((await call('/api/usage', { method: 'DELETE', headers })).status, 405);
  for (let n = 0; n < 10; n++) await call('/api/usage', { headers }); assert.equal(f.desktop.calls.length, 1); assert.deepEqual(f.calls, [{ method: 'account/usage/read', params: undefined }]); assert.equal(f.engine.records.length, 0);
  for (const name of [...readdirSync(f.dir).filter(name => name !== 'uploads'), 'uploads/index.json']) for (const field of ['remainingPercent', 'resetAvailableCount', 'hasCredits', '1234.567890123456789012', 'SECRET-reset']) assert.ok(!readFileSync(join(f.dir, name), 'utf8').includes(field));
  f.engine.now = () => Date.now() + USAGE_TTL * 2; f.desktop.hook = async () => { throw Object.assign(new Error('SECRET-stack'), { code: 'SECRET-code' }); };
  const failed = await call('/api/usage', { headers }); assert.equal(failed.status, 200); assert.equal(failed.json.state, 'unavailable'); assert.equal(failed.json.stale, true); assert.ok(!failed.text.includes('SECRET'));
});
test('usage response rechecks the authenticated owner after an in-flight logout', async t => {
  const f = await fixture(t); let release;
  f.desktop.hook = async () => { await new Promise(resolve => { release = resolve; }); return payload(); };
  const server = createBridge(f); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1'), headers = { Cookie: `codex_phone=${paired.token}` };
  const pending = httpCall(server.address().port, '/api/usage', { headers }); await waitFor(() => release);
  const logout = await httpCall(server.address().port, '/api/logout', { method: 'POST', data: {}, headers: { ...headers, Origin: 'http://100.64.0.10:47831', 'Content-Type': 'application/json', 'X-Codex-CSRF': paired.session.csrf } }); assert.equal(logout.status, 200);
  release(); const result = await pending; assert.equal(result.status, 401); assert.deepEqual(result.json, { error: 'AUTH_REQUIRED' });
});
