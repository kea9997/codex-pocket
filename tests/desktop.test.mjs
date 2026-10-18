import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Desktop, Frames, frame, MAX_FRAME, DESKTOP_TOOLS, HISTORY_SIZE_MESSAGE } from '../server/desktop.mjs';
import { modelTool } from './options-fixture.mjs';
import { BridgeError } from '../server/rpc.mjs';

const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);
function transport(t, { timeoutMs = 200, respond } = {}) {
  const calls = [], paths = [], sockets = []; let discoveries = 0;
  const desktop = new Desktop({ controllerId: 'controller-not-target', timeoutMs,
    discover: async () => `test-pipe-${++discoveries}`,
    connect: path => {
      paths.push(path); const socket = new EventEmitter(); socket.destroyed = false;
      socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; queueMicrotask(() => socket.emit('close')); } };
      const parser = new Frames(msg => {
        calls.push(msg);
        let result = msg.method === 'tools/list' ? { tools: DESKTOP_TOOLS.map(name => ({ name, namespace: 'codex_app' })) }
          : { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threadId: msg.params.arguments.threadId, title: '한글 정상' }) }] };
        if (respond) result = respond(msg, result, socket);
        if (result === undefined) return;
        const bytes = frame({ jsonrpc: '2.0', id: msg.id, result });
        queueMicrotask(() => { socket.emit('data', bytes.subarray(0, 7)); socket.emit('data', bytes.subarray(7)); });
      });
      socket.write = data => parser.push(data);
      sockets.push(socket); queueMicrotask(() => socket.emit('connect')); return socket;
    }
  });
  t.after(() => desktop.close()); return { desktop, calls, paths, sockets };
}
test('only the exact known read_thread size error maps to HISTORY_SIZE_LIMIT; no raw error reflection or replay', async t => {
  for (const [tool, contentItems, expected] of [
    ['read_thread', [{ type: 'inputText', text: HISTORY_SIZE_MESSAGE }], 'HISTORY_SIZE_LIMIT'],
    ['read_thread', [{ type: 'inputText', text: HISTORY_SIZE_MESSAGE + ' private detail' }], 'DESKTOP_TOOL_FAILED'],
    ['read_thread', [{ type: 'inputText', text: HISTORY_SIZE_MESSAGE }, { type: 'inputText', text: 'extra' }], 'DESKTOP_TOOL_FAILED'],
    ['read_thread', [{ type: 'inputText', text: 'size limit' }], 'DESKTOP_TOOL_FAILED'],
    ['send_message_to_thread', [{ type: 'inputText', text: HISTORY_SIZE_MESSAGE }], 'DESKTOP_TOOL_FAILED']
  ]) {
    const f = transport(t, { respond: (msg, result) => msg.method === 'tools/call' ? { success: false, contentItems } : result });
    await rejects(f.desktop.call(tool, { threadId: 'fixture' }), expected);
    assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 1);
  }
});
test('byte framing handles every split point, coalesced packets and multibyte Korean', () => {
  const values = [{ id: 1, text: '한글🎉 split' }, { id: 2, text: '둘째' }];
  const bytes = Buffer.concat(values.map(frame));
  for (let split = 0; split <= bytes.length; split++) {
    const actual = [], parser = new Frames(v => actual.push(v));
    parser.push(bytes.subarray(0, split)); parser.push(bytes.subarray(split)); assert.deepEqual(actual, values);
  }
  const actual = [], parser = new Frames(v => actual.push(v)); for (const b of bytes) parser.push(Buffer.from([b]));
  assert.deepEqual(actual, values);
});
test('invalid, zero, excessive and nonobject frames rejected', () => {
  for (const size of [0, MAX_FRAME + 1]) {
    const b = Buffer.alloc(4); b.writeUInt32LE(size);
    assert.throws(() => new Frames(() => {}).push(b), e => e.code === 'DESKTOP_FRAME_INVALID');
  }
  assert.throws(() => new Frames(() => {}).push(frame(null)), e => e.code === 'DESKTOP_FRAME_INVALID');
  assert.throws(() => new Frames(() => {}).push(frame([])), e => e.code === 'DESKTOP_FRAME_INVALID');
  assert.throws(() => frame({ text: 'x'.repeat(MAX_FRAME) }), e => e.code === 'DESKTOP_FRAME_TOO_LARGE');
});
test('tools metadata uses actual controller not target; catalog cached and only seven named tools allowed', async t => {
  const { desktop, calls } = transport(t);
  const result = await desktop.call('send_message_to_thread', { threadId: 'target-existing', hostId: 'local', prompt: '모의 전송' }, 'uuid-fixture');
  assert.equal(result.title, '한글 정상');
  assert.deepEqual(calls[0].params, { threadStartKind: 'all' });
  assert.deepEqual(calls[1].params, { namespace: 'codex_app', tool: 'send_message_to_thread',
    arguments: { threadId: 'target-existing', hostId: 'local', prompt: '모의 전송' },
    callerSource: 'codex', hostId: 'local', threadId: 'controller-not-target', turnId: 'mcp-turn-codex-phone-user', callId: 'mcp-call-uuid-fixture' });
  await desktop.call('read_thread', { threadId: 'target-existing' }); assert.equal(calls.filter(c => c.method === 'tools/list').length, 1);
  assert.deepEqual(DESKTOP_TOOLS, ['list_threads', 'read_thread', 'wait_threads', 'send_message_to_thread', 'get_usage_limits', 'list_projects', 'create_thread']);
  await desktop.call('get_usage_limits', {}, 'usage-fixture');
  assert.deepEqual(calls.at(-1).params, { namespace: 'codex_app', tool: 'get_usage_limits', arguments: {}, callerSource: 'codex', hostId: 'local', threadId: 'controller-not-target', turnId: 'mcp-turn-codex-phone-user', callId: 'mcp-call-usage-fixture' });
  for (const name of ['consume_usage_reset', 'get_account', 'account/rateLimits/read', 'thread/start', 'thread/resume', 'interrupt', 'approve', 'exec']) await rejects(desktop.call(name, {}), 'TOOL_NOT_ALLOWED');
  await rejects(desktop.request('thread/resume', {}), 'METHOD_NOT_ALLOWED');
});
test('fresh metadata is shared in flight, replaces cached choices, and optional call pairs cannot bypass native advertisement or final wire authorization', async t => {
  let rows = [{ id: 'fixture-current', efforts: ['high', 'low'] }];
  const f = transport(t, { respond: (msg, result) => msg.method === 'tools/list' ? { tools: [modelTool('create_thread', rows), modelTool('send_message_to_thread', rows)] } : result });
  await f.desktop.tools();
  await f.desktop.call('send_message_to_thread', { threadId: 'fixture', prompt: '합성', model: 'fixture-current', thinking: 'high' });
  assert.equal(f.calls.at(-1).params.arguments.thinking, 'high');
  rows = [{ id: 'fixture-new', efforts: ['low'] }];
  await Promise.all([f.desktop.tools({ refresh: true }), f.desktop.tools({ refresh: true })]);
  assert.equal(f.calls.filter(c => c.method === 'tools/list').length, 2);
  const before = f.calls.filter(c => c.method === 'tools/call').length;
  for (const choice of [{ model: 'fixture-current' }, { model: 'fixture-new', thinking: 'high' }, { thinking: 'low' }, { model: null }]) await rejects(f.desktop.call('create_thread', { prompt: '합성', ...choice }), choice.model === null || !choice.model ? 'INVALID_MODEL_CHOICE' : 'MODEL_CHOICE_UNAVAILABLE');
  await rejects(f.desktop.call('create_thread', { prompt: '합성', model: 'fixture-new' }, 'auth-fixture', () => { throw new BridgeError('AUTH_REQUIRED', 401); }), 'AUTH_REQUIRED');
  assert.equal(f.calls.filter(c => c.method === 'tools/call').length, before);
  await f.desktop.call('create_thread', { prompt: '합성', model: 'fixture-new' }); assert.equal('thinking' in f.calls.at(-1).params.arguments, false);
});
test('disconnect rejects pending without automatic replay; reconnect rediscovers and invalidates catalog', async t => {
  let fail = true;
  const { desktop, calls, paths } = transport(t, { respond: (msg, result, socket) => {
    if (msg.method === 'tools/call' && fail) { fail = false; queueMicrotask(() => socket.emit('error', new Error('private raw detail'))); return undefined; }
    return result;
  } });
  await rejects(desktop.call('send_message_to_thread', { threadId: 'existing' }), 'DESKTOP_DISCONNECTED');
  assert.equal(calls.filter(c => c.method === 'tools/call').length, 1);
  await desktop.call('read_thread', { threadId: 'existing' });
  assert.deepEqual(paths, ['test-pipe-1', 'test-pipe-2']); assert.equal(calls.filter(c => c.method === 'tools/list').length, 2);
});
test('timeouts are bounded and unsupported catalog tool fails before tools/call', async t => {
  const f = transport(t, { timeoutMs: 40, respond: (msg, result) => msg.method === 'tools/call' ? undefined : result });
  await rejects(f.desktop.call('read_thread', { threadId: 'existing' }), 'DESKTOP_TIMEOUT'); assert.equal(f.desktop.pending.size, 0);
  const other = transport(t, { respond: () => ({ tools: [] }) });
  await rejects(other.desktop.call('send_message_to_thread', {}), 'DESKTOP_TOOL_UNSUPPORTED'); assert.equal(other.calls.length, 1);
  await rejects(other.desktop.call('get_usage_limits', {}), 'DESKTOP_TOOL_UNSUPPORTED'); assert.equal(other.calls.length, 1);
  const wrongNamespace = transport(t, { respond: () => ({ tools: [{ name: 'get_usage_limits', namespace: 'other' }] }) });
  await rejects(wrongNamespace.desktop.call('get_usage_limits', {}), 'DESKTOP_TOOL_UNSUPPORTED'); assert.equal(wrongNamespace.calls.length, 1);
});
