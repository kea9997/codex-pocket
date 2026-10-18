import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Accounts } from '../server/accounts.mjs';
import { AccountStore, accountRecovery } from '../server/account-data.mjs';
import { BridgeError } from '../server/rpc.mjs';
import { accountFixture, fakeCache } from './accounts-fixture.mjs';

async function pair(f) {
  const data = structuredClone(f.accounts.data), old = f.store.add(data, f.platform.state.cache, '현재', Date.now()), target = f.store.add(data, fakeCache('target'), '대상', Date.now());
  data.active = old.id; await f.store.save(data); f.accounts.data = data; return target;
}
function intent(f) {
  const pageId = randomUUID(); f.accounts.presence(f.session, { pageId, blocked: false, visible: true });
  return { operationId: randomUUID(), pageId, confirmed: true, pcTasksComplete: true };
}
async function run(f, kind, fields) {
  await f.accounts.begin(f.session, kind, fields, f.accounts.revision, () => {}); await f.accounts.operation.flight; return f.accounts.operation;
}
test('default recent-status adapter plus explicit human PC completion permits exact graceful GUI restart, not an injected idle stub', async t => {
  const f = await accountFixture(t), row = await pair(f); let reads = 0;
  f.platform.state.processes = [{ root: true, pid: 1 }, { native: true, root: false, pid: 2 }, { native: true, root: false, pid: 3 }];
  f.engine.desktop.call = async (tool, args) => { assert.equal(tool, 'list_threads'); assert.equal(args.limit, 50); reads++; return { threads: [{ status: 'idle' }], pinnedThreads: [] }; };
  const op = await run(f, 'switch', { ...intent(f), profileId: row.id });
  assert.equal(op.state, 'completed'); assert.equal(reads, 1); assert.equal(f.accounts.tasks, null);
  assert.deepEqual(f.platform.state.effects, ['pause', 'close', 'install', 'launch', 'verify', 'resume']);
});
for (const status of ['active', 'waiting', 'unknown', 'failure']) test(`human assertion never bypasses ${status} recent status`, async t => {
  const f = await accountFixture(t), row = await pair(f); f.platform.state.processes = [{ root: true }];
  f.engine.desktop.call = async () => { if (status === 'failure') throw new BridgeError('ACCOUNT_TASKS_UNKNOWN'); return { threads: [{ status }], pinnedThreads: [] }; };
  const op = await run(f, 'switch', { ...intent(f), profileId: row.id });
  assert.equal(op.error, ['active', 'waiting'].includes(status) ? 'ACCOUNT_TASKS_ACTIVE' : 'ACCOUNT_TASKS_UNKNOWN'); assert.ok(!f.platform.state.effects.includes('close'));
});
test('PC assertion and target/revision/page remain explicit; old intent does not authorize a new target generation', async t => {
  const f = await accountFixture(t), row = await pair(f), input = { ...intent(f), profileId: row.id };
  await assert.rejects(f.accounts.begin(f.session, 'switch', { ...input, pcTasksComplete: false }, f.accounts.revision, () => {}), { code: 'ACCOUNT_CONFIRM_REQUIRED' });
  await assert.rejects(f.accounts.begin(f.session, 'switch', input, randomUUID(), () => {}), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(f.accounts.begin(f.session, 'switch', { ...input, pageId: randomUUID() }, f.accounts.revision, () => {}), { code: 'ACCOUNT_PAGE_NOT_READY' });
  assert.deepEqual(f.platform.state.effects, []);
});
test('stale abandoned presence expires but unresolved native records and active uploads never expire with it', async t => {
  const f = await accountFixture(t); await pair(f);
  f.accounts.presence({ ...f.session, id: 'abandoned' }, { pageId: randomUUID(), blocked: true, visible: true });
  let input = intent(f); assert.throws(() => f.accounts.idle(input, f.session), { code: 'ACCOUNT_OTHER_PAGE_BUSY' });
  f.advance(45001); input = intent(f); assert.doesNotThrow(() => f.accounts.idle(input, f.session));
  f.engine.records.push({ state: 'uncertain' }); assert.throws(() => f.accounts.idle(input, f.session), { code: 'ACCOUNT_REQUESTS_UNRESOLVED' }); f.engine.records = [];
  f.engine.uploads.active.add('active'); assert.throws(() => f.accounts.idle(input, f.session), { code: 'ACCOUNT_ATTACHMENTS_PRESENT' });
});
test('page close, hidden idle, and logout release presence without dropping another live blocked page', async t => {
  const f = await accountFixture(t), pageId = randomUUID(), other = { ...f.session, id: 'other' };
  f.accounts.presence(other, { pageId, blocked: true, visible: true });
  f.accounts.presence(other, { pageId, blocked: true, visible: false, closed: true }); assert.equal(f.accounts.pages.size, 0);
  f.accounts.presence(other, { pageId, blocked: false, visible: false }); assert.equal(f.accounts.pages.size, 0);
  f.accounts.presence(other, { pageId, blocked: true, visible: true });
  f.accounts.revoke(f.session); assert.equal(f.accounts.pages.size, 1); f.accounts.revoke(other); assert.equal(f.accounts.pages.size, 0);
});
test('unreferenced abandoned staging files are not deleted and do not require deletion to switch; selected attachments still block via page presence', async t => {
  const f = await accountFixture(t), row = await pair(f), path = join(f.root, 'abandoned-fixture.txt'); fs.writeFileSync(path, 'invented attachment');
  f.engine.uploads.rows.push({ handle: 'invented', path, createdAt: Date.now() });
  const input = intent(f); f.accounts.presence(f.session, { pageId: input.pageId, blocked: true, visible: true });
  assert.throws(() => f.accounts.idle(input, f.session), { code: 'ACCOUNT_PAGE_NOT_READY' });
  f.accounts.presence(f.session, { pageId: input.pageId, blocked: false, visible: true });
  const op = await run(f, 'switch', { ...input, profileId: row.id }); assert.equal(op.state, 'completed'); assert.equal(fs.readFileSync(path, 'utf8'), 'invented attachment');
});
test('encrypted transaction survives fresh broker with missing auth and supports no-overwrite previous recovery', async t => {
  const f = await accountFixture(t), row = await pair(f), previous = f.platform.state.cache, target = fakeCache('target');
  f.accounts.data.recovery = accountRecovery(previous, target, row.id); await f.store.save(f.accounts.data); f.platform.state.cache = null;
  f.accounts = new Accounts(f.engine, f.root, { platform: f.platform, store: new AccountStore(f.root, f.platform), sleep: async () => {} }); await f.accounts.init();
  assert.equal(f.accounts.view(f.session).recovery, true); assert.equal(f.accounts.view(f.session).supported, true);
  const op = await run(f, 'recover', { ...intent(f), mode: 'rollback' });
  assert.equal(op.state, 'completed'); assert.equal(f.accounts.data.recovery, null); assert.equal(f.platform.state.cache.hash, previous.hash);
});
test('same bytes from a different file identity cannot be rolled back over a concurrent writer', async t => {
  const f = await accountFixture(t), row = await pair(f), target = fakeCache('target');
  f.accounts.data.recovery = accountRecovery(f.platform.state.cache, target, row.id); f.accounts.data.recovery.installedFileId = target.fileId;
  f.platform.state.cache = fakeCache('target');
  await assert.rejects(f.accounts.restorePrevious(f.accounts.data.recovery), { code: 'ACCOUNT_CACHE_CHANGED' }); assert.deepEqual(f.platform.state.effects, []);
});
test('tampered encrypted transaction binding is rejected instead of attempting cache recovery', async t => {
  const f = await accountFixture(t), row = await pair(f);
  const data = structuredClone(f.accounts.data); data.recovery = accountRecovery(f.platform.state.cache, fakeCache('target'), row.id); data.recovery.transaction = randomUUID(); await f.store.save(data);
  await assert.rejects(new AccountStore(f.root, f.platform).load(), { code: 'ACCOUNT_STORE_UNREADABLE' });
});
