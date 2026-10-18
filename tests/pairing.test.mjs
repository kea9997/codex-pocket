import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Auth, loadJson, saveJson } from '../server/security.mjs';
import { processPairingRequest } from '../server/pairing.mjs';
import { temp } from './helpers.mjs';

test('local file renewal rotates unused code to fresh24h without invalidating existing session or printing code', t => {
  let now = 1000; const dir = temp(t), auth = new Auth(dir, { now: () => now }); auth.issuePairing();
  const first = loadJson(join(dir, 'pairing.json'));
  const session = auth.pair(first.code, 'phone'); auth.issuePairing();
  const old = loadJson(join(dir, 'pairing.json')); now += 3600000;
  const request = { requestId: 'a'.repeat(32), requestedAt: now };
  saveJson(join(dir, 'pairing.request'), request);
  assert.equal(processPairingRequest(auth, dir), true);
  const fresh = loadJson(join(dir, 'pairing.json'));
  assert.notEqual(fresh.code, old.code); assert.equal(fresh.expires, now + 86400000);
  assert.deepEqual(loadJson(join(dir, 'pairing-renewed.json')), { requestId: request.requestId, expires: fresh.expires });
  assert.equal(existsSync(join(dir, 'pairing.request')), false);
  assert.equal(auth.authenticate(`codex_phone=${session.token}`).id, session.session.id);
  assert.throws(() => auth.pair(old.code, 'phone'), e => e.code === 'PAIRING_INVALID');
  assert.ok(auth.pair(fresh.code, 'phone'));
  saveJson(join(dir, 'pairing.request'), request);
  assert.equal(processPairingRequest(auth, dir), true);
  assert.deepEqual(loadJson(join(dir, 'pairing.json')), { used: true }); // Same request never regenerates.
});
test('local renewal refuses stale or malformed requests, never adds network endpoint', t => {
  const dir = temp(t), auth = new Auth(dir, { now: () => 1000000 }); auth.issuePairing();
  const before = loadJson(join(dir, 'pairing.json'));
  for (const request of [{ requestId: 'a'.repeat(32), requestedAt: 1 }, { requestId: '../bad', requestedAt: 1000000 }]) {
    saveJson(join(dir, 'pairing.request'), request);
    assert.throws(() => processPairingRequest(auth, dir), e => e.code === 'PAIRING_RENEWAL_INVALID');
    assert.deepEqual(loadJson(join(dir, 'pairing.json')), before);
  }
});
