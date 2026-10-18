import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenActivity, TokenUsage, TOKEN_TTL } from '../server/token-usage.mjs';
import { Rpc } from '../server/rpc.mjs';
import { fixture, waitFor, httpCall } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from '../server/http.mjs';

const payload = () => ({ summary: { lifetimeTokens: 1234567, peakDailyTokens: 45678, email: 'PRIVATE' }, dailyUsageBuckets: [{ startDate: '2026-06-18', tokens: 12345 }], get threadUsage() { throw new Error('Must not read thread details'); } });
test('token projection preserves zero, safe integers and explicit actual dates; no thread fields or coercion', () => {
  assert.deepEqual(tokenActivity(payload()), { lifetimeTokens: 1234567, peakDailyTokens: 45678, daily: [{ startDate: '2026-06-18', tokens: 12345 }] });
  for (const value of [null, undefined, -1, 0.1, '0', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const result = tokenActivity({ summary: { lifetimeTokens: value, peakDailyTokens: value }, dailyUsageBuckets: [{ startDate: '2026-01-01', tokens: value }] });
    assert.equal(result.lifetimeTokens, null); assert.equal(result.peakDailyTokens, null); assert.equal(result.daily[0].tokens, null);
  }
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) assert.equal(tokenActivity({ summary: { lifetimeTokens: value } }).lifetimeTokens, value);
  for (const startDate of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-13-01', '2026-01-00', '2026-1-01', '2026-01-01\n', 'PRIVATE', null]) assert.deepEqual(tokenActivity({ dailyUsageBuckets: [{ startDate, tokens: 0 }] }).daily, []);
  assert.equal(tokenActivity({ dailyUsageBuckets: [{ startDate: '2024-02-29', tokens: 0 }] }).daily[0].tokens, 0);
});
test('token daily projection bounds scans/results, sorts dates without timezone claims and rejects ambiguous duplicate totals', () => {
  const rows = Array.from({ length: 30 }, (_, n) => ({ startDate: `2026-01-${String(n + 1).padStart(2, '0')}`, tokens: n }));
  const result = tokenActivity({ dailyUsageBuckets: rows }); assert.equal(result.daily.length, 14); assert.equal(result.daily[0].startDate, '2026-01-30');
  assert.deepEqual(tokenActivity({ dailyUsageBuckets: Array(401).fill(rows[0]) }).daily, []);
  assert.equal(tokenActivity({ dailyUsageBuckets: [rows[0], rows[0]] }).daily[0].tokens, null);
});
test('token cache singleflight, 60-second success/failure bound, retained stale observation and unknown replacement', async () => {
  let now = 1, calls = 0, release, mode = 'success';
  const cache = new TokenUsage(async () => { calls++; if (mode === 'success') { await new Promise(r => { release = r; }); return payload(); } if (mode === 'unknown') return {}; throw { rpcCode: -32601, message: 'PRIVATE' }; }, { now: () => now });
  const a = cache.snapshot(); assert.equal(a, cache.snapshot()); await waitFor(() => release); release(); assert.equal((await a).state, 'ready');
  now += TOKEN_TTL - 1; await cache.snapshot(); assert.equal(calls, 1);
  now++; mode = 'failure'; const failed = await cache.snapshot(); assert.equal(failed.state, 'unsupported'); assert.equal(failed.stale, true); assert.equal(failed.lifetimeTokens, 1234567); assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
  await cache.snapshot(); assert.equal(calls, 2); now += TOKEN_TTL; mode = 'unknown'; const unknown = await cache.snapshot(); assert.equal(unknown.state, 'unknown'); assert.equal(unknown.lifetimeTokens, null); assert.equal(unknown.stale, false);
});
test('standalone permits only exact no-param account usage read and writes no params/thread ID', async () => {
  const rpc = new Rpc(), writes = []; rpc.child = { stdin: { write: line => writes.push(JSON.parse(line)) } };
  for (const method of ['account/tokenUsage/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume', 'account/login/start', 'account/sendAddCreditsNudgeEmail', 'thread/resume']) await assert.rejects(rpc.request(method), { code: 'METHOD_NOT_ALLOWED' });
  for (const params of [{}, null, { threadId: 'PRIVATE' }, undefined]) await assert.rejects(rpc.request('account/usage/read', params), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(writes.length, 0); const pending = rpc.request('account/usage/read'); assert.deepEqual(writes, [{ id: 1, method: 'account/usage/read' }]);
  rpc.consume(Buffer.from(JSON.stringify({ id: 1, result: { summary: { lifetimeTokens: 1234567 } } }) + '\n')); assert.equal((await pending).summary.lifetimeTokens, 1234567); rpc.fail();
});
test('engine token failure leaves quota ready; account pause clears both and rejects late result without phone revocation', async t => {
  const f = await fixture(t); f.desktop.hook = async () => ({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } });
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1');
  const first = await f.engine.usageSnapshot(); assert.equal(first.state, 'ready'); assert.equal(first.tokenActivity.state, 'unavailable');
  f.engine.resetUsage(); let release;
  f.rpc.request = async method => { assert.equal(method, 'account/usage/read'); await new Promise(r => { release = r; }); return payload(); };
  const pending = f.engine.usageSnapshot(); await waitFor(() => release);
  await f.engine.pauseAccounts(); assert.equal(f.engine.usage.view().buckets.length, 0); assert.equal(f.engine.tokenUsage.view().lifetimeTokens, null);
  release(); await assert.rejects(pending, { code: 'ACCOUNT_BUSY' });
  f.engine.resumeAccounts(); assert.equal(f.engine.tokenUsage.view().checkedAt, null);
  assert.equal(f.auth.authenticate(`codex_phone=${paired.token}`).id, paired.session.id);
});
test('authenticated usage exposes only sanitized token counters and keeps independent quota/token caches', async t => {
  const f = await fixture(t); let now = Date.now(), calls = 0;
  f.engine.now = () => now;
  f.rpc.request = async method => { assert.equal(method, 'account/usage/read'); calls++; return payload(); };
  f.desktop.hook = async () => { throw new Error('PRIVATE-quota-failure'); };
  const server = createBridge(f); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal((await httpCall(server.address().port, '/api/usage')).status, 401); assert.equal(calls, 0);
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1'), headers = { Cookie: `codex_phone=${paired.token}` };
  const result = await httpCall(server.address().port, '/api/usage', { headers });
  assert.equal(result.json.state, 'unavailable'); assert.equal(result.json.tokenActivity.state, 'ready'); assert.equal(result.json.tokenActivity.lifetimeTokens, 1234567);
  assert.deepEqual(Object.keys(result.json.tokenActivity).sort(), ['attemptedAt', 'checkedAt', 'daily', 'lifetimeTokens', 'peakDailyTokens', 'refreshAfter', 'source', 'stale', 'state']);
  assert.doesNotMatch(result.text, /PRIVATE|email|threadUsage|threadId|rpcCode/);
  for (let n = 0; n < 3; n++) await httpCall(server.address().port, '/api/usage', { headers }); assert.equal(calls, 1);
  now += TOKEN_TTL; await f.engine.usage.snapshot(); assert.equal(calls, 1); await f.engine.tokenUsage.snapshot(); assert.equal(calls, 2);
});
test('usage rejects old account after a completed token read while waiting on independent FX, including resume', async t => {
  const f = await fixture(t); f.rpc.request = async () => payload(); let release;
  f.fx.snapshot = async () => { await new Promise(r => { release = r; }); return {}; };
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1'), headers = { Cookie: `codex_phone=${paired.token}` };
  const server = createBridge(f); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const pending = httpCall(server.address().port, '/api/usage', { headers }); await waitFor(() => release && f.engine.tokenUsage.checkedAt);
  await f.engine.pauseAccounts(); f.engine.resumeAccounts(); release();
  const response = await pending; assert.equal(response.status, 409); assert.deepEqual(response.json, { error: 'ACCOUNT_CHANGED' });
  assert.equal(f.auth.authenticate(`codex_phone=${paired.token}`).id, paired.session.id);
});
