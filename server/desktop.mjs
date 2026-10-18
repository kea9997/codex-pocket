import net from 'node:net';
import { readdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './rpc.mjs';
import { threadId } from './security.mjs';
import { advertisedModels, choices } from './options.mjs';

export const MAX_FRAME = 8 * 1024 * 1024;
export const DESKTOP_TOOLS = ['list_threads', 'read_thread', 'wait_threads', 'send_message_to_thread', 'get_usage_limits', 'list_projects', 'create_thread'];
export const HISTORY_SIZE_MESSAGE = 'Tool response exceeds the size limit. Request fewer turns or omit outputs. A single oversized turn cannot be returned by this tool.';
export function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > MAX_FRAME) throw new BridgeError('DESKTOP_FRAME_TOO_LARGE');
  const buffer = Buffer.alloc(4 + payload.length);
  buffer.writeUInt32LE(payload.length); payload.copy(buffer, 4); return buffer;
}
export class Frames {
  constructor(consume) { this.buffer = Buffer.alloc(0); this.consume = consume; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (!size || size > MAX_FRAME) throw new BridgeError('DESKTOP_FRAME_INVALID');
      if (this.buffer.length < size + 4) return;
      const payload = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      let value;
      try { value = JSON.parse(payload.toString('utf8')); } catch { throw new BridgeError('DESKTOP_FRAME_INVALID'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('DESKTOP_FRAME_INVALID');
      this.consume(value);
    }
  }
}
export async function discoverPipe() {
  let names;
  try { names = (await readdir('\\\\.\\pipe\\')).filter(n => n.startsWith('codex-app-tools-')); }
  catch { throw new BridgeError('DESKTOP_NOT_AVAILABLE'); }
  if (names.length !== 1) throw new BridgeError(names.length ? 'DESKTOP_PIPE_AMBIGUOUS' : 'DESKTOP_NOT_AVAILABLE');
  return '\\\\.\\pipe\\' + names[0];
}

// Same-user desktop plugin transport. No impersonation, app-server resume or alternate auth.
export class Desktop extends EventEmitter {
  constructor({ controllerId, discover = discoverPipe, connect = path => net.createConnection(path), timeoutMs = 30000 } = {}) {
    super(); this.controllerId = threadId(controllerId); this.discover = discover; this.connectSocket = connect;
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.sequence = 0; this.socket = null;
    this.connecting = null; this.catalog = null; this.catalogLoading = null; this.closed = false;
  }
  async connect() {
    if (this.closed) throw new BridgeError('DESKTOP_NOT_AVAILABLE');
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const path = await this.discover();
      await new Promise((resolve, reject) => {
        const socket = this.connectSocket(path);
        const timer = setTimeout(() => { socket.destroy(); reject(new BridgeError('DESKTOP_NOT_AVAILABLE')); }, 5000);
        const failed = () => { clearTimeout(timer); socket.destroy(); reject(new BridgeError('DESKTOP_NOT_AVAILABLE')); };
        socket.once('error', failed);
        socket.once('connect', () => {
          clearTimeout(timer); socket.off('error', failed); this.socket = socket; this.catalog = null;
          const frames = new Frames(value => {
            const p = this.pending.get(value.id);
            if (!p) return;
            this.pending.delete(value.id); clearTimeout(p.timer);
            if (value.error) p.reject(new BridgeError('DESKTOP_REQUEST_FAILED', 502)); else p.resolve(value.result);
          });
          socket.on('data', chunk => { try { frames.push(chunk); } catch { this.disconnect(socket); } });
          socket.on('error', () => this.disconnect(socket)); socket.on('close', () => this.disconnect(socket));
          resolve();
        });
      });
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  disconnect(socket) {
    if (this.socket !== socket) return;
    this.socket = null; this.catalog = null; this.catalogLoading = null; socket.destroy();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BridgeError('DESKTOP_DISCONNECTED')); }
    this.pending.clear(); this.emit('disconnect');
  }
  async request(method, params, authorize = () => {}) {
    if (!['tools/list', 'tools/call'].includes(method)) throw new BridgeError('METHOD_NOT_ALLOWED', 403);
    await this.connect(); authorize();
    if (this.pending.size >= 32) throw new BridgeError('DESKTOP_BUSY', 429);
    const id = ++this.sequence, socket = this.socket;
    const data = frame({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError('DESKTOP_TIMEOUT')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { socket.write(data); } catch { this.disconnect(socket); }
    });
  }
  async tools({ refresh = false } = {}) {
    await this.connect();
    if (!refresh && this.catalog) return this.catalog;
    if (!this.catalogLoading) {
      const socket = this.socket;
      const flight = this.request('tools/list', { threadStartKind: 'all' }).then(r => {
        if (socket !== this.socket) throw new BridgeError('DESKTOP_DISCONNECTED');
        if (!Array.isArray(r?.tools)) throw new BridgeError('DESKTOP_RESPONSE_INVALID', 502);
        this.catalog = r.tools; return r.tools;
      }).finally(() => { if (this.catalogLoading === flight) this.catalogLoading = null; });
      this.catalogLoading = flight;
    }
    return this.catalogLoading;
  }
  async call(tool, args, callId = randomUUID(), authorize = () => {}) {
    if (!DESKTOP_TOOLS.includes(tool)) throw new BridgeError('TOOL_NOT_ALLOWED', 403);
    const catalog = await this.tools();
    const found = catalog.filter(t => t.name === tool && t.namespace === 'codex_app');
    if (found.length !== 1) throw new BridgeError('DESKTOP_TOOL_UNSUPPORTED', 409);
    if (['create_thread', 'send_message_to_thread'].includes(tool)) {
      const choice = choices(args);
      if (choice.model) {
        const model = advertisedModels(found[0]).find(m => m.id === choice.model);
        if (!model || (choice.thinking && !model.efforts.includes(choice.thinking))) throw new BridgeError('MODEL_CHOICE_UNAVAILABLE', 409);
      }
    }
    const result = await this.request('tools/call', { namespace: 'codex_app', tool, arguments: args,
      callerSource: 'codex', hostId: 'local', threadId: this.controllerId,
      turnId: 'mcp-turn-codex-phone-user', callId: `mcp-call-${callId}` }, authorize);
    if (!result?.success) {
      const oversized = tool === 'read_thread' && Array.isArray(result?.contentItems) && result.contentItems.length === 1 &&
        result.contentItems[0]?.type === 'inputText' && result.contentItems[0].text === HISTORY_SIZE_MESSAGE;
      throw new BridgeError(oversized ? 'HISTORY_SIZE_LIMIT' : 'DESKTOP_TOOL_FAILED', 502);
    }
    const content = result.contentItems?.filter(i => i.type === 'inputText').map(i => i.text).join('\n');
    try { const data = JSON.parse(content); if (!data || typeof data !== 'object') throw new Error(); return data; }
    catch { throw new BridgeError('DESKTOP_RESPONSE_INVALID', 502); }
  }
  async reset() {
    this.closed = true;
    if (this.connecting) { try { await this.connecting; } catch { /* Stop only this transport. */ } }
    if (this.socket) this.disconnect(this.socket);
    this.catalog = null; this.catalogLoading = null; this.closed = false;
  }
  close() {
    this.closed = true;
    if (this.socket) this.disconnect(this.socket);
  }
}
