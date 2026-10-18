import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { resolveCodexExecutable } from './codex-install.mjs';
// Standalone app-server is strictly read-only: desktop-owned writers must never be resumed here.
const METHODS = new Set(['initialize', 'account/read', 'account/usage/read', 'thread/list', 'thread/read', 'thread/turns/list']);

export class BridgeError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}

// No raw child stderr or protocol error strings cross the bridge boundary.
export class Rpc extends EventEmitter {
  constructor({ executable, resolveExecutable = resolveCodexExecutable, args = ['app-server', '--listen', 'stdio://'], childFactory = spawn, timeoutMs = 30000 } = {}) {
    super();
    this.options = { executable, resolveExecutable, args, childFactory, timeoutMs };
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }

  start() {
    if (this.starting) return this.starting;
    if (this.child && !this.closed) return Promise.resolve(this);
    if (this.child) this.close();
    const flight = this.launch().finally(() => { if (this.starting === flight) this.starting = null; });
    this.starting = flight; return flight;
  }

  async launch() {
    const { executable, resolveExecutable, args, childFactory } = this.options;
    this.closed = false; this.buffer = ''; this.decoder = new StringDecoder('utf8');
    try {
      // Resolve on every new child, including after Desktop replaces its installed cache.
      const child = childFactory(executable ?? resolveExecutable(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.child = child;
      const current = () => this.child === child && !this.closed;
      child.stdout.on('data', chunk => { if (current()) this.consume(chunk); });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => { if (current()) this.fail(); });
      child.on('error', () => { if (current()) this.fail(); });
      child.on('exit', () => { if (current()) this.fail(); });
      await this.request('initialize', { clientInfo: { name: 'codex_phone', title: 'Codex 원격', version: '0.1.0' } });
      this.write({ method: 'initialized', params: {} });
      return this;
    } catch (error) {
      this.close();
      throw new BridgeError(['CODEX_INSTALL_UNAVAILABLE', 'CODEX_INSTALL_AMBIGUOUS', 'CODEX_TIMEOUT', 'CODEX_REQUEST_FAILED'].includes(error?.code) ? error.code : 'CODEX_DISCONNECTED');
    }
  }

  consume(chunk) {
    this.buffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) return this.fail();
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.fail(); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { this.fail(); return; }
      if (msg.method) {
        if (msg.id !== undefined) this.emit('request', msg);
        else this.emit('notification', msg);
      } else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const error = new BridgeError('CODEX_REQUEST_FAILED', 502);
          error.rpcCode = Number.isInteger(msg.error.code) ? msg.error.code : null;
          p.reject(error);
        } else p.resolve(msg.result);
      }
    }
  }

  write(msg) {
    if (this.closed || !this.child) throw new BridgeError('CODEX_DISCONNECTED');
    try { this.child.stdin.write(JSON.stringify(msg) + '\n'); }
    catch { this.fail(); throw new BridgeError('CODEX_DISCONNECTED'); }
  }

  request(method, params = {}) {
    if (!METHODS.has(method) || method === 'account/usage/read' && arguments.length > 1) return Promise.reject(new BridgeError('METHOD_NOT_ALLOWED', 403));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('CODEX_TIMEOUT'));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(method === 'account/usage/read' ? { id, method } : { id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id, result) { this.write({ id, result }); }
  reject(id) { this.write({ id, error: { code: -32601, message: 'Unsupported client request' } }); }

  fail() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new BridgeError('CODEX_DISCONNECTED'));
    }
    this.pending.clear();
    this.emit('disconnect');
  }

  async stop() {
    const child = this.child;
    if (!child || child.exitCode !== null && child.exitCode !== undefined) { this.close(); return; }
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.off('exit', done); reject(new BridgeError('ACCOUNT_READONLY_STOP_FAILED')); }, 3000); timer.unref?.();
      const done = () => { clearTimeout(timer); resolve(); }; child.once('exit', done);
    });
    this.close(); await exited;
  }
  close() {
    try { this.fail(); }
    finally {
      // Only our child transport. Never enumerate or kill other Codex processes.
      const child = this.child; this.child = null;
      child?.stdin.end(); child?.kill();
    }
  }
}
