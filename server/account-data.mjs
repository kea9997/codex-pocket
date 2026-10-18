import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BridgeError } from './rpc.mjs';

export const ACCOUNT_LIMITS = Object.freeze({ profiles: 8, authBytes: 32768, storeBytes: 512 * 1024, label: 40, loginMs: 15 * 60000 });
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const accountError = (code = 'ACCOUNT_STORAGE_UNSAFE', status = 409) => { throw new BridgeError(code, status); };
export const opaqueId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function accountLabel(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > ACCOUNT_LIMITS.label || /[\x00-\x1f\x7f]/.test(value)) accountError('ACCOUNT_LABEL_INVALID', 400);
  return value.trim();
}
const safeString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value);
// Local cache claims are identifiers, not a JWT signature verification or a claim of Desktop login.
export function credentials(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 10 || bytes.length > ACCOUNT_LIMITS.authBytes) throw 0;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || Array.isArray(value) || Object.keys(value).some(k => !['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(k)) ||
        (value.auth_mode !== undefined && value.auth_mode !== 'chatgpt') || value.OPENAI_API_KEY != null) throw 0;
    const t = value.tokens;
    if (!t || Object.keys(t).some(k => !['id_token', 'access_token', 'refresh_token', 'account_id'].includes(k)) ||
        !['id_token', 'access_token', 'refresh_token'].every(k => safeString(t[k], 16384)) || !safeString(t.account_id, 256)) throw 0;
    const parts = t.id_token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw 0;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), auth = claims['https://api.openai.com/auth'];
    if (claims.iss !== 'https://auth.openai.com' || !safeString(claims.sub, 256) || !auth || auth.chatgpt_account_id !== t.account_id ||
        typeof claims.email !== 'string' || claims.email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(claims.email)) throw 0;
    const plan = typeof auth.chatgpt_plan_type === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(auth.chatgpt_plan_type) ? auth.chatgpt_plan_type : null;
    return { bytes, hash: digest(bytes), identity: digest(JSON.stringify([claims.sub, t.account_id])), email: claims.email, plan };
  } catch { accountError('ACCOUNT_CACHE_UNSUPPORTED'); }
}

// This accepts only canonical, ordinary, single-link files, checking the opened identity too.
export function inspectPath(target, { file = false, missing = false } = {}) {
  if (!path.isAbsolute(target) || target !== path.normalize(target) || /[\x00-\x1f]|(?:^|[\\/])\.\.(?:[\\/]|$)|^(?:\\\\|\/\/)/.test(target)) accountError();
  let current = path.parse(target).root;
  for (const part of path.relative(current, target).split(path.sep)) {
    if (!part || /[<>:"|?*]|[. ]$/.test(part)) accountError();
    current = path.join(current, part);
    let s;
    try { s = fs.lstatSync(current, { bigint: true }); }
    catch (e) { if (missing && current === target && e.code === 'ENOENT') return null; accountError(); }
    const canonical = fs.realpathSync(current), same = process.platform === 'win32' ? canonical.toLowerCase() === current.toLowerCase() : canonical === current;
    if (s.isSymbolicLink() || !same ||
        (current === target && file ? !s.isFile() || s.nlink !== 1n : !s.isDirectory())) accountError();
    if (current === target) return s;
  }
  accountError();
}
const identity = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join('/');
export function boundedRead(target, limit, { missing = false } = {}) {
  const before = inspectPath(target, { file: true, missing });
  if (!before) return null;
  if (before.size < 1n || before.size > BigInt(limit)) accountError();
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(before)) accountError();
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) accountError(); offset += n; }
    if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(before) || identity(inspectPath(target, { file: true })) !== identity(before)) accountError();
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function accountRecovery(previous, target, profileId, transaction = randomUUID()) {
  const value = { previous: previous.bytes.toString('base64'), expected: target.hash, target: profileId, transaction, fileId: previous.fileId,
    targetCache: target.bytes.toString('base64'), installedFileId: null };
  value.binding = digest(JSON.stringify([transaction, previous.fileId, previous.hash, target.hash, profileId]));
  return value;
}
export function validateRecovery(r, ids) {
  if (!r || Object.keys(r).some(k => !['previous', 'expected', 'target', 'transaction', 'fileId', 'targetCache', 'installedFileId', 'binding'].includes(k)) || !ids.has(r.target)) accountError('ACCOUNT_STORE_UNREADABLE');
  const previous = credentials(Buffer.from(r.previous, 'base64')), target = credentials(Buffer.from(r.targetCache, 'base64'));
  const fileId = /^[a-f0-9]{8}:[a-f0-9]{16}:[a-f0-9]{16}$/;
  if (!opaqueId(r.transaction) || !fileId.test(r.fileId) || r.installedFileId !== null && !fileId.test(r.installedFileId) || target.hash !== r.expected ||
      r.binding !== digest(JSON.stringify([r.transaction, r.fileId, previous.hash, target.hash, r.target]))) accountError('ACCOUNT_STORE_UNREADABLE');
}

export class AccountStore {
  constructor(root, platform) { this.root = path.resolve(root); this.dir = path.join(this.root, 'accounts'); this.file = path.join(this.dir, 'profiles.bin'); this.platform = platform; this.version = null; }
  async load() {
    inspectPath(this.root);
    await this.platform.privatePath(this.root, false);
    if (!inspectPath(this.dir, { missing: true })) return this.empty();
    await this.platform.privatePath(this.dir, false);
    const encrypted = boundedRead(this.file, ACCOUNT_LIMITS.storeBytes, { missing: true });
    if (!encrypted) return this.empty();
    await this.platform.privatePath(this.file, true);
    this.version = digest(encrypted);
    try {
      const plain = await this.platform.unprotect(encrypted);
      if (!Buffer.isBuffer(plain) || plain.length > ACCOUNT_LIMITS.storeBytes) throw 0;
      let value;
      try { value = JSON.parse(plain.toString('utf8')); } finally { plain.fill(0); }
      if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > ACCOUNT_LIMITS.profiles ||
          Object.keys(value).some(k => !['version', 'profiles', 'active', 'recovery'].includes(k))) throw 0;
      const ids = new Set();
      for (const row of value.profiles) {
        if (!opaqueId(row.id) || ids.has(row.id) || accountLabel(row.label) !== row.label || !Number.isSafeInteger(row.savedAt) ||
            Object.keys(row).some(k => !['id', 'label', 'cache', 'savedAt'].includes(k)) || typeof row.cache !== 'string') throw 0;
        ids.add(row.id); credentials(Buffer.from(row.cache, 'base64'));
      }
      if (value.active !== null && !ids.has(value.active)) throw 0;
      if (value.recovery !== null) validateRecovery(value.recovery, ids);
      return value;
    } catch { accountError('ACCOUNT_STORE_UNREADABLE', 503); }
  }
  empty() { this.version = null; return { version: 1, profiles: [], active: null, recovery: null }; }
  async save(value, authorize = () => {}) {
    const plain = Buffer.from(JSON.stringify(value));
    if (plain.length > ACCOUNT_LIMITS.storeBytes - 16384) accountError('ACCOUNT_PROFILE_LIMIT');
    let encrypted;
    try { encrypted = await this.platform.protect(plain); } finally { plain.fill(0); }
    if (!Buffer.isBuffer(encrypted) || encrypted.length > ACCOUNT_LIMITS.storeBytes) accountError();
    await this.platform.prepare(this.root, this.dir);
    inspectPath(this.dir); await this.platform.privatePath(this.dir, false);
    authorize(); // Last broker boundary after asynchronous DPAPI/ACL work, before publication.
    await this.platform.replace(this.file, this.version, encrypted, true);
    this.version = digest(encrypted);
  }
  add(value, cache, label, now) {
    if (value.profiles.length >= ACCOUNT_LIMITS.profiles) accountError('ACCOUNT_PROFILE_LIMIT');
    // Same email is not an identity. Workspace/account and subject remain distinct.
    if (value.profiles.some(r => credentials(Buffer.from(r.cache, 'base64')).identity === cache.identity)) accountError('ACCOUNT_ALREADY_SAVED');
    const row = { id: randomUUID(), label: accountLabel(label), cache: cache.bytes.toString('base64'), savedAt: now };
    value.profiles.push(row); return row;
  }
}
