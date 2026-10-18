import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPreview } from '../tools/ui-preview.mjs';
import { assets } from '../server/http.mjs';
import { browser } from './browser-fixture.mjs';
import { httpCall } from './helpers.mjs';

test('loopback preview exposes explicit synthetic registration/switch/blocked/failure/recovery states and exact shipped account assets, never real credentials', async t => {
  const server = createPreview(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, options = {}) => httpCall(server.address().port, path, { ...options, headers: { Host: '127.0.0.1:47832', Origin: 'http://127.0.0.1:47832', ...options.headers } });
  const post = (path, input = {}, csrf = 'sample-not-a-credential') => call(path, { method: 'POST', data: input, headers: { 'X-Codex-CSRF': csrf } });
  const html = await call('/'); assert.match(html.text, /계정 화면 샘플 · 실제 계정\/로그인\/재시작 없음/);
  assert.equal((await call('/accounts.js')).text, assets.get('/accounts.js').data.toString());
  assert.equal((await post('/sample/accounts', {}, 'wrong')).status, 403); assert.equal((await post('/sample/accounts?', {})).status, 400);
  assert.equal((await post('/api/accounts/login', { operationId: randomUUID(), label: '샘플', executable: 'forbidden' })).status, 400);
  const snapshots = [(await call('/api/accounts')).json];
  for (let i = 0; i < 8; i++) { await post('/sample/accounts'); snapshots.push((await call('/api/accounts')).json); }
  assert.equal(snapshots[0].switchSupported, false); assert.equal(snapshots[1].switchSupported, true);
  assert.equal(snapshots[2].operation.state, 'waiting'); assert.equal(snapshots[2].operation.device.code, 'DEMO-0000'); assert.equal(snapshots[3].operation.kind, 'login');
  assert.equal(snapshots[4].busy, true); assert.equal(snapshots[5].error, 'ACCOUNT_TASKS_ACTIVE'); assert.equal(snapshots[6].error, 'ACCOUNT_LOGIN_EXPIRED');
  assert.equal(snapshots[7].recovery, true); assert.equal(snapshots[8].verification, 'shared-login-and-restarted-app');
  for (const snapshot of snapshots) { assert.ok(snapshot.profiles.every(p => p.email.endsWith('.invalid'))); for (const secret of ['refresh_token', 'access_token', 'auth.json', 'D:/CodexPhoneData']) assert.ok(!JSON.stringify(snapshot).includes(secret)); }
  const f = await browser({ selected: false });
  f.hook(async (path, options) => { const r = await call(path, { method: options.method, data: options.body, headers: { 'Content-Type': 'application/json', 'X-Codex-CSRF': 'sample-not-a-credential' } }); return { data: r.json, status: r.status }; });
  const session = (await call('/api/session')).json; f.ui.state.accounts.revision = session.accountRevision;
  await f.el('refreshAccounts').onclick(); assert.equal(f.ui.state.accounts.result.verification, 'shared-login-and-restarted-app');
  await post('/sample/accounts'); await post('/sample/accounts'); // restriction -> selectable sample
  await f.el('refreshAccounts').onclick(); f.el('accountProfiles').children[1].choose.click(); assert.equal(f.el('switchAccount').disabled, true);
  f.el('accountPcIdle').click(); assert.equal(f.el('switchAccount').disabled, false);
  const action = f.el('switchAccount').click(); assert.equal(f.el('accountConfirmDialog').open, true);
  assert.ok(!f.calls.some(c => c.path === '/api/accounts/switch')); f.el('approveAccountConfirmation').click(); await action;
  assert.equal(f.ui.state.accounts.stale, true); assert.equal(f.ui.state.csrf, 'fixture-csrf');
  assert.ok(!f.calls.some(c => ['/api/send', '/api/create', '/api/logout'].includes(c.path)));
});
