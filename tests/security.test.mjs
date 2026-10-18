import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Auth, guardRequest, guardPeer, equal, ORIGIN } from '../server/security.mjs';
import { temp } from './helpers.mjs';

const req = (method = 'GET', headers = {}) => ({ method, headers: { host: '100.64.0.10:47831', ...headers } });
const fails = (fn, code) => assert.throws(fn, e => e.code === code);
test('exact Host and Origin allowlist rejects foreign, missing mutation origin, CORS and methods', () => {
  guardRequest(req()); guardRequest(req('POST', { origin: ORIGIN }));
  for (const host of ['evil.test', '100.64.0.10', '100.64.0.10:47831.evil', '127.0.0.1:47831'])
    fails(() => guardRequest(req('GET', { host })), 'HOST_REJECTED');
  for (const origin of ['null', 'https://evil.test', 'http://100.64.0.10:47831.evil', 'http://100.64.0.11:47831'])
    fails(() => guardRequest(req('POST', { origin })), 'ORIGIN_REJECTED');
  fails(() => guardRequest(req('POST')), 'ORIGIN_REQUIRED');
  fails(() => guardRequest(req('GET', { 'sec-fetch-site': 'cross-site' })), 'CROSS_SITE_REJECTED');
  fails(() => guardRequest(req('DELETE')), 'METHOD_NOT_ALLOWED');
});
test('pairing is single-use, private, high entropy and case insensitive; cookies are hash-only on disk', t => {
  const dir = temp(t), auth = new Auth(dir); auth.issuePairing();
  const { code } = JSON.parse(readFileSync(join(dir, 'pairing.json')));
  assert.match(code, /^[0-9A-F]{16}$/);
  const { token, session } = auth.pair(code.toLowerCase(), 'phone');
  assert.equal(auth.authenticate(`codex_phone=${token}`).id, session.id);
  const disk = readFileSync(join(dir, 'sessions.json'), 'utf8'); assert.ok(!disk.includes(token));
  assert.ok(!readFileSync(join(dir, 'pairing.json'), 'utf8').includes(code));
  fails(() => auth.pair(code, 'phone'), 'PAIRING_INVALID');
  fails(() => auth.authenticate(`codex_phone=${token}; codex_phone=${token}`), 'AUTH_REQUIRED');
  fails(() => auth.authenticate('codex_phone=wrong'), 'AUTH_REQUIRED');
  assert.ok(equal('a', 'a')); assert.ok(!equal('a', 'aa')); assert.ok(!equal(null, null));
});
test('pairing rate limits apply per source and globally, including correct codes after too many attempts', t => {
  let now = 0; const auth = new Auth(temp(t), { now: () => now }); auth.issuePairing();
  for (let i = 0; i < 5; i++) fails(() => auth.pair('0'.repeat(16), 'one'), 'PAIRING_INVALID');
  fails(() => auth.pair('0'.repeat(16), 'one'), 'PAIRING_RATE_LIMIT');
  for (let i = 0; i < 15; i++) fails(() => auth.pair('0'.repeat(16), `ip-${i}`), 'PAIRING_INVALID');
  fails(() => auth.pair('0'.repeat(16), 'another'), 'PAIRING_RATE_LIMIT');
  now += 600001; fails(() => auth.pair('0'.repeat(16), 'one'), 'PAIRING_INVALID');
});
test('session expiry, persistence, CSRF session binding and revocation', t => {
  let now = 100; const dir = temp(t); let auth = new Auth(dir, { now: () => now, ttl: 1000 });
  auth.issuePairing(); const code = JSON.parse(readFileSync(join(dir, 'pairing.json'))).code;
  const { token, session } = auth.pair(code, 'a');
  auth.csrf(session, session.csrf); fails(() => auth.csrf(session, 'other'), 'CSRF_REJECTED');
  auth = new Auth(dir, { now: () => now }); assert.equal(auth.authenticate(`codex_phone=${token}`).id, session.id);
  auth.revoke(session); fails(() => auth.authenticate(`codex_phone=${token}`), 'AUTH_REQUIRED');
  auth.issuePairing(); const next = auth.pair(JSON.parse(readFileSync(join(dir, 'pairing.json'))).code, 'a');
  now += 8 * 86400000; fails(() => auth.authenticate(`codex_phone=${next.token}`), 'AUTH_REQUIRED');
});
test('only configured synthetic phone, host and self peers are accepted, including mapped IPv4', () => {
  for (const ip of ['100.64.0.11', '100.64.0.10', '127.0.0.1', '::1', '::ffff:100.64.0.11']) guardPeer(ip);
  for (const ip of [undefined, '100.64.0.12', '192.168.0.2', '8.8.8.8']) fails(() => guardPeer(ip), 'PEER_REJECTED');
});
test('unexpired unused pairing survives restart with original 24h deadline; session lasts seven days', t => {
  let now = 100; const dir = temp(t); const auth = new Auth(dir, { now: () => now }); auth.issuePairing();
  const original = JSON.parse(readFileSync(join(dir, 'pairing.json'))); assert.equal(original.expires, now + 86400000);
  now += 3600000; const restored = new Auth(dir, { now: () => now }); restored.issuePairing();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'pairing.json'))), original);
  const paired = restored.pair(original.code, 'phone'); assert.equal(paired.session.expires, now + 7 * 86400000);
});
test('expired pairing is rejected', t => {
  let now = 100; const dir = temp(t); const auth = new Auth(dir, { now: () => now }); auth.issuePairing();
  const code = JSON.parse(readFileSync(join(dir, 'pairing.json'))).code; now += 86400001;
  fails(() => auth.pair(code, 'a'), 'PAIRING_INVALID');
});
