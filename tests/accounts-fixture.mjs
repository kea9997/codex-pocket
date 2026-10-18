import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { AccountStore, credentials, digest } from '../server/account-data.mjs';
import { Accounts } from '../server/accounts.mjs';
import { BridgeError } from '../server/rpc.mjs';
import { temp } from './helpers.mjs';

// All credentials below are invented, unsigned fixture bytes. This adapter is NOT Windows DPAPI or ACL QA.
export function fakeCache(subject = 'first', workspace = 'workspace-a', generation = 1, email = 'sample@example.invalid') {
  const payload = { iss: 'https://auth.openai.com', sub: subject, email,
    'https://api.openai.com/auth': { chatgpt_account_id: workspace, chatgpt_plan_type: 'plus' } };
  return { fileId: '00000001:' + randomBytes(8).toString('hex') + ':' + randomBytes(8).toString('hex'), ...credentials(Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {
    id_token: 'e30.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.ZmFrZQ',
    access_token: 'fixture-access-' + generation, refresh_token: 'fixture-refresh-' + generation, account_id: workspace
  }, last_refresh: '2026-10-18T00:00:00Z' }))) };
}
export function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
export function fakePlatform(root) {
  const key = randomBytes(32), state = { cache: fakeCache(), processes: [], effects: [], launchFailure: false, verifyFailure: false };
  const platform = {
    switchSupported: true, state,
    async supported() {},
    async protect(bytes) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(bytes), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    async unprotect(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    },
    async privatePath() {},
    async prepare(parent, dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 }); },
    async replace(file, expected, bytes, privateFile) {
      if (!privateFile) throw new Error('Fixture store must be encrypted');
      const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if ((old ? digest(old) : null) !== expected) throw new BridgeError('ACCOUNT_CACHE_CHANGED');
      const staged = file + '.fixture-new'; fs.writeFileSync(staged, bytes); fs.renameSync(staged, file);
    },
    async readCurrent() { return state.cache; }, currentIdentity() { return state.cache.identity; },
    async readLogin(home) { return credentials(fs.readFileSync(join(home, 'auth.json'))); },
    async install(expected, bytes, { fileId, transaction } = {}) {
      state.effects.push('install');
      if (!transaction || (state.cache?.hash || null) !== expected || expected !== null && state.cache.fileId !== fileId) throw new BridgeError('ACCOUNT_CACHE_CHANGED');
      state.cache = { ...credentials(bytes), fileId: '00000001:' + randomBytes(8).toString('hex') + ':' + randomBytes(8).toString('hex') };
      return { fileId: state.cache.fileId };
    },
    async inspect() { return { package: { executable: 'fixture-exact-app', aumid: 'fixture!App' }, processes: state.processes }; },
    async closeGui(snapshot) { state.effects.push('close'); if (snapshot.package.executable !== 'fixture-exact-app') throw new Error('Wrong app'); state.processes = []; },
    async launch(snapshot) {
      state.effects.push('launch'); if (state.launchFailure) throw new BridgeError('ACCOUNT_APP_UNAVAILABLE');
      if (snapshot.package.executable !== 'fixture-exact-app') throw new Error('Wrong app');
      state.processes = [{ root: true, pid: 321, started: 'fixture-instance', window: true }];
    },
    async verify(target) {
      state.effects.push('verify'); if (state.verifyFailure) throw new BridgeError('ACCOUNT_LOGIN_UNCONFIRMED');
      if (target.identity !== state.cache.identity) throw new BridgeError('ACCOUNT_CACHE_CHANGED'); return state.cache;
    },
    loginFactory(home) {
      state.effects.push('login'); const done = deferred(); let callback;
      const child = { done: done.promise, onCode(fn) { callback = fn; }, async cancel() { state.effects.push('cancel-own-child'); done.reject(new BridgeError('ACCOUNT_OPERATION_CANCELLED')); } };
      state.login = { home, code(value) { callback?.(value); }, complete(cache = fakeCache('second')) { fs.writeFileSync(join(home, 'auth.json'), cache.bytes); done.resolve(); }, fail() { done.reject(new BridgeError('ACCOUNT_DEVICE_FAILED')); } };
      return child;
    }
  };
  return platform;
}
export async function accountFixture(t, options = {}) {
  const root = options.root || temp(t), platform = fakePlatform(root), store = new AccountStore(root, platform);
  const engine = options.engine || { sending: new Map(), creating: new Map(), records: [], accountTransfers: 0,
    uploads: { active: new Set(), rows: [], referenced() { return false; } },
    desktop: { async call() { return { threads: [], pinnedThreads: [] }; } },
    async pauseAccounts() { platform.state.effects.push('pause'); }, resumeAccounts() { platform.state.effects.push('resume'); } };
  let clock = Date.now(); const session = { id: 'fixture-owner', expires: clock + 3600000 };
  const accounts = new Accounts(engine, root, { platform, store, now: () => clock, sleep: async () => {} });
  await accounts.init();
  return { root, platform, store, engine, accounts, session, advance(ms) { clock += ms; } };
}
