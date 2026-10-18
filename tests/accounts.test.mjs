import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AccountStore, credentials, boundedRead, inspectPath, digest, accountLabel } from '../server/account-data.mjs';
import { AccountPlatform, officialDevice, loginEnvironment, platformRequest, startDeviceLogin } from '../server/account-platform.mjs';
import { Rpc, BridgeError } from '../server/rpc.mjs';
import { accountFixture, fakeCache, fakePlatform, deferred } from './accounts-fixture.mjs';
import { temp, waitFor } from './helpers.mjs';

const begin = async (f, kind, fields = {}) => {
  const input = { operationId: randomUUID(), ...fields };
  await f.accounts.begin(f.session, kind, input, f.accounts.revision, () => {});
  await f.accounts.operation.flight; return f.accounts.operation;
};
const ready = f => { const pageId = randomUUID(); f.accounts.presence(f.session, { pageId, blocked: false, visible: true }); return { pageId, confirmed: true, pcTasksComplete: true }; };
async function twoProfiles(f) {
  await begin(f, 'save', { label: '처음 계정' });
  const second = fakeCache('second'), candidate = structuredClone(f.accounts.data);
  const row = f.store.add(candidate, second, '다른 계정', Date.now()); await f.store.save(candidate); f.accounts.data = candidate;
  return row;
}
test('cache parser bounds ChatGPT file credentials, separates subject/workspace even with identical email, and sanitizes unsupported input', () => {
  assert.notEqual(fakeCache().identity, fakeCache('first', 'workspace-b').identity);
  assert.notEqual(fakeCache().identity, fakeCache('second').identity);
  assert.equal(fakeCache().identity, fakeCache('first', 'workspace-a', 2).identity);
  for (const bytes of [Buffer.from('{}'), Buffer.alloc(32769), Buffer.from('{"OPENAI_API_KEY":"fixture-secret"}'), Buffer.from('{"auth_mode":"api_key"}'), Buffer.from([0xff, 0xfe])]) {
    assert.throws(() => credentials(bytes), e => e.code === 'ACCOUNT_CACHE_UNSUPPORTED' && !e.message.includes('fixture-secret'));
  }
  const modified = JSON.parse(fakeCache().bytes); modified.tokens.account_id = 'other';
  assert.throws(() => credentials(Buffer.from(JSON.stringify(modified))), { code: 'ACCOUNT_CACHE_UNSUPPORTED' });
  for (const label of ['', 'x'.repeat(41), 'bad\nname', 123]) assert.throws(() => accountLabel(label));
});
test('encrypted store roundtrip, metadata secrecy, tamper and other-key rejection use an injected authenticated cipher, NOT real DPAPI', async t => {
  const root = temp(t), platform = fakePlatform(root), store = new AccountStore(root, platform), data = await store.load();
  const row = store.add(data, fakeCache(), '개인', Date.now()); data.active = row.id; await store.save(data);
  const encrypted = fs.readFileSync(store.file);
  for (const secret of ['fixture-refresh', 'sample@example.invalid', '개인', 'id_token']) assert.ok(!encrypted.includes(Buffer.from(secret)));
  assert.deepEqual(await new AccountStore(root, platform).load(), data);
  await assert.rejects(new AccountStore(root, fakePlatform(root)).load(), { code: 'ACCOUNT_STORE_UNREADABLE' });
  encrypted[encrypted.length - 1] ^= 1; fs.writeFileSync(store.file, encrypted);
  await assert.rejects(new AccountStore(root, platform).load(), { code: 'ACCOUNT_STORE_UNREADABLE' });
});
test('store rejects corrupt schema/duplicate IDs, duplicate identities and optimistic version conflicts without overwriting changed ciphertext', async t => {
  const f = await accountFixture(t); await begin(f, 'save', { label: '저장' });
  const clone = structuredClone(f.accounts.data);
  assert.throws(() => f.store.add(clone, fakeCache(), '중복', Date.now()), { code: 'ACCOUNT_ALREADY_SAVED' });
  clone.profiles.push(clone.profiles[0]);
  fs.writeFileSync(f.store.file, await f.platform.protect(Buffer.from(JSON.stringify(clone))));
  await assert.rejects(new AccountStore(f.root, f.platform).load(), { code: 'ACCOUNT_STORE_UNREADABLE' });
  const changed = fs.readFileSync(f.store.file);
  await assert.rejects(f.store.save(f.accounts.data), { code: 'ACCOUNT_CACHE_CHANGED' });
  assert.deepEqual(fs.readFileSync(f.store.file), changed);
});
test('canonical bounded reader rejects directories, hardlinks, oversized files and path traversal, and accepts only missing leaf', t => {
  const root = temp(t), file = join(root, 'fixture.json'); fs.writeFileSync(file, 'synthetic');
  assert.equal(boundedRead(file, 100).toString(), 'synthetic');
  assert.throws(() => boundedRead(file, 2)); assert.throws(() => inspectPath(root, { file: true }));
  assert.equal(boundedRead(join(root, 'missing'), 100, { missing: true }), null);
  fs.linkSync(file, join(root, 'second-link')); assert.throws(() => boundedRead(file, 100));
  assert.throws(() => inspectPath(root + '/child/../fixture.json', { file: true }));
});
test('directory junction/symlink parents are rejected even when they point to otherwise valid synthetic cache files', t => {
  const root = temp(t), target = join(root, 'ordinary'), link = join(root, 'redirect'); fs.mkdirSync(target); fs.writeFileSync(join(target, 'auth.json'), fakeCache().bytes);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inspectPath(link)); assert.throws(() => boundedRead(join(link, 'auth.json'), 32768));
});
test('profile count and operation rate are bounded without adding accounts, falling back to another provider or starting a child', async t => {
  const f = await accountFixture(t), value = f.store.empty();
  for (let i = 0; i < 8; i++) f.store.add(value, fakeCache('subject-' + i), '계정 ' + i, Date.now());
  assert.throws(() => f.store.add(value, fakeCache('extra'), '초과', Date.now()), { code: 'ACCOUNT_PROFILE_LIMIT' });
  for (let i = 0; i < 6; i++) await assert.rejects(f.accounts.begin(f.session, 'save', { operationId: randomUUID(), label: '' }, f.accounts.revision, () => {}), { code: 'ACCOUNT_LABEL_INVALID' });
  await assert.rejects(f.accounts.begin(f.session, 'save', { operationId: randomUUID(), label: '정상' }, f.accounts.revision, () => {}), { code: 'ACCOUNT_RATE_LIMIT' });
  assert.equal(f.accounts.data.profiles.length, 0); assert.deepEqual(f.platform.state.effects, []);
});
test('logout during asynchronous encryption is revalidated at the final publication boundary before any profile is saved', async t => {
  const f = await accountFixture(t), gate = deferred(), entered = deferred(), protect = f.platform.protect; let authorized = true;
  f.platform.protect = async bytes => { entered.resolve(); await gate.promise; return protect(bytes); };
  await f.accounts.begin(f.session, 'save', { operationId: randomUUID(), label: '지연 저장' }, f.accounts.revision, () => { if (!authorized) throw new BridgeError('AUTH_REQUIRED', 401); });
  await entered.promise; authorized = false; gate.resolve(); await f.accounts.operation.flight;
  assert.equal(f.accounts.operation.state, 'failed'); assert.equal(f.accounts.data.profiles.length, 0); assert.ok(!fs.existsSync(f.store.file));
});
test('unsupported platforms and unbound direct publication fail closed before helper or GUI effects', async t => {
  const f = await accountFixture(t), row = await twoProfiles(f); f.platform.switchSupported = false;
  await assert.rejects(f.accounts.begin(f.session, 'switch', { operationId: randomUUID(), profileId: row.id, ...ready(f) }, f.accounts.revision, () => {}), { code: 'ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE' });
  assert.deepEqual(f.platform.state.effects, []);
  const actual = new AccountPlatform({ request() { throw new Error('No helper may run'); } });
  assert.equal(actual.switchSupported, process.platform === 'win32');
  await assert.rejects(actual.install('anything', Buffer.from('synthetic')), { code: 'ACCOUNT_STORAGE_UNSAFE' });
});
test('safe account DTO exposes metadata only; login operation/device code is visible only to its owning session', async t => {
  const f = await accountFixture(t); await begin(f, 'save', { label: '<safe text>' });
  await f.accounts.begin(f.session, 'login', { operationId: randomUUID(), label: '추가' }, f.accounts.revision, () => {});
  await waitFor(() => f.platform.state.login);
  f.platform.state.login.code({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' });
  const own = f.accounts.view(f.session), other = f.accounts.view({ id: 'other' }), serialized = JSON.stringify(own);
  assert.equal(own.operation.device.code, 'ABCD-1234'); assert.equal(other.operation, null);
  for (const secret of ['refresh_token', 'access_token', 'id_token', f.root, fakeCache().identity, fakeCache().hash]) assert.ok(!serialized.includes(secret));
  await f.accounts.cancel(f.session, own.operation.id);
  assert.equal(f.accounts.view(f.session).operation.device, undefined);
});
test('save/rename/remove are bounded, serialized and idempotent; removing current saved profile does not log out or revoke pairing', async t => {
  const f = await accountFixture(t), input = { operationId: randomUUID(), label: '저장' };
  await f.accounts.begin(f.session, 'save', input, f.accounts.revision, () => {}); await f.accounts.operation.flight;
  const id = f.accounts.data.active, bytes = f.platform.state.cache.bytes;
  await f.accounts.begin(f.session, 'save', input, f.accounts.revision, () => {}); assert.equal(f.accounts.data.profiles.length, 1);
  await assert.rejects(f.accounts.begin({ ...f.session, id: 'other' }, 'save', input, f.accounts.revision, () => {}), { code: 'ACCOUNT_OPERATION_CONFLICT' });
  await begin(f, 'rename', { profileId: id, label: '수정' }); assert.equal(f.accounts.data.profiles[0].label, '수정');
  const again = await f.accounts.begin(f.session, 'save', input, f.accounts.revision, () => {}); assert.equal(again.operation.id, input.operationId);
  await begin(f, 'remove', { profileId: id }); assert.equal(f.accounts.data.profiles.length, 0); assert.equal(f.accounts.data.active, null);
  assert.deepEqual(f.platform.state.cache.bytes, bytes); assert.deepEqual(f.platform.state.effects, []);
});
test('isolated login saves only after completed validated cache, never activates it, confirms own child exit before plaintext cleanup', async t => {
  const f = await accountFixture(t), before = f.platform.state.cache;
  await f.accounts.begin(f.session, 'login', { operationId: randomUUID(), label: '새 계정' }, f.accounts.revision, () => {});
  await waitFor(() => f.platform.state.login); const home = f.platform.state.login.home;
  assert.equal(f.accounts.data.profiles.length, 0); f.platform.state.login.complete(); await f.accounts.operation.flight;
  assert.equal(f.accounts.operation.state, 'completed'); assert.equal(f.accounts.data.profiles.length, 1); assert.equal(f.accounts.data.active, null);
  assert.equal(f.platform.state.cache, before); assert.ok(!fs.existsSync(home)); assert.deepEqual(f.platform.state.effects, ['login', 'cancel-own-child']);
});
test('cancel/foreign ownership/late callback and expired completion never save or activate login credentials', async t => {
  const f = await accountFixture(t);
  await f.accounts.begin(f.session, 'login', { operationId: randomUUID(), label: '취소' }, f.accounts.revision, () => {});
  await waitFor(() => f.platform.state.login); const op = f.accounts.operation, home = f.platform.state.login.home;
  await assert.rejects(f.accounts.cancel({ id: 'foreign' }, op.id), { code: 'ACCOUNT_OPERATION_NOT_FOUND' });
  await f.accounts.cancel(f.session, op.id);
  f.platform.state.login.code({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' });
  assert.equal(op.device, null); assert.equal(f.accounts.data.profiles.length, 0); assert.ok(!fs.existsSync(home));
  await f.accounts.begin(f.session, 'login', { operationId: randomUUID(), label: '만료' }, f.accounts.revision, () => {});
  const second = f.accounts.operation; await waitFor(() => second.state === 'waiting'); f.advance(15 * 60000 + 1); f.platform.state.login.complete(); await second.flight;
  assert.equal(second.error, 'ACCOUNT_LOGIN_EXPIRED'); assert.equal(f.accounts.data.profiles.length, 0);
});
test('logout cancellation during early home preparation prevents child launch and cleans only the owned newly-created home', async t => {
  const f = await accountFixture(t), gate = deferred(), original = f.platform.prepare;
  f.platform.prepare = async (parent, dir) => { await original(parent, dir); if (dir.includes('login-')) await gate.promise; };
  await f.accounts.begin(f.session, 'login', { operationId: randomUUID(), label: '중단' }, f.accounts.revision, () => {});
  await waitFor(() => fs.existsSync(join(f.store.dir, 'login-' + f.accounts.operation.id)));
  f.accounts.revoke(f.session); gate.resolve(); await f.accounts.operation.flight;
  assert.equal(f.accounts.operation.state, 'failed'); assert.equal(f.accounts.data.profiles.length, 0); assert.deepEqual(f.platform.state.effects, []);
  assert.ok(!fs.existsSync(join(f.store.dir, 'login-' + f.accounts.operation.id)));
});
test('orphan login homes fail closed at startup without adopting credentials or silently deleting plaintext', async t => {
  const root = temp(t), platform = fakePlatform(root), store = new AccountStore(root, platform); fs.mkdirSync(store.dir);
  const home = join(store.dir, 'login-' + randomUUID()); fs.mkdirSync(home); fs.writeFileSync(join(home, 'auth.json'), fakeCache().bytes);
  const f = await accountFixture(t, { root });
  assert.equal(f.accounts.error, 'ACCOUNT_LOGIN_CLEANUP_REQUIRED'); assert.ok(fs.existsSync(home)); assert.equal(f.accounts.view(f.session).supported, false);
});
test('write leases serialize switch and recheck revision and identity at final native authorization', async t => {
  const f = await accountFixture(t), row = await twoProfiles(f), revision = f.accounts.revision, lease = await f.accounts.enterWrite(revision);
  await assert.rejects(f.accounts.begin(f.session, 'switch', { operationId: randomUUID(), profileId: row.id, ...ready(f) }, revision, () => {}), { code: 'ACCOUNT_BUSY' });
  f.platform.state.cache = fakeCache('external'); assert.throws(lease.authorize, { code: 'ACCOUNT_CHANGED' });
  lease.close(); lease.close(); assert.equal(f.accounts.leases, 0); assert.notEqual(f.accounts.revision, revision);
  await assert.rejects(f.accounts.enterWrite(revision), { code: 'ACCOUNT_CHANGED' });
});
test('injected switch refreshes active saved credentials, persists recovery first, gates writes, verifies and rotates revision without changing pairing', async t => {
  const f = await accountFixture(t), row = await twoProfiles(f), previous = f.accounts.data.active, revision = f.accounts.revision;
  f.platform.state.cache = fakeCache('first', 'workspace-a', 2);
  const install = f.platform.install;
  f.platform.install = async (expected, bytes, binding) => {
    assert.ok(f.accounts.data.recovery); assert.equal((await new AccountStore(f.root, f.platform).load()).recovery.expected, digest(bytes));
    assert.equal(binding.fileId, f.platform.state.cache.fileId); assert.equal(binding.transaction, f.accounts.data.recovery.transaction);
    await assert.rejects(f.accounts.enterWrite(revision), { code: 'ACCOUNT_RECOVERY_REQUIRED' }); return install(expected, bytes, binding);
  };
  const op = await begin(f, 'switch', { profileId: row.id, ...ready(f) });
  assert.equal(op.state, 'completed'); assert.equal(f.accounts.data.active, row.id); assert.equal(f.accounts.data.recovery, null);
  assert.ok(Buffer.from(f.accounts.data.profiles.find(p => p.id === previous).cache, 'base64').includes('fixture-refresh-2'));
  assert.notEqual(f.accounts.revision, revision); assert.equal(f.accounts.verified, true); assert.equal(f.session.id, 'fixture-owner');
  assert.deepEqual(f.platform.state.effects, ['pause', 'install', 'launch', 'verify', 'resume']);
});
test('injected same-identity selection never installs stale saved credentials over a refreshed current cache', async t => {
  const f = await accountFixture(t); await begin(f, 'save', { label: '현재 계정' });
  const refreshed = fakeCache('first', 'workspace-a', 7); f.platform.state.cache = refreshed;
  const op = await begin(f, 'switch', { profileId: f.accounts.data.active, ...ready(f) });
  assert.equal(op.error, 'ACCOUNT_ALREADY_CURRENT'); assert.equal(f.platform.state.cache.hash, refreshed.hash);
  assert.deepEqual(f.platform.state.effects, ['pause', 'resume']); assert.equal(f.accounts.data.recovery, null);
});
test('unknown/active tasks never close GUI; only injected positive full-idle evidence permits bounded exact graceful close', async t => {
  const f = await accountFixture(t), row = await twoProfiles(f);
  f.platform.state.processes = [{ root: true, pid: 321, started: 'same-instance', window: true }];
  f.engine.desktop.call = async () => { throw new BridgeError('ACCOUNT_TASKS_UNKNOWN'); };
  let op = await begin(f, 'switch', { profileId: row.id, ...ready(f) }); assert.equal(op.error, 'ACCOUNT_TASKS_UNKNOWN'); assert.ok(!f.platform.state.effects.includes('close'));
  f.accounts.tasks = async () => 'active'; op = await begin(f, 'switch', { profileId: row.id, ...ready(f) }); assert.equal(op.error, 'ACCOUNT_TASKS_ACTIVE');
  f.accounts.tasks = async () => 'idle'; op = await begin(f, 'switch', { profileId: row.id, ...ready(f) }); assert.equal(op.state, 'completed'); assert.ok(f.platform.state.effects.includes('close'));
});
test('unresolved records, staged attachments, transfers and stale/blocked other pages prevent switch before process effects', async t => {
  const f = await accountFixture(t), row = await twoProfiles(f), intent = ready(f);
  const invoke = () => f.accounts.begin(f.session, 'switch', { operationId: randomUUID(), profileId: row.id, ...intent }, f.accounts.revision, () => {});
  f.engine.records.push({ state: 'uncertain' }); await assert.rejects(invoke(), { code: 'ACCOUNT_REQUESTS_UNRESOLVED' }); f.engine.records = [];
  f.engine.uploads.active.add('in-flight'); await assert.rejects(invoke(), { code: 'ACCOUNT_ATTACHMENTS_PRESENT' }); f.engine.uploads.active.clear();
  f.engine.accountTransfers = 1; await assert.rejects(invoke(), { code: 'ACCOUNT_TRANSFER_BUSY' }); f.engine.accountTransfers = 0;
  const other = { id: 'other', expires: f.session.expires };
  f.accounts.presence(other, { pageId: randomUUID(), blocked: true, visible: false }); await assert.rejects(invoke(), { code: 'ACCOUNT_OTHER_PAGE_BUSY' });
  assert.deepEqual(f.platform.state.effects, []);
});
test('launch failure rolls back only exact unchanged target bytes; concurrent refresh is never overwritten and retains recovery gate', async t => {
  const f = await accountFixture(t), row = await twoProfiles(f), original = f.platform.state.cache;
  f.platform.state.launchFailure = true; let op = await begin(f, 'switch', { profileId: row.id, ...ready(f) });
  assert.equal(op.state, 'failed'); assert.equal(f.platform.state.cache.hash, original.hash); assert.equal(f.accounts.data.recovery, null);
  f.platform.launch = async () => { f.platform.state.cache = fakeCache('second', 'workspace-a', 9); throw new BridgeError('ACCOUNT_APP_UNAVAILABLE'); };
  op = await begin(f, 'switch', { profileId: row.id, ...ready(f) });
  assert.equal(op.state, 'failed'); assert.ok(f.accounts.data.recovery); assert.equal(f.platform.state.cache.hash, fakeCache('second', 'workspace-a', 9).hash);
  await assert.rejects(f.accounts.enterWrite(f.accounts.revision), { code: 'ACCOUNT_RECOVERY_REQUIRED' });
});
test('reader-stop failure always resumes engine and performs no auth or GUI effect', async t => {
  const f = await accountFixture(t), row = await twoProfiles(f);
  f.engine.pauseAccounts = async () => { throw new BridgeError('ACCOUNT_READONLY_STOP_FAILED'); };
  const op = await begin(f, 'switch', { profileId: row.id, ...ready(f) });
  assert.equal(op.error, 'ACCOUNT_READONLY_STOP_FAILED'); assert.deepEqual(f.platform.state.effects, ['resume']);
});
test('official link/code and isolated child environment reject arbitrary hosts, credentials, proxy/provider overrides and custom executable input', () => {
  assert.deepEqual(officialDevice({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' }), { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' });
  for (const url of ['https://evil.invalid/', 'http://auth.openai.com/codex/device', 'https://auth.openai.com/codex/device?token=x']) assert.throws(() => officialDevice({ url, code: 'ABCD-1234' }));
  assert.deepEqual(loginEnvironment('fixture-home', { PATH: 'system-path', OPENAI_API_KEY: 'not-inherited', CODEX_HOME: 'not-inherited', HTTPS_PROXY: 'not-inherited', OPENAI_BASE_URL: 'not-inherited' }), { PATH: 'system-path', CODEX_HOME: 'fixture-home' });
});
function fakeChild() { const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.kill = () => { child.killed = true; child.exitCode = 1; child.emit('exit', 1); child.emit('close', 1); }; return child; }
test('helper waits for close/stdout drain, bounds output and never reflects raw child stderr/errors', async () => {
  const child = fakeChild(), promise = platformRequest({ action: 'protect', data: 'fixture' }, { childFactory: () => child });
  child.emit('exit', 0); child.stdout.emit('data', Buffer.from('{"data":"c2FtcGxl"}')); child.emit('close', 0);
  assert.deepEqual(await promise, { data: 'c2FtcGxl' });
  const bad = fakeChild(), failure = platformRequest({}, { childFactory: () => bad }); bad.stderr.emit('data', Buffer.from('raw-secret-path')); bad.stdout.emit('data', Buffer.from('{"error":"raw-secret-path"}')); bad.emit('close', 1);
  await assert.rejects(failure, e => e.code === 'ACCOUNT_PLATFORM_FAILED' && !e.message.includes('raw-secret-path'));
});
test('readonly stop waits for its exact owned child exit and never enumerates or terminates a GUI process', async () => {
  const rpc = new Rpc(), child = fakeChild(); let killed = 0, ended = false;
  child.kill = () => { killed++; }; rpc.child = child;
  const stopped = rpc.stop().then(() => { ended = true; }); await Promise.resolve();
  assert.equal(killed, 1); assert.equal(ended, false); assert.equal(rpc.child, null);
  child.exitCode = 0; child.emit('exit', 0); await stopped; assert.equal(ended, true);
});
test('verification uses fresh readonly account/read without refresh, rediscovered Desktop tools and final refreshed shared bytes; ambiguous GUI cannot be closed', async () => {
  const target = fakeCache(), refreshed = fakeCache('first', 'workspace-a', 3), calls = [];
  const platform = new AccountPlatform({ request: async input => { calls.push(input); return {}; }, rpcFactory: () => ({
    on() {}, reject() {}, async start() { calls.push('fresh-readonly'); }, async request(method, params) { calls.push({ method, params }); return { account: { type: 'chatgpt', email: target.email }, requiresOpenaiAuth: false }; }, async stop() { calls.push('stop-own-readonly'); }
  }) });
  platform.inspect = async () => ({ processes: [{ root: true, pid: 123, started: 'exact-instance' }] }); let read = 0;
  platform.readCurrent = async () => ++read === 1 ? target : refreshed;
  const confirmed = await platform.verify(target, { desktop: { async tools(input) { assert.deepEqual(input, { refresh: true }); calls.push('rediscovered'); } } });
  assert.equal(confirmed.hash, refreshed.hash); assert.deepEqual(calls.find(c => c.method), { method: 'account/read', params: { refreshToken: false } }); assert.ok(calls.includes('stop-own-readonly'));
  assert.throws(() => platform.closeGui({ package: { executable: 'exact-installed' }, processes: [{ root: true }, { root: true }] }), { code: 'ACCOUNT_DESKTOP_CLOSE_REQUIRED' });
  await platform.closeGui({ package: { executable: 'exact-installed' }, processes: [{ root: true, pid: 123, started: 'exact-instance' }, { root: false, pid: 124 }] });
  assert.deepEqual(calls.at(-1), { action: 'close', executable: 'exact-installed', pid: 123, started: 'exact-instance' });
});
test('device login handles split ANSI/URL/code chunks without premature URL rejection or cross-stream splicing', async () => {
  const child = fakeChild(), login = startDeviceLogin('fixture-home', { resolveExecutable: () => 'trusted-fixture.exe', childFactory: () => child }); let projected;
  login.onCode(value => { projected = value; });
  for (const chunk of ['\x1b[', '32mhttps://auth.openai.com/cod', 'ex/device', '\x1b[0m\n']) child.stdout.emit('data', Buffer.from(chunk));
  assert.equal(child.killed, undefined); assert.equal(projected, undefined);
  child.stderr.emit('data', Buffer.from('ABCD-')); child.stdout.emit('data', Buffer.from('1234\n')); assert.equal(projected, undefined);
  child.stderr.emit('data', Buffer.from('1234')); assert.equal(projected, undefined);
  child.stderr.emit('data', Buffer.from('\n')); assert.equal(projected.code, 'ABCD-1234');
  child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); await login.done;
});
test('a partial official URL prefix is never projected as a trusted link before its hostile suffix is received', async () => {
  const child = fakeChild(), login = startDeviceLogin('fixture-home', { resolveExecutable: () => 'trusted-fixture.exe', childFactory: () => child }); let projected;
  login.onCode(value => { projected = value; }); child.stderr.emit('data', Buffer.from('ABCD-1234\n'));
  child.stdout.emit('data', Buffer.from('https://auth.openai.com/codex/device')); assert.equal(projected, undefined);
  child.stdout.emit('data', Buffer.from('.evil.invalid/fixture-secret\n'));
  await assert.rejects(login.done, { code: 'ACCOUNT_DEVICE_UNAVAILABLE' }); assert.equal(projected, undefined);
});
test('device login drains final output after process exit and rejects hostile trailing output before completion', async () => {
  const child = fakeChild(), login = startDeviceLogin('fixture-home', { resolveExecutable: () => 'trusted-fixture.exe', childFactory: () => child });
  child.stdout.emit('data', Buffer.from('https://auth.openai.com/codex/device\nABCD-1234\n'));
  child.exitCode = 0; child.emit('exit', 0); child.stderr.emit('data', Buffer.from('https://evil.invalid/fixture-secret')); child.emit('close', 0);
  await assert.rejects(login.done, e => e.code === 'ACCOUNT_DEVICE_UNAVAILABLE' && !e.message.includes('fixture-secret'));
});
test('stock isolated device login projects only official code/link and rejects hostile output without exposing raw subprocess text', async () => {
  const child = fakeChild(); let args, options, projected;
  const login = startDeviceLogin('fixture-home', { resolveExecutable: () => 'trusted-fixture.exe', childFactory: (exe, a, o) => { assert.equal(exe, 'trusted-fixture.exe'); args = a; options = o; return child; } });
  login.onCode(value => { projected = value; });
  let finished = false; login.done.then(() => { finished = true; });
  child.stdout.emit('data', Buffer.from('https://auth.openai.com/codex/device\nABCD-1234\n')); child.exitCode = 0; child.emit('exit', 0); await Promise.resolve();
  assert.equal(finished, false); child.emit('close', 0); await login.done;
  assert.equal(projected.code, 'ABCD-1234'); assert.deepEqual(args, ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth']); assert.equal(options.env.CODEX_HOME, 'fixture-home'); assert.equal(options.shell, undefined);
  const hostile = fakeChild(), bad = startDeviceLogin('fixture-home', { resolveExecutable: () => 'trusted-fixture.exe', childFactory: () => hostile });
  hostile.stdout.emit('data', Buffer.from('https://evil.invalid/fixture-secret\n')); await assert.rejects(bad.done, { code: 'ACCOUNT_DEVICE_UNAVAILABLE' }); assert.equal(hostile.killed, true);
});
