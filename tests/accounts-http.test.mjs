import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createBridge } from '../server/http.mjs';
import { ORIGIN } from '../server/security.mjs';
import { fixture, httpCall, waitFor } from './helpers.mjs';
import { accountFixture, fakeCache, deferred } from './accounts-fixture.mjs';
import { accountRecovery } from '../server/account-data.mjs';
import { browser } from './browser-fixture.mjs';

test('fresh actual HTTP client reaches missing-cache recovery without prechecked creation mocks or native reads', async t => {
  const f = await setup(t), data = structuredClone(f.accounts.data), pairedOwner = f.auth.authenticate(f.cookie).id;
  const current = f.platform.state.cache, previous = f.store.add(data, current, '이전', Date.now()), target = f.store.add(data, fakeCache('target'), '대상', Date.now());
  data.active = previous.id; data.recovery = accountRecovery(current, fakeCache('target'), target.id); await f.store.save(data);
  f.accounts.data = data; f.accounts.current = null; f.platform.state.cache = null; f.accounts.error = 'ACCOUNT_RECOVERY_REQUIRED';
  const client = await browser({ selected: false, accountRecoveryBoot: true, requestHook: async (path, options) => {
    const response = await f.call(path, { method: options.method, data: options.body, headers: { Cookie: f.cookie, Origin: ORIGIN, ...options.headers } });
    return { status: response.status, data: response.json, headers: response.headers };
  } });
  await waitFor(() => client.ui.state.creation.checked && !client.ui.state.booting && client.ui.state.accounts.result?.recovery);
  assert.equal(client.el('pairView').hidden, true); assert.equal(client.ui.state.tools.pane, 'accounts'); assert.equal(client.el('accountRecovery').hidden, false);
  assert.equal(client.el('rollbackAccount').disabled, true); client.el('accountPcIdle').click(); assert.equal(client.el('rollbackAccount').disabled, false);
  assert.equal(client.evaluate('accountLossReason()'), ''); assert.equal(f.desktop.calls.length, 0);
  const action = client.el('rollbackAccount').click(); assert.equal(client.el('accountConfirmDialog').open, true);
  assert.equal(f.accounts.operation, null); client.el('approveAccountConfirmation').click(); await action; await f.accounts.operation.flight;
  assert.equal(f.accounts.operation.state, 'completed'); assert.equal(f.platform.state.cache.hash, current.hash); assert.equal(f.accounts.data.recovery, null);
  const poll = client.timers.get(client.ui.state.activityTimer); assert.ok(poll); await poll.fn();
  assert.equal(client.ui.state.accounts.result.recovery, false); assert.equal(client.ui.state.accounts.result.operation.state, 'completed');
  assert.equal(f.auth.authenticate(f.cookie).id, pairedOwner);
  assert.ok(!client.calls.some(c => ['/api/pair', '/api/send', '/api/create', '/api/logout'].includes(c.path)));
});
test('creation-state and owned receipts stay local during recovery even for an unresolved exact-ID candidate; foreign receipts remain private', async t => {
  const f = await setup(t), owner = f.auth.authenticate(f.cookie).id, requestId = randomUUID();
  f.accounts.data.recovery = { syntheticGate: true }; f.accounts.error = 'ACCOUNT_RECOVERY_REQUIRED';
  f.engine.records.push({ kind: 'create', owner, requestId, state: 'uncertain', candidateId: 'thread-fixture', createdAt: Date.now() });
  let inspected = 0; f.engine.inspectReceipt = async () => { inspected++; throw new Error('Must not read native during recovery'); };
  const state = await f.call('/api/create/state', { headers: { Cookie: f.cookie } }); assert.equal(state.status, 200); assert.equal(state.json.request.state, 'uncertain');
  assert.equal((await f.call('/api/requests/' + requestId, { headers: { Cookie: f.cookie } })).status, 200);
  assert.equal((await f.call('/api/requests/' + randomUUID(), { headers: { Cookie: f.cookie } })).status, 404);
  assert.equal(inspected, 0); assert.equal(f.desktop.calls.length, 0);
});

async function setup(t) {
  const f = await fixture(t), a = await accountFixture(t, { root: f.dir, engine: f.engine });
  const server = createBridge({ ...f, accounts: a.accounts }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); }); const port = server.address().port;
  const call = (path, options) => httpCall(port, path, options);
  const code = JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code;
  const paired = await call('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: { code } });
  const cookie = paired.headers['set-cookie'][0].split(';')[0], s = await call('/api/session', { headers: { Cookie: cookie } });
  const headers = { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Codex-CSRF': s.json.csrf, 'X-Codex-Account-Revision': s.json.accountRevision };
  return { ...f, ...a, port, call, cookie, headers, post: (path, data, overrides = {}) => call(path, { method: 'POST', headers: { ...headers, ...overrides }, data }) };
}
test('account routes require pairing/CSRF/exact origin; reject query including bare ?, unknown fields, credential/command input and fake production controls', async t => {
  const f = await setup(t);
  assert.equal((await f.call('/api/accounts')).status, 401);
  assert.equal((await f.call('/health')).headers['x-codex-account-revision'], undefined);
  assert.equal((await f.call('/api/accounts', { headers: { Cookie: f.cookie } })).status, 200);
  for (const path of ['/api/accounts?', '/api/accounts?path=private']) assert.equal((await f.call(path, { headers: { Cookie: f.cookie } })).status, 400);
  const input = { operationId: randomUUID(), label: '합성' };
  assert.equal((await f.post('/api/accounts/save', input, { 'X-Codex-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.post('/api/accounts/save', input, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.post('/api/accounts/save?', input)).status, 400);
  for (const field of ['token', 'path', 'executable', 'env', 'command', 'rpc']) assert.equal((await f.post('/api/accounts/login', { ...input, [field]: 'fixture' })).status, 400);
  assert.equal((await f.post('/api/accounts/save', input, { 'X-Codex-Account-Revision': 'old' })).json.error, 'ACCOUNT_CHANGED');
  for (const path of ['/sample/accounts', '/api/accounts/import', '/api/accounts/exec']) assert.equal((await f.post(path, {})).status, 404);
  assert.equal(f.accounts.data.profiles.length, 0);
});
test('authenticated account save/list returns safe metadata and never plaintext, cache hashes, source paths or raw child output', async t => {
  const f = await setup(t);
  assert.equal((await f.post('/api/accounts/save', { operationId: randomUUID(), label: '내 계정' })).status, 200); await f.accounts.operation.flight;
  const result = await f.call('/api/accounts', { headers: { Cookie: f.cookie } });
  assert.equal(result.json.profiles.length, 1); assert.equal(result.json.current.email, 'sample@example.invalid');
  for (const secret of [f.dir, 'refresh_token', 'id_token', 'fixture-refresh', fakeCache().identity, fakeCache().hash]) assert.ok(!result.text.includes(secret));
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-codex-account-revision'], f.accounts.revision);
});
for (const kind of ['send', 'create']) {
  const payload = () => ({ requestId: randomUUID(), text: '합성 요청', ...(kind === 'send' ? { threadId: 'thread-fixture' } : { target: { type: 'projectless' } }) });
  test(`${kind}: old or absent revision fails before creating a journal entry or native write`, async t => {
    const f = await setup(t);
    for (const revision of ['', 'old']) assert.equal((await f.post('/api/' + kind, payload(), { 'X-Codex-Account-Revision': revision })).json.error, 'ACCOUNT_CHANGED');
    assert.equal(f.engine.records.length, 0); assert.ok(!f.desktop.calls.some(c => ['send_message_to_thread', 'create_thread'].includes(c.tool)));
  });
  test(`${kind}: account change during actual engine preflight fails visibly with no native write; write lease blocks new account operation`, async t => {
    const f = await setup(t), gate = deferred(), entered = deferred();
    if (kind === 'send') f.desktop.hook = async tool => { if (tool === 'read_thread') { entered.resolve(); await gate.promise; } };
    else f.engine.options.validate = async () => { entered.resolve(); await gate.promise; };
    const response = f.post('/api/' + kind, payload()); await entered.promise;
    assert.equal((await f.post('/api/accounts/save', { operationId: randomUUID(), label: '레이스' })).json.error, 'ACCOUNT_BUSY');
    f.platform.state.cache = fakeCache('external'); gate.resolve();
    assert.equal((await response).json.error, 'ACCOUNT_CHANGED'); assert.equal(f.engine.records[0].state, 'rejected'); assert.equal(f.accounts.leases, 0);
    assert.ok(!f.desktop.calls.some(c => ['send_message_to_thread', 'create_thread'].includes(c.tool)));
  });
  test(`${kind}: final wire callback revalidates identity, never writes after an external login race and preserves conservative uncertain journal`, async t => {
    const f = await setup(t), original = f.desktop.call.bind(f.desktop); let wired = 0;
    f.engine.options.validate = async () => {};
    f.desktop.call = async (tool, args, id, authorize) => {
      if (['send_message_to_thread', 'create_thread'].includes(tool)) { f.platform.state.cache = fakeCache('external'); authorize(); wired++; }
      return original(tool, args, id);
    };
    const response = await f.post('/api/' + kind, payload()); assert.equal(response.json.error, kind === 'send' ? 'SEND_UNCERTAIN' : 'CREATE_UNCERTAIN');
    assert.equal(wired, 0); assert.equal(f.engine.records[0].state, 'uncertain'); assert.equal(f.accounts.leases, 0);
    const receipt = await f.call('/api/requests/' + f.engine.records[0].requestId, { headers: { Cookie: f.cookie } }); assert.equal(receipt.json.state, 'uncertain');
  });
}
test('slow JSON body parsed after an account revision change never reserves or sends on the new account', async t => {
  const f = await setup(t), bytes = JSON.stringify({ requestId: randomUUID(), threadId: 'thread-fixture', text: '합성' });
  const response = new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: f.port, path: '/api/send', method: 'POST', headers: { Host: '100.64.0.10:47831', ...f.headers, 'Content-Length': Buffer.byteLength(bytes) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject); req.write(bytes.slice(0, 5));
    setTimeout(() => { f.accounts.revision = randomUUID(); req.end(bytes.slice(5)); }, 20);
  });
  assert.equal((await response).json.error, 'ACCOUNT_CHANGED'); assert.equal(f.engine.records.length, 0);
});
test('late sensitive GET is guarded again before response, while old owned receipts remain readable', async t => {
  const f = await setup(t), gate = deferred(), entered = deferred();
  f.engine.usage.snapshot = async () => { entered.resolve(); await gate.promise; return { privateFixture: 'old-account-credit' }; };
  const response = f.call('/api/usage', { headers: { Cookie: f.cookie } }); await entered.promise; f.accounts.revision = randomUUID(); gate.resolve();
  const result = await response; assert.equal(result.status, 409); assert.equal(result.json.error, 'ACCOUNT_CHANGED'); assert.ok(!result.text.includes('old-account-credit'));
});
test('logout cancels only owning isolated login, clears its presence and preserves other authenticated phone sessions', async t => {
  const f = await setup(t);
  await f.post('/api/accounts/login', { operationId: randomUUID(), label: '취소' }); await waitFor(() => f.platform.state.login);
  const op = f.accounts.operation;
  f.auth.issuePairing();
  const code = JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code;
  const other = await f.call('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: { code } });
  const otherCookie = other.headers['set-cookie'][0].split(';')[0];
  assert.equal((await f.post('/api/logout', {})).status, 200);
  assert.equal((await f.call('/api/session', { headers: { Cookie: otherCookie } })).status, 200); await op.flight;
  assert.equal(op.state, 'failed'); assert.equal(f.accounts.data.profiles.length, 0); assert.ok(!f.accounts.busy);
  assert.equal((await f.call('/api/accounts', { headers: { Cookie: f.cookie } })).status, 401);
});
