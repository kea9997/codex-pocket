import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError } from './rpc.mjs';

// Synthetic defaults for isolated createBridge tests only. main.mjs always supplies validated private configuration.
export const HOST = '100.64.0.10';
export const PORT = 47831;
export const ORIGIN = `http://${HOST}:${PORT}`;
export const TEST_NETWORK = Object.freeze({ host: HOST, port: PORT, origin: ORIGIN, peers: Object.freeze(['100.64.0.11', '127.0.0.1', '::1']) });
export const COOKIE = 'codex_phone';
export function guardPeer(address, config = TEST_NETWORK) {
  const ip = address?.replace(/^::ffff:/, '');
  if (![config.host, ...config.peers].includes(ip)) throw new BridgeError('PEER_REJECTED', 403);
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export const random = () => randomBytes(32).toString('base64url');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
}
export function saveJson(path, value) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  const fd = openSync(temp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
export function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); }
  catch { throw new BridgeError('PRIVATE_STATE_INVALID'); }
}

export class Auth {
  constructor(dir, { now = Date.now, ttl = 7 * 86400000, pairingTtl = 86400000 } = {}) {
    this.dir = dir; this.now = now; this.ttl = ttl; this.pairingTtl = pairingTtl;
    this.path = join(dir, 'sessions.json');
    this.sessions = loadJson(this.path, []);
    this.attempts = new Map();
    this.globalAttempts = [];
    this.pairing = null;
    this.prune();
  }
  prune() {
    this.sessions = this.sessions.filter(s => s.expires > this.now());
    saveJson(this.path, this.sessions);
  }
  issuePairing({ force = false } = {}) {
    const path = join(this.dir, 'pairing.json');
    const previous = loadJson(path, null);
    if (!force && previous?.expires > this.now() && /^[A-F0-9]{16}$/.test(previous.code ?? '')) {
      this.pairing = { digest: hash(previous.code), expires: previous.expires }; return;
    }
    const code = randomBytes(8).toString('hex').toUpperCase();
    this.pairing = { digest: hash(code), expires: this.now() + this.pairingTtl };
    saveJson(path, { code, expires: this.pairing.expires });
  }
  rateLimit(ip) {
    const cutoff = this.now() - 10 * 60000;
    this.globalAttempts = this.globalAttempts.filter(t => t > cutoff);
    for (const [key, times] of this.attempts) {
      const live = times.filter(t => t > cutoff);
      if (!live.length) this.attempts.delete(key); else this.attempts.set(key, live);
    }
    const times = this.attempts.get(ip) ?? [];
    if (times.length >= 5 || this.globalAttempts.length >= 20 || this.attempts.size >= 100)
      throw new BridgeError('PAIRING_RATE_LIMIT', 429);
    times.push(this.now()); this.globalAttempts.push(this.now()); this.attempts.set(ip, times);
  }
  pair(code, ip) {
    this.rateLimit(ip);
    if (typeof code !== 'string' || !/^[A-Fa-f0-9]{16}$/.test(code) || !this.pairing ||
        this.pairing.expires <= this.now() || !equal(hash(code.toUpperCase()), this.pairing.digest))
      throw new BridgeError('PAIRING_INVALID', 401);
    const token = random();
    const session = { id: hash(token), csrf: random(), expires: this.now() + this.ttl };
    this.sessions = this.sessions.filter(s => s.expires > this.now());
    if (this.sessions.length >= 8) throw new BridgeError('SESSION_LIMIT', 409);
    // Consume durably before issuing a session: a crash must not resurrect a used code.
    this.pairing = null;
    saveJson(join(this.dir, 'pairing.json'), { used: true });
    this.sessions.push(session);
    saveJson(this.path, this.sessions);
    return { token, session };
  }
  authenticate(cookie = '') {
    if (cookie.length > 4096) throw new BridgeError('AUTH_REQUIRED', 401);
    const parts = cookie.split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
    if (parts.length !== 1) throw new BridgeError('AUTH_REQUIRED', 401);
    const token = parts[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BridgeError('AUTH_REQUIRED', 401);
    const session = this.sessions.find(s => equal(hash(token), s.id) && s.expires > this.now());
    if (!session) throw new BridgeError('AUTH_REQUIRED', 401);
    return session;
  }
  csrf(session, header) {
    if (!equal(header, session.csrf)) throw new BridgeError('CSRF_REJECTED', 403);
  }
  revoke(session) {
    this.sessions = this.sessions.filter(s => s.id !== session.id);
    saveJson(this.path, this.sessions);
  }
}

export function guardRequest(req, config = TEST_NETWORK) {
  if (req.headers.host !== `${config.host}:${config.port}`) throw new BridgeError('HOST_REJECTED', 403);
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== config.origin) throw new BridgeError('ORIGIN_REJECTED', 403);
  if (req.method === 'POST' && origin !== config.origin) throw new BridgeError('ORIGIN_REQUIRED', 403);
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
    throw new BridgeError('CROSS_SITE_REJECTED', 403);
  if (!['GET', 'POST'].includes(req.method)) throw new BridgeError('METHOD_NOT_ALLOWED', 405);
}

export const JSON_BODY_TIMEOUT_MS = 15000;
export async function body(req, limit = 24000, clock = globalThis) {
  if (req.headers['content-type'] !== 'application/json') throw new BridgeError('JSON_REQUIRED', 415);
  if (req.headers['content-encoding']) throw new BridgeError('ENCODING_REJECTED', 415);
  if (Number(req.headers['content-length']) > limit) throw new BridgeError('BODY_TOO_LARGE', 413);
  const bytes = await new Promise((resolve, reject) => {
    let size = 0, settled = false; const chunks = [];
    const finish = (error) => {
      if (settled) return; settled = true; clock.clearTimeout(timer);
      for (const [event, handler] of listeners) req.removeListener(event, handler);
      if (error) { req.pause(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const listeners = [['data', chunk => { size += chunk.length; if (size > limit) finish(new BridgeError('BODY_TOO_LARGE', 413)); else chunks.push(chunk); }],
      ['end', () => finish()], ['error', () => finish(new BridgeError('BODY_INTERRUPTED', 400))],
      ['aborted', () => finish(new BridgeError('BODY_INTERRUPTED', 400))], ['close', () => finish(new BridgeError('BODY_INTERRUPTED', 400))]];
    const timer = clock.setTimeout(() => finish(new BridgeError('BODY_TIMEOUT', 408)), JSON_BODY_TIMEOUT_MS); timer.unref?.();
    for (const [event, handler] of listeners) req.on(event, handler);
  });
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new BridgeError('INVALID_JSON', 400); }
}
export function keys(value, allowed) {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new BridgeError('INVALID_FIELDS', 400);
}
export function text(value, max, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\u0000/.test(value))
    throw new BridgeError('INVALID_INPUT', 400);
  return value;
}
export function threadId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new BridgeError('INVALID_THREAD_ID', 400);
  return value;
}
