import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './rpc.mjs';
import { normalizeStatus } from './activity.mjs';
import { AccountStore, ACCOUNT_LIMITS, credentials, accountError, accountLabel, opaqueId, digest, inspectPath, boundedRead, accountRecovery } from './account-data.mjs';
import { AccountPlatform, officialDevice } from './account-platform.mjs';

const safeCode = e => e instanceof BridgeError && /^ACCOUNT_[A-Z_]+$/.test(e.code) ? e.code : 'ACCOUNT_OPERATION_FAILED';
const wait = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
// One owner broker. No credentials or native raw results are ever included in its public views.
export class Accounts {
  constructor(engine, root, { platform = new AccountPlatform(), store = new AccountStore(root, platform), now = Date.now, sleep = wait, tasks = null } = {}) {
    this.engine = engine; this.platform = platform; this.store = store; this.now = now; this.sleep = sleep; this.tasks = tasks;
    this.revision = randomUUID(); this.leases = 0; this.pages = new Map(); this.operations = new Map(); this.attempts = []; this.busy = false;
    this.data = null; this.current = null; this.error = null; this.operation = null; this.verified = false;
  }
  init() {
    if (!this.initializing) this.initializing = (async () => {
      try { this.data = await this.store.load(); }
      catch (e) { this.error = safeCode(e); this.storageFailed = true; return; }
      if (this.data.recovery) this.error = 'ACCOUNT_RECOVERY_REQUIRED';
      try { this.current = await this.platform.readCurrent(); }
      catch (e) { if (!this.error) this.error = safeCode(e); }
      // Interrupted isolated logins are never recursively deleted or adopted on startup.
      try {
        if (inspectPath(this.store.dir, { missing: true }) && fs.readdirSync(this.store.dir).some(n => /^login-[a-f0-9-]{36}$/.test(n))) this.error = 'ACCOUNT_LOGIN_CLEANUP_REQUIRED';
      } catch (e) { this.error = safeCode(e); this.storageFailed = true; }
    })();
    return this.initializing;
  }
  view(session, op = this.operation) {
    const own = op?.owner === session.id;
    return { revision: this.revision, supported: Boolean(this.data && !this.storageFailed && !this.resetFailed && (this.current || this.data.recovery) && !['ACCOUNT_STORAGE_UNSUPPORTED', 'ACCOUNT_CACHE_UNSUPPORTED', 'ACCOUNT_LOGIN_CLEANUP_REQUIRED'].includes(this.error)),
      switchSupported: this.platform.switchSupported === true, switchReason: this.platform.switchSupported === true ? null : 'ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE',
      busy: this.busy || Boolean(this.resetFlight), error: this.error, recovery: Boolean(this.data?.recovery), verification: this.verified ? 'shared-login-and-restarted-app' : 'shared-cache-only',
      current: this.current ? { email: this.current.email, plan: this.current.plan, profileId: this.data?.active && this.profileIdentity(this.data.active) === this.current.identity ? this.data.active : null } : null,
      profiles: (this.data?.profiles || []).map(row => { const c = credentials(Buffer.from(row.cache, 'base64')); return { id: row.id, label: row.label, email: c.email, plan: c.plan, savedAt: row.savedAt, current: c.identity === this.current?.identity }; }),
      operation: own && op ? { id: op.id, kind: op.kind, state: op.state, error: op.error || null, profileId: op.profileId || null,
        ...(op.device && op.state === 'waiting' ? { device: { ...op.device }, expiresAt: op.expiresAt } : {}) } : null };
  }
  profileIdentity(id) { const row = this.data?.profiles.find(r => r.id === id); return row ? credentials(Buffer.from(row.cache, 'base64')).identity : null; }
  invalidateExternal(identity) {
    if (this.externalIdentity === identity) return this.resetFlight;
    this.externalIdentity = identity; this.revision = randomUUID(); this.verified = false;
    if (this.resetFlight || this.resetFailed) return this.resetFlight;
    // Publish the gate before any asynchronous cleanup. All observed changes share this stop.
    const flight = Promise.resolve().then(async () => {
      try { await this.stopReaders(); await this.resumeReaders(); }
      catch { this.resetFailed = true; this.error = 'ACCOUNT_READONLY_STOP_FAILED'; }
    }).finally(() => { if (this.resetFlight === flight) this.resetFlight = null; });
    this.resetFlight = flight;
    return flight;
  }
  async refresh(session) {
    await this.init();
    if (!this.busy && !this.storageFailed && !this.resetFailed) {
      if (!this.refreshFlight) {
        const flight = (async () => {
          try {
            if (this.resetFlight) await this.resetFlight;
            if (this.resetFailed) return;
            let current = await this.platform.readCurrent();
            if (this.current && (current.identity !== this.current.identity || this.externalIdentity && current.identity !== this.externalIdentity)) {
              await this.invalidateExternal(current.identity);
              if (this.resetFailed) return;
              current = await this.platform.readCurrent();
              if (current.identity !== this.externalIdentity) accountError('ACCOUNT_CHANGED');
            }
            this.current = current; this.externalIdentity = current.identity;
            if (!this.data.recovery && this.error !== 'ACCOUNT_LOGIN_CLEANUP_REQUIRED') this.error = null;
          } catch (e) { if (!this.data?.recovery) this.error = safeCode(e); }
        })().finally(() => { if (this.refreshFlight === flight) this.refreshFlight = null; });
        this.refreshFlight = flight;
      }
      await this.refreshFlight;
    }
    return this.view(session);
  }
  checkRevision(revision) { if (revision !== this.revision) accountError('ACCOUNT_CHANGED'); }
  guard(revision, identity = this.current?.identity) {
    this.checkRevision(revision);
    if (this.resetFailed) accountError('ACCOUNT_READONLY_STOP_FAILED');
    if (this.busy || this.resetFlight || this.storageFailed || this.data?.recovery) accountError(this.data?.recovery ? 'ACCOUNT_RECOVERY_REQUIRED' : 'ACCOUNT_BUSY');
    const actual = identity ? this.platform.currentIdentity() : null;
    if (identity && (actual !== identity || this.externalIdentity && actual !== this.externalIdentity)) { this.invalidateExternal(actual); accountError('ACCOUNT_CHANGED'); }
  }
  async enterWrite(revision) {
    await this.init(); this.guard(revision);
    const identity = this.current?.identity;
    this.leases++;
    let closed = false;
    return { authorize: () => this.guard(revision, identity), close: () => { if (!closed) { closed = true; this.leases--; } } };
  }
  presence(session, input) {
    if (!opaqueId(input.pageId) || typeof input.blocked !== 'boolean' || typeof input.visible !== 'boolean') accountError('ACCOUNT_INPUT_INVALID', 400);
    for (const [key, page] of this.pages) if (page.expires <= this.now() || this.now() - page.at > 45000) this.pages.delete(key);
    const key = session.id + '/' + input.pageId;
    if (!this.pages.has(key) && this.pages.size >= 32) accountError('ACCOUNT_PAGE_LIMIT', 429);
    if (input.closed === true || !input.visible && !input.blocked) this.pages.delete(key);
    else this.pages.set(key, { owner: session.id, pageId: input.pageId, blocked: input.blocked, visible: input.visible, at: this.now(), expires: session.expires });
    if (!this.busy && !this.storageFailed && !this.data?.recovery) {
      try { this.guard(this.revision); } catch (e) { if (e.code !== 'ACCOUNT_CHANGED') throw e; }
    }
    return { revision: this.revision, busy: this.busy || Boolean(this.resetFlight), recovery: Boolean(this.data?.recovery) };
  }
  idle(input, session) {
    if (this.leases || this.engine.sending.size || this.engine.creating.size || this.engine.records.some(r => ['reserved', 'active', 'pending', 'uncertain'].includes(r.state))) accountError('ACCOUNT_REQUESTS_UNRESOLVED');
    // Selected files are represented by fresh page presence; abandoned staging files stay untouched.
    if (this.engine.uploads.active.size) accountError('ACCOUNT_ATTACHMENTS_PRESENT');
    if (this.engine.accountTransfers) accountError('ACCOUNT_TRANSFER_BUSY');
    const own = this.pages.get(session.id + '/' + input.pageId);
    if (!own || own.blocked || this.now() - own.at > 15000) accountError('ACCOUNT_PAGE_NOT_READY');
    for (const [key, page] of this.pages) {
      if (page.expires <= this.now() || this.now() - page.at > 45000) { this.pages.delete(key); continue; }
      if (page.blocked || page.visible && this.now() - page.at > 15000) accountError('ACCOUNT_OTHER_PAGE_BUSY');
    }
  }
  async begin(session, kind, input, revision, authorize) {
    await this.init(); authorize(); this.checkRevision(revision);
    if (!opaqueId(input.operationId)) accountError('ACCOUNT_INPUT_INVALID', 400);
    const fingerprint = digest(JSON.stringify([kind, input]));
    const old = this.operations.get(input.operationId);
    if (old) {
      if (old.owner !== session.id || old.fingerprint !== fingerprint) accountError('ACCOUNT_OPERATION_CONFLICT');
      return this.view(session, old);
    }
    if (this.resetFailed) accountError('ACCOUNT_READONLY_STOP_FAILED');
    if (this.busy || this.leases || this.resetFlight || this.refreshFlight) accountError('ACCOUNT_BUSY');
    if (this.storageFailed || !this.data) accountError(this.error || 'ACCOUNT_STORAGE_UNSAFE');
    if (kind !== 'recover' && this.data.recovery) accountError('ACCOUNT_RECOVERY_REQUIRED');
    if (this.error === 'ACCOUNT_LOGIN_CLEANUP_REQUIRED') accountError(this.error);
    this.attempts = this.attempts.filter(at => this.now() - at < 60000);
    if (this.attempts.length >= 6) accountError('ACCOUNT_RATE_LIMIT', 429);
    this.attempts.push(this.now());
    if (['switch', 'recover'].includes(kind)) {
      if (this.platform.switchSupported !== true) accountError('ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE');
      if (input.confirmed !== true || input.pcTasksComplete !== true || !opaqueId(input.pageId)) accountError('ACCOUNT_CONFIRM_REQUIRED', 400);
      this.idle(input, session);
    }
    if (['save', 'login'].includes(kind)) accountLabel(input.label);
    if (['switch', 'remove', 'rename'].includes(kind) && (!opaqueId(input.profileId) || !this.data.profiles.some(r => r.id === input.profileId))) accountError('ACCOUNT_PROFILE_NOT_FOUND', 404);
    if (kind === 'rename') accountLabel(input.label);
    if (kind === 'recover' && (!this.data.recovery || !['rollback', 'keep-current'].includes(input.mode))) accountError('ACCOUNT_INPUT_INVALID', 400);
    const op = { id: input.operationId, owner: session.id, kind, fingerprint, state: 'working', revision, authorize };
    this.operation = op; this.operations.set(op.id, op); this.busy = true;
    while (this.operations.size > 32) this.operations.delete(this.operations.keys().next().value);
    op.flight = this.run(op, input).catch(e => { op.state = 'failed'; op.error = safeCode(e); this.error = this.data?.recovery ? 'ACCOUNT_RECOVERY_REQUIRED' : op.error; }).finally(() => {
      clearTimeout(op.timer); op.device = null; this.busy = false;
    });
    return this.view(session);
  }
  valid(op) { op.authorize(); if (this.operation !== op || op.cancelled) accountError('ACCOUNT_OPERATION_CANCELLED'); this.checkRevision(op.revision); }
  async run(op, input) {
    await this.platform.supported(); this.valid(op);
    if (op.kind === 'login') return this.login(op, input);
    if (op.kind === 'save') {
      const current = await this.platform.readCurrent(); this.valid(op);
      if (this.current && current.identity !== this.current.identity) accountError('ACCOUNT_CHANGED');
      const candidate = structuredClone(this.data), row = this.store.add(candidate, current, input.label, this.now()); candidate.active = row.id;
      this.valid(op); await this.store.save(candidate, () => this.valid(op)); this.data = candidate; this.current = current; op.profileId = row.id;
    } else if (op.kind === 'remove' || op.kind === 'rename') {
      const candidate = structuredClone(this.data), row = candidate.profiles.find(r => r.id === input.profileId);
      if (op.kind === 'rename') row.label = accountLabel(input.label);
      else { candidate.profiles = candidate.profiles.filter(r => r !== row); if (candidate.active === row.id) candidate.active = null; }
      this.valid(op); await this.store.save(candidate, () => this.valid(op)); this.data = candidate;
    } else if (op.kind === 'switch') await this.switchProfile(op, input);
    else if (op.kind === 'recover') await this.recover(op, input);
    op.state = 'completed'; this.error = null;
  }
  async stopReaders() { if (this.engine.pauseAccounts) await this.engine.pauseAccounts(); }
  resumeReaders() { return this.engine.resumeAccounts?.(); }
  async desktopIdle(op, input) {
    const snapshot = await this.platform.inspect();
    if (!snapshot.processes.length) return snapshot;
    // The installed recent-list API is NOT proof that every Desktop task is idle.
    let status = 'unknown';
    if (this.tasks) status = await this.tasks();
    else {
      const r = await this.engine.desktop.call('list_threads', { limit: 50 });
      if (!Array.isArray(r?.threads) || !Array.isArray(r?.pinnedThreads)) accountError('ACCOUNT_TASKS_UNKNOWN');
      const rows = [...r.threads, ...r.pinnedThreads];
      if (rows.length > 512 || rows.some(t => !t || normalizeStatus(t.status) === 'unknown')) accountError('ACCOUNT_TASKS_UNKNOWN');
      status = rows.some(t => ['active', 'waiting'].includes(normalizeStatus(t.status))) ? 'active' : 'idle';
    }
    if (status === 'active') accountError('ACCOUNT_TASKS_ACTIVE');
    if (status !== 'idle') accountError('ACCOUNT_TASKS_UNKNOWN');
    this.valid(op); this.idle(input, { id: op.owner });
    if (input.pcTasksComplete !== true) accountError('ACCOUNT_CONFIRM_REQUIRED');
    await this.platform.closeGui(snapshot);
    if ((await this.platform.inspect()).processes.length) accountError('ACCOUNT_DESKTOP_CLOSE_REQUIRED');
    return snapshot;
  }
  async switchProfile(op, input) {
    const row = this.data.profiles.find(r => r.id === input.profileId), target = credentials(Buffer.from(row.cache, 'base64'));
    try {
      await this.stopReaders();
      this.valid(op); this.idle(input, { id: op.owner });
      const before = await this.platform.readCurrent(); this.valid(op);
      if (this.current && before.identity !== this.current.identity) accountError('ACCOUNT_CHANGED');
      if (before.identity === target.identity) accountError('ACCOUNT_ALREADY_CURRENT');
      const snapshot = await this.desktopIdle(op, input); this.valid(op);
      const current = await this.platform.readCurrent(); this.valid(op);
      if (current.identity !== before.identity) accountError('ACCOUNT_CHANGED');
      const candidate = structuredClone(this.data), active = candidate.profiles.find(r => r.id === candidate.active);
      // Capture the last refreshed credentials, not a stale duplicate saved on the first login.
      if (active && credentials(Buffer.from(active.cache, 'base64')).identity === current.identity) { active.cache = current.bytes.toString('base64'); active.savedAt = this.now(); }
      candidate.recovery = accountRecovery(current, target, row.id);
      this.valid(op); await this.store.save(candidate, () => this.valid(op)); this.data = candidate;
      this.valid(op); this.idle(input, { id: op.owner });
      if ((await this.platform.inspect()).processes.length) accountError('ACCOUNT_DESKTOP_CLOSE_REQUIRED');
      this.valid(op);
      if (this.profileIdentity(row.id) !== target.identity) accountError('ACCOUNT_PROFILE_CHANGED');
      const installed = await this.platform.install(current.hash, target.bytes, { fileId: current.fileId, transaction: candidate.recovery.transaction });
      const published = structuredClone(this.data); published.recovery.installedFileId = installed.fileId;
      await this.store.save(published, () => this.valid(op)); this.data = published;
      this.revision = randomUUID(); op.revision = this.revision; this.verified = false;
      this.valid(op); await this.platform.launch(snapshot);
      const confirmed = await this.verify(target, op);
      this.valid(op);
      const done = structuredClone(this.data); done.active = row.id; done.recovery = null;
      const saved = done.profiles.find(r => r.id === row.id); saved.cache = confirmed.bytes.toString('base64'); saved.savedAt = this.now();
      await this.store.save(done, () => this.valid(op)); this.data = done; this.current = confirmed; this.verified = true; op.profileId = row.id;
    } catch (e) {
      // Rollback only the exact installed bytes, only while the exact GUI is absent.
      if (this.data.recovery) {
        try {
          if (!(await this.platform.inspect()).processes.length) {
            const previous = await this.restorePrevious(this.data.recovery);
            const restored = structuredClone(this.data); restored.recovery = null; await this.store.save(restored); this.data = restored; this.current = previous;
          }
        } catch { /* Preserve the encrypted recovery and write gate. Never overwrite a concurrent refresh. */ }
      }
      this.revision = randomUUID(); this.verified = false; throw e;
    } finally { await this.resumeReaders(); }
  }
  async verify(target, op) {
    let error;
    for (let attempt = 0; attempt < 8; attempt++) {
      this.valid(op);
      try { return await this.platform.verify(target, this.engine); }
      catch (e) { error = e; if (['ACCOUNT_CACHE_CHANGED', 'ACCOUNT_LOGIN_UNCONFIRMED'].includes(e.code)) throw e; }
      if (attempt < 7) await this.sleep(500);
    }
    throw error || new BridgeError('ACCOUNT_APP_UNCONFIRMED');
  }
  async restorePrevious(r) {
    const previous = credentials(Buffer.from(r.previous, 'base64')), current = await this.platform.readCurrent({ missing: true });
    if (current?.hash === previous.hash && current.fileId === r.fileId) return current;
    if (current && (current.hash !== r.expected || !r.installedFileId || current.fileId !== r.installedFileId)) accountError('ACCOUNT_CACHE_CHANGED');
    const installed = await this.platform.install(current?.hash || null, previous.bytes, { fileId: current?.fileId || null, transaction: r.transaction });
    return { ...previous, fileId: installed.fileId };
  }
  async recover(op, input) {
    try {
      await this.stopReaders();
      let current;
      if (input.mode === 'rollback') {
        const snapshot = await this.desktopIdle(op, input); this.valid(op);
        current = await this.restorePrevious(this.data.recovery); this.valid(op);
        // Persist the restored identity before launch; a failed launch can be safely retried.
        const restored = structuredClone(this.data); restored.recovery.fileId = current.fileId;
        restored.recovery.binding = digest(JSON.stringify([restored.recovery.transaction, current.fileId, current.hash, restored.recovery.expected, restored.recovery.target]));
        await this.store.save(restored, () => this.valid(op)); this.data = restored;
        await this.platform.launch(snapshot); current = await this.verify(current, op);
      } else { current = await this.platform.readCurrent(); this.valid(op); current = await this.platform.verify(current, this.engine); }
      this.valid(op);
      const candidate = structuredClone(this.data); candidate.recovery = null;
      candidate.active = candidate.profiles.find(row => credentials(Buffer.from(row.cache, 'base64')).identity === current.identity)?.id || null;
      if (candidate.active) { const row = candidate.profiles.find(p => p.id === candidate.active); row.cache = current.bytes.toString('base64'); row.savedAt = this.now(); }
      await this.store.save(candidate, () => this.valid(op)); this.data = candidate; this.current = current; this.verified = true; this.revision = randomUUID();
    } finally { await this.resumeReaders(); }
  }
  async login(op, input) {
    if (this.data.profiles.length >= ACCOUNT_LIMITS.profiles) accountError('ACCOUNT_PROFILE_LIMIT');
    await this.platform.prepare(this.store.root, this.store.dir); this.valid(op);
    const home = join(this.store.dir, 'login-' + op.id);
    let child, prepared = false;
    try {
      await this.platform.prepare(this.store.dir, home); prepared = true; this.valid(op);
      child = this.platform.loginFactory(home); op.child = child; op.state = 'waiting'; op.expiresAt = this.now() + ACCOUNT_LIMITS.loginMs;
      child.onCode(value => { if (op.state !== 'waiting') return; try { this.valid(op); if (this.now() >= op.expiresAt) accountError('ACCOUNT_LOGIN_EXPIRED'); op.device = officialDevice(value); } catch { op.cancelled = true; op.cancelLogin?.(); } });
      const expiry = new Promise((_, reject) => { op.timer = setTimeout(() => { op.cancelled = true; reject(new BridgeError('ACCOUNT_LOGIN_EXPIRED')); }, ACCOUNT_LIMITS.loginMs); op.timer.unref?.(); });
      const cancellation = new Promise((_, reject) => { op.cancelLogin = () => { op.cancelled = true; reject(new BridgeError('ACCOUNT_OPERATION_CANCELLED')); }; });
      await Promise.race([child.done, expiry, cancellation]); this.valid(op);
      if (this.now() >= op.expiresAt) accountError('ACCOUNT_LOGIN_EXPIRED');
      const cache = await this.platform.readLogin(home); this.valid(op);
      const candidate = structuredClone(this.data), row = this.store.add(candidate, cache, input.label, this.now());
      this.valid(op); await this.store.save(candidate, () => this.valid(op)); this.data = candidate; op.profileId = row.id; op.state = 'completed'; this.error = null;
    } finally {
      op.device = null; clearTimeout(op.timer);
      try {
        if (child) await child.cancel(); // Confirm child exit before touching its own plaintext home.
        if (prepared) await this.cleanupHome(home);
      } catch { this.error = 'ACCOUNT_LOGIN_CLEANUP_REQUIRED'; accountError(this.error); }
    }
  }
  async cleanupHome(home) {
    if (home !== join(this.store.dir, 'login-' + home.slice(home.lastIndexOf('login-') + 6)) || !/^login-[a-f0-9-]{36}$/.test(home.slice(this.store.dir.length + 1))) accountError('ACCOUNT_STORAGE_UNSAFE');
    await this.platform.privatePath(home, false); let count = 0;
    const walk = (dir, depth) => {
      inspectPath(dir); if (depth > 5) accountError('ACCOUNT_LOGIN_CLEANUP_REQUIRED');
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (++count > 256) accountError('ACCOUNT_LOGIN_CLEANUP_REQUIRED');
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p, depth + 1);
        else { inspectPath(p, { file: true }); fs.unlinkSync(p); }
      }
      fs.rmdirSync(dir);
    };
    walk(home, 0);
  }
  async cancel(session, id) {
    const op = this.operation;
    if (!op || op.owner !== session.id || op.id !== id || op.kind !== 'login') accountError('ACCOUNT_OPERATION_NOT_FOUND', 404);
    if (!this.busy) return this.view(session);
    op.cancelled = true; op.cancelLogin?.(); await op.flight; return this.view(session);
  }
  revoke(session) {
    for (const [key, page] of this.pages) if (page.owner === session.id) this.pages.delete(key);
    const op = this.operation;
    if (this.busy && op?.kind === 'login' && op.owner === session.id) { op.cancelled = true; op.cancelLogin?.(); }
  }
  close() { const op = this.operation; if (op?.kind === 'login') { op.cancelled = true; op.cancelLogin?.(); } }
}
