import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../server/rpc.mjs';
import { accountFixture, deferred, fakeCache } from './accounts-fixture.mjs';
import { fixture, waitFor } from './helpers.mjs';

test('external identity changes share one reader reset, rotate intent and block account operations until reset completes', async t => {
  const f = await accountFixture(t), gate = deferred(), entered = deferred(), revision = f.accounts.revision;
  f.accounts.verified = true;
  f.engine.pauseAccounts = async () => { f.platform.state.effects.push('pause'); entered.resolve(); await gate.promise; };
  f.platform.state.cache = fakeCache('external');
  assert.throws(() => f.accounts.guard(revision), { code: 'ACCOUNT_CHANGED' }); await entered.promise;
  const firstRevision = f.accounts.revision;
  assert.equal(f.accounts.view(f.session).busy, true); assert.equal(f.accounts.verified, false);
  await assert.rejects(f.accounts.begin(f.session, 'save', { operationId: randomUUID(), label: '대기' }, firstRevision, () => {}), { code: 'ACCOUNT_BUSY' });
  assert.throws(() => f.accounts.guard(firstRevision), { code: 'ACCOUNT_BUSY' });
  f.platform.state.cache = fakeCache('another-external');
  const reset = f.accounts.resetFlight; f.accounts.invalidateExternal(f.platform.state.cache.identity);
  assert.equal(f.accounts.resetFlight, reset); assert.notEqual(f.accounts.revision, firstRevision);
  const refreshing = f.accounts.refresh(f.session); gate.resolve(); const view = await refreshing;
  assert.deepEqual(f.platform.state.effects, ['pause', 'resume']); assert.equal(view.busy, false);
  assert.equal(f.accounts.current.identity, f.platform.state.cache.identity); assert.equal(view.verification, 'shared-cache-only');
  assert.equal(f.session.id, 'fixture-owner'); assert.equal(f.accounts.data.profiles.length, 0);
  assert.doesNotThrow(() => f.accounts.guard(view.revision));
});
test('returning to the original identity before metadata adoption still resets each observed account generation', async t => {
  const f = await accountFixture(t), original = f.platform.state.cache, external = fakeCache('external');
  for (const cache of [external, original, external]) {
    const previous = f.accounts.revision; f.platform.state.cache = cache;
    assert.throws(() => f.accounts.guard(previous), { code: 'ACCOUNT_CHANGED' });
    assert.notEqual(f.accounts.revision, previous); await f.accounts.resetFlight;
  }
  assert.deepEqual(f.platform.state.effects, ['pause', 'resume', 'pause', 'resume', 'pause', 'resume']);
  const result = await f.accounts.refresh(f.session); assert.doesNotThrow(() => f.accounts.guard(result.revision));
  assert.equal(f.accounts.current.identity, external.identity);
});
for (const failure of ['stop', 'resume']) test(`external ${failure} failure remains fail-closed without unhandled rejection or a false ready state`, async t => {
  const f = await accountFixture(t), revision = f.accounts.revision; let resumed = 0;
  f.engine.pauseAccounts = async () => { if (failure === 'stop') throw new Error('private fixture detail'); };
  f.engine.resumeAccounts = () => { resumed++; if (failure === 'resume') throw new Error('private fixture detail'); };
  f.platform.state.cache = fakeCache('external'); assert.throws(() => f.accounts.guard(revision), { code: 'ACCOUNT_CHANGED' });
  await f.accounts.resetFlight; const view = await f.accounts.refresh(f.session);
  assert.equal(view.supported, false); assert.equal(view.error, 'ACCOUNT_READONLY_STOP_FAILED'); assert.equal(view.busy, false);
  assert.equal(resumed, failure === 'stop' ? 0 : 1); assert.ok(!JSON.stringify(view).includes('private fixture detail'));
  assert.throws(() => f.accounts.guard(view.revision), { code: 'ACCOUNT_READONLY_STOP_FAILED' });
  await assert.rejects(f.accounts.begin(f.session, 'save', { operationId: randomUUID(), label: '차단' }, view.revision, () => {}), { code: 'ACCOUNT_READONLY_STOP_FAILED' });
  await f.accounts.refresh(f.session); assert.equal(resumed, failure === 'stop' ? 0 : 1);
});
test('account refresh is singleflight and cannot race a profile operation while its cache read is awaiting', async t => {
  const f = await accountFixture(t), gate = deferred(), entered = deferred(); let reads = 0;
  f.platform.readCurrent = async () => { reads++; entered.resolve(); await gate.promise; return f.platform.state.cache; };
  const first = f.accounts.refresh(f.session); await entered.promise;
  const second = f.accounts.refresh({ ...f.session, id: 'other-owner' });
  await assert.rejects(f.accounts.begin(f.session, 'save', { operationId: randomUUID(), label: '동시 저장' }, f.accounts.revision, () => {}), { code: 'ACCOUNT_BUSY' });
  gate.resolve(); await Promise.all([first, second]); assert.equal(reads, 1); assert.equal(f.accounts.refreshFlight, null);
});
test('actual engine reset replaces usage/options and rejects late old list/diagnostic/history results without clearing newer flights or polluting caches', async t => {
  const base = await fixture(t), f = await accountFixture(t, { root: base.dir, engine: base.engine }), engine = f.engine;
  const oldList = deferred(), newList = deferred(), oldRead = deferred(), oldUsage = deferred(); let lists = 0;
  base.desktop.hook = async tool => {
    if (tool === 'list_threads') return ++lists === 1 ? oldList.promise : newList.promise;
    if (tool === 'read_thread') return oldRead.promise;
    if (tool === 'get_usage_limits') return oldUsage.promise;
  };
  const previousUsage = engine.usage, previousOptions = engine.options, previousActivity = engine.activity, previousEvents = engine.events;
  previousUsage.buckets = [{ id: 'fixture-old-account' }]; engine.readChecks.set('old-owner/old-thread', Date.now());
  engine.readModes.set('old-thread', {}); engine.questionTurns.set('old-thread', {});
  const listing = engine.recentThreads(), diagnostics = engine.diagnostics(), history = engine.history('thread-fixture', null, f.session), usage = previousUsage.snapshot();
  const rejectList = assert.rejects(listing, { code: 'ACCOUNT_CHANGED' }), rejectDiagnostic = assert.rejects(diagnostics, { code: 'ACCOUNT_CHANGED' }), rejectHistory = assert.rejects(history, { code: 'ACCOUNT_CHANGED' });
  await waitFor(() => base.desktop.calls.some(c => c.tool === 'get_usage_limits'));
  f.platform.state.cache = fakeCache('external'); assert.throws(() => f.accounts.guard(f.accounts.revision), { code: 'ACCOUNT_CHANGED' }); await f.accounts.resetFlight;
  assert.notEqual(engine.usage, previousUsage); assert.notEqual(engine.options, previousOptions); assert.notEqual(engine.activity, previousActivity); assert.notEqual(engine.events, previousEvents);
  assert.deepEqual(engine.usage.view().buckets, []); assert.equal(engine.readChecks.size, 0); assert.equal(engine.readModes.size, 0); assert.equal(engine.questionTurns.size, 0);
  assert.equal(engine.diagnosticResult, null); assert.equal(engine.recent, null);
  const newer = engine.recentThreads(), pending = engine.recentPending;
  oldList.resolve({ threads: [base.desktop.thread('old-thread')], pinnedThreads: [] });
  oldRead.resolve({ thread: base.desktop.thread('thread-fixture'), turns: [], page: {} });
  oldUsage.resolve({ rateLimits: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 300 } } });
  await Promise.all([rejectList, rejectDiagnostic, rejectHistory, usage]);
  assert.equal(engine.recentPending, pending); assert.equal(engine.recent, null); assert.equal(engine.diagnosticResult, null); assert.equal(engine.readChecks.size, 0);
  assert.deepEqual(engine.usage.view().buckets, []); assert.throws(() => previousActivity.snapshot(), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(previousEvents.feed(f.session), { code: 'ACCOUNT_CHANGED' });
  newList.resolve({ threads: [base.desktop.thread('new-thread')], pinnedThreads: [] });
  assert.equal((await newer)[0].id, 'new-thread'); assert.equal(engine.recent.rows[0].id, 'new-thread');
});
test('readonly creation already in flight is captured and its owned exit confirmed before resetting transport and allowing a fresh child', async t => {
  const base = await fixture(t), engine = base.engine, started = deferred(), exited = deferred(), effects = [];
  const rpc = { closed: false, async stop() { effects.push('stop-own'); await exited.promise; this.closed = true; }, close() {} };
  let launches = 0; engine.historyRpcFactory = async () => { launches++; return launches === 1 ? started.promise : { closed: false, close() {} }; };
  base.desktop.reset = async () => { effects.push('reset-transport'); };
  const starting = engine.stored(), rejected = assert.rejects(starting, { code: 'ACCOUNT_BUSY' });
  const stopping = engine.pauseAccounts(); started.resolve(rpc); await waitFor(() => effects.includes('stop-own'));
  assert.equal(engine.historyRpc, rpc); assert.equal(engine.accountPaused, true); assert.deepEqual(effects, ['stop-own']);
  exited.resolve(); await Promise.all([rejected, stopping]); assert.equal(engine.historyRpc, null);
  assert.deepEqual(effects, ['stop-own', 'reset-transport']); engine.resumeAccounts(); await engine.stored(); assert.equal(launches, 2);
});
test('failed owned readonly stop retains its child reference and resets the pipe but does not reopen native operations', async t => {
  const base = await fixture(t), f = await accountFixture(t, { root: base.dir, engine: base.engine }), effects = [];
  const rpc = { async stop() { effects.push('stop-own'); throw new BridgeError('ACCOUNT_READONLY_STOP_FAILED'); }, close() {} };
  f.engine.historyRpc = rpc; base.desktop.reset = async () => { effects.push('reset-transport'); };
  f.platform.state.cache = fakeCache('external'); assert.throws(() => f.accounts.guard(f.accounts.revision), { code: 'ACCOUNT_CHANGED' }); await f.accounts.resetFlight;
  assert.equal(f.engine.historyRpc, rpc); assert.equal(f.engine.accountPaused, true); assert.deepEqual(effects, ['stop-own', 'reset-transport']);
  assert.equal(f.accounts.view(f.session).supported, false); await assert.rejects(f.engine.stored(), { code: 'ACCOUNT_BUSY' });
});
test('background activity from the old generation never starts remaining preview reads against the new account', async t => {
  const base = await fixture(t), engine = base.engine, read = deferred(); let previews = 0;
  base.desktop.hook = async tool => {
    if (tool === 'list_threads') return { threads: ['a', 'b', 'c', 'd'].map(id => base.desktop.thread(id)), pinnedThreads: [] };
    if (tool === 'read_thread') { previews++; return read.promise; }
  };
  const previous = engine.activity, snapshot = previous.snapshot(), rejected = assert.rejects(snapshot, { code: 'ACCOUNT_CHANGED' });
  await waitFor(() => previews === 2); await engine.pauseAccounts(); engine.resumeAccounts();
  read.resolve({ thread: base.desktop.thread('a'), turns: [] }); await rejected;
  assert.equal(previews, 2); assert.notEqual(engine.activity, previous); assert.equal(engine.activity.entries.size, 0); assert.equal(engine.recent, null);
});
