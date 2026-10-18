import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Fx, FX_URL, FX_TTL, FX_BACKOFF, FX_MAX_AGE, FX_TIMEOUT, FX_BYTES } from '../server/fx.mjs';
import { createBridge } from '../server/http.mjs';
import { fixture, httpCall, waitFor } from './helpers.mjs';

const at = Date.UTC(2026, 9, 17, 12), data = () => ({ date: '2026-10-16', base: 'USD', quote: 'KRW', rate: 1339.49 });
function clock() {
  const timers = new Map(); let id = 0;
  return { timers, setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
}
function response(body = JSON.stringify(data()), options = {}) {
  const bytes = new TextEncoder().encode(body), state = { cancelled: false }; let sent = false;
  return { status: 200, redirected: false, headers: new Headers({ 'content-type': 'application/json', ...options.headers }),
    body: { getReader() { return { async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; }, async cancel() { state.cancelled = true; } }; } }, state, ...options };
}
test('fixed public FX request has no account data, redirects or private headers; projects only validated decimal rate/date in RAM', async () => {
  let observed; const r = response(JSON.stringify({ ...data(), account: 'SECRET-raw', extra: { raw: 'SECRET' } }));
  const timer = clock(), fx = new Fx({ now: () => at, clock: timer, fetch: async (url, options) => { observed = { url, options }; return r; } });
  const result = await fx.snapshot();
  assert.equal(observed.url, FX_URL); assert.equal(FX_URL, 'https://api.frankfurter.dev/v2/rate/USD/KRW');
  assert.equal(observed.options.redirect, 'error'); assert.equal(observed.options.credentials, 'omit'); assert.deepEqual(observed.options.headers, { Accept: 'application/json' });
  assert.deepEqual(Object.keys(observed.options).sort(), ['credentials', 'headers', 'redirect', 'signal']); assert.equal(observed.options.signal.aborted, true);
  assert.deepEqual(result, { source: 'frankfurter', base: 'USD', quote: 'KRW', state: 'ready', rate: '1339.49', date: '2026-10-16', checkedAt: at, stale: false, refreshAfter: at + FX_TTL });
  assert.equal(timer.timers.size, 0); assert.equal(r.state.cancelled, true); assert.ok(!JSON.stringify(fx.view()).includes('SECRET'));
});
test('FX rejects malformed currency/date/rate schema, impossible/future/old dates, non-JSON/status/redirect/oversized headers and bodies without raw errors', async () => {
  const invalid = [null, [], {}, ...['EUR', 'usd', null].map(base => ({ ...data(), base })), { ...data(), quote: 'USD' },
    ...['2026-10-18', '2026-10-09', '2026-02-30', '2026-10-16T00:00:00Z', '2026-1-01', null].map(date => ({ ...data(), date })),
    ...[0, -1, 0.99, 100001, 1.123456789, '1339.49', null, true, {}].map(rate => ({ ...data(), rate }))];
  const cases = invalid.map(value => () => response(JSON.stringify(value)));
  cases.push(() => response('SECRET-not-json'), () => response('{'), () => response('x'.repeat(FX_BYTES + 1)),
    () => response(undefined, { status: 302 }), () => response(undefined, { redirected: true }), () => response(undefined, { status: 503 }),
    () => response(undefined, { headers: new Headers({ 'content-type': 'text/html' }) }),
    ...['4097', '99999999999999', '-1', 'NaN'].map(length => () => response(undefined, { headers: new Headers({ 'content-type': 'application/json', 'content-length': length }) })));
  for (const make of cases) {
    const timer = clock(), fx = new Fx({ now: () => at, clock: timer, fetch: async () => make() });
    const result = await fx.snapshot(); assert.equal(result.state, 'unavailable'); assert.equal(result.rate, null); assert.equal(result.refreshAfter, at + FX_BACKOFF); assert.equal(timer.timers.size, 0); assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
  for (const date of ['2026-10-17', '2026-10-16', '2026-10-14', '2026-10-10']) {
    const result = await new Fx({ now: () => at, fetch: async () => response(JSON.stringify({ ...data(), date })) }).snapshot();
    assert.notEqual(result.state, 'unavailable'); assert.equal(result.date, date); // Weekends and a bounded holiday lag are accepted.
  }
});
test('one 2.5s whole-body deadline bounds hung headers and a slowly dripping/hung body, aborts/cancels and clears timer without resetting on chunks', async () => {
  for (const body of [false, true]) {
    const timer = clock(); let signal, reads = 0, cancelled = false;
    const fx = new Fx({ now: () => at, clock: timer, fetch: async (_url, options) => {
      signal = options.signal; if (!body) return new Promise(() => {});
      return { ...response(), body: { getReader() { return { read() { reads++; return reads === 1 ? Promise.resolve({ done: false, value: new TextEncoder().encode('{') }) : new Promise(() => {}); }, async cancel() { cancelled = true; } }; } } };
    } });
    const a = fx.snapshot(), b = fx.snapshot(); assert.equal(a, b); await waitFor(() => signal && (!body || reads === 2));
    assert.equal(timer.timers.size, 1); const deadline = [...timer.timers.values()][0]; assert.equal(deadline.ms, FX_TIMEOUT); assert.equal(FX_TIMEOUT, 2500);
    deadline.fn(); const result = await a; assert.equal(result.state, 'unavailable'); assert.equal(signal.aborted, true); assert.equal(cancelled, body); assert.equal(timer.timers.size, 0); assert.equal(fx.flight, null);
  }
});
test('timed-out late headers cannot overwrite a newer FX success; exact byte ceiling is accepted and an overflowing multi-chunk body is cancelled', async () => {
  let now = at, release, calls = 0; const timer = clock();
  const fx = new Fx({ now: () => now, clock: timer, fetch: async () => { if (++calls === 1) return new Promise(resolve => { release = resolve; }); return response(JSON.stringify({ ...data(), rate: 1400 })); } });
  const first = fx.snapshot(); [...timer.timers.values()][0].fn(); assert.equal((await first).state, 'unavailable');
  now += FX_BACKOFF; assert.equal((await fx.snapshot()).rate, '1400'); release(response()); await new Promise(resolve => setImmediate(resolve)); assert.equal(fx.view().rate, '1400'); assert.equal(timer.timers.size, 0);
  const padded = JSON.stringify(data()).padEnd(FX_BYTES, ' ');
  assert.equal((await new Fx({ now: () => at, fetch: async () => response(padded) }).snapshot()).state, 'ready');
  let reads = 0, cancelled = false;
  const over = new Fx({ now: () => at, fetch: async () => ({ ...response(), body: { getReader() { return { async read() { reads++; return { done: false, value: new Uint8Array(1024).fill(32) }; }, async cancel() { cancelled = true; } }; } } }) });
  assert.equal((await over.snapshot()).state, 'unavailable'); assert.equal(reads, 5); assert.equal(cancelled, true);
});
test('FX shares one flight, caches success 24h and failure 15m, labels retained stale data, recovers and stops using rates after finite max age', async () => {
  let now = at, calls = 0, release, fail = false, current = data();
  const fx = new Fx({ now: () => now, fetch: async () => { calls++; await new Promise(resolve => { release = resolve; }); if (fail) throw new Error('SECRET-network'); return response(JSON.stringify(current)); } });
  const a = fx.snapshot(), b = fx.snapshot(); assert.equal(a, b); release(); assert.equal((await a).state, 'ready');
  now += FX_TTL - 1; for (let i = 0; i < 20; i++) await fx.snapshot(); assert.equal(calls, 1);
  now++; fail = true; const failure = fx.snapshot(); release(); const stale = await failure;
  assert.equal(stale.state, 'stale'); assert.equal(stale.stale, true); assert.equal(stale.date, '2026-10-16'); assert.equal(stale.checkedAt, at); assert.equal(stale.refreshAfter, now + FX_BACKOFF); assert.ok(!JSON.stringify(stale).includes('SECRET'));
  now += FX_BACKOFF - 1; await fx.snapshot(); assert.equal(calls, 2);
  now++; fail = false; current = { ...data(), date: '2026-10-18', rate: 1340 }; const recovering = fx.snapshot(); release(); const recovered = await recovering;
  assert.equal(recovered.state, 'ready'); assert.equal(recovered.rate, '1340'); assert.equal(calls, 3);
  now += FX_MAX_AGE; assert.equal(fx.view().state, 'unavailable'); assert.equal(fx.view().date, null); assert.equal(fx.view().rate, null);
});
test('FX network failure without a baseline is unavailable, independently backoffs and never exposes exception details', async () => {
  let calls = 0, now = at; const fx = new Fx({ now: () => now, fetch: async () => { calls++; throw new Error('SECRET connection detail'); } });
  for (let i = 0; i < 10; i++) assert.equal((await fx.snapshot()).rate, null); assert.equal(calls, 1);
  now += FX_BACKOFF; assert.equal((await fx.snapshot()).state, 'unavailable'); assert.equal(calls, 2); assert.ok(!JSON.stringify(fx.view()).includes('SECRET'));
});
test('authenticated usage adds optional public FX independent of native failure/success; auth/query guards prevent fetch and expiry during FX wait returns401', async t => {
  const f = await fixture(t); let now = at, fxCalls = 0, release;
  f.desktop.hook = async () => { throw new Error('SECRET-native'); };
  const fx = new Fx({ now: () => now, fetch: async () => { fxCalls++; await new Promise(resolve => { release = resolve; }); return response(); } });
  const server = createBridge({ ...f, fx }); await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, options) => httpCall(server.address().port, path, options);
  assert.equal((await call('/api/usage')).status, 401); assert.equal(fxCalls, 0);
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1'), headers = { Cookie: `codex_phone=${paired.token}` };
  assert.equal((await call('/api/usage?url=https://evil.invalid', { headers })).status, 400); assert.equal(fxCalls, 0);
  const pending = call('/api/usage', { headers }); await waitFor(() => release); release(); const result = await pending;
  assert.equal(result.json.state, 'unavailable'); assert.equal(result.json.fx.state, 'ready'); assert.ok(!result.text.includes('SECRET'));
  f.engine.usage.refreshAfter = 0; f.desktop.hook = async () => ({ rateLimitsByLimitId: { codex: { credits: { balance: '1000', hasCredits: true, unlimited: false } } } });
  assert.equal((await call('/api/usage', { headers })).json.state, 'ready'); assert.equal(fxCalls, 1);
  const fetch = fx.fetch; fx.fetch = async () => { fxCalls++; throw new Error('SECRET-fx-network'); }; now += FX_TTL;
  const fxFailure = await call('/api/usage', { headers }); assert.equal(fxFailure.json.state, 'ready'); assert.equal(fxFailure.json.fx.state, 'stale'); assert.ok(!fxFailure.text.includes('SECRET'));
  assert.equal((await call('/api/fx?url=https://evil.invalid', { headers })).status, 404);
  fx.fetch = fetch; now += FX_BACKOFF; release = null; const late = call('/api/usage', { headers }); await waitFor(() => release); f.auth.revoke(paired.session); release();
  const denied = await late; assert.equal(denied.status, 401); assert.deepEqual(denied.json, { error: 'AUTH_REQUIRED' }); assert.equal(f.engine.records.length, 0); assert.ok(f.desktop.calls.every(c => c.tool === 'get_usage_limits'));
});
