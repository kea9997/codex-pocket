import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../server/engine.mjs';
import { Auth } from '../server/security.mjs';
import { BridgeError } from '../server/rpc.mjs';
import { DESKTOP_TOOLS } from '../server/desktop.mjs';
import { request } from 'node:http';

export function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-phone-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
export class MockDesktop {
  constructor() {
    this.socket = { destroyed: false }; this.catalog = DESKTOP_TOOLS.map(name => ({ name, namespace: 'codex_app' }));
    this.calls = []; this.status = 'idle'; this.hook = null;
  }
  async tools() { return this.catalog; }
  async call(tool, args, callId) {
    this.calls.push({ tool, args, callId });
    if (this.hook) { const r = await this.hook(tool, args, callId); if (r !== undefined) return r; }
    if (tool === 'list_threads') return { pinnedThreads: [], threads: [this.thread('thread-fixture')] };
    if (tool === 'read_thread') return { thread: this.thread(args.threadId),
      page: { nextCursor: args.cursor ? null : 'history-2', hasMore: !args.cursor },
      turns: [{ id: args.cursor ? 'turn-old' : 'turn-current', startedAt: args.cursor ? 1 : 2, status: 'completed',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: '한글 질문' }] },
          { type: 'reasoning', get content() { throw new Error('Must not inspect reasoning'); } },
          { type: 'agentMessage', text: '기존 답변' }] }] };
    if (tool === 'send_message_to_thread') return { threadId: args.threadId };
    throw new BridgeError('TOOL_NOT_ALLOWED', 403);
  }
  thread(id) { return { id, title: 'PC 실시간 제목', cwd: 'D:/fixture', kind: 'codex', hostId: 'local', status: { type: this.status }, updatedAt: 100 }; }
  close() { this.socket.destroyed = true; }
}
export async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-phone-test-'));
  const desktop = new MockDesktop(), calls = [];
  const rpc = { closed: false, async request(method, params) {
    calls.push({ method, params });
    if (method !== 'thread/list') throw new BridgeError('METHOD_NOT_ALLOWED', 403);
    return { data: params.cursor ? [] : [{ id: 'thread-fixture', name: '저장된 제목', source: 'appServer' }], nextCursor: params.cursor ? null : 'list-2' };
  }, close() { this.closed = true; } };
  const auth = new Auth(dir); auth.issuePairing();
  const engine = new Engine(desktop, dir, { historyRpcFactory: async () => rpc });
  t.after(() => { try { engine.close(); } finally { rmSync(dir, { recursive: true, force: true }); } });
  const fx = { async snapshot() { return { source: 'frankfurter', base: 'USD', quote: 'KRW', state: 'unavailable', rate: null, date: null, checkedAt: null, stale: false, refreshAfter: null }; } };
  return { desktop, engine, auth, dir, calls, rpc, fx };
}
export function httpCall(port, path, { method = 'GET', headers = {}, data } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method,
      headers: { Host: '100.64.0.10:47831', ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const value = Buffer.concat(chunks).toString(); let json;
        try { json = JSON.parse(value); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text: value, data: Buffer.concat(chunks), json }); });
    });
    req.on('error', reject); if (data !== undefined) req.end(typeof data === 'string' ? data : JSON.stringify(data)); else req.end();
  });
}
export async function waitFor(predicate, ms = 2000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > ms) throw new Error('WAIT_TIMEOUT'); await new Promise(r => setTimeout(r, 10)); }
}
