import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { body, JSON_BODY_TIMEOUT_MS, ORIGIN } from '../server/security.mjs';
import { createBridge } from '../server/http.mjs';
import { fixture, waitFor } from './helpers.mjs';

function clock() {
  const pending = new Map(); let serial = 0;
  return { pending, setTimeout(fn, ms) { const key = ++serial; pending.set(key, { fn, ms }); return key; }, clearTimeout(key) { pending.delete(key); } };
}
function source() { const req = new PassThrough(); req.headers = { 'content-type': 'application/json' }; return req; }
function cleaned(req, timer) {
  assert.equal(timer.pending.size, 0);
  for (const name of ['data', 'end', 'error', 'aborted', 'close']) assert.equal(req.listenerCount(name), 0, name);
}
test('JSON has a fixed 15s total deadline, not a resettable slow-drip timeout, with reader/timer cleanup', async () => {
  const req = source(), timer = clock(), result = body(req, 128, timer);
  const rejection = assert.rejects(result, e => e.code === 'BODY_TIMEOUT' && e.status === 408);
  const deadline = [...timer.pending.values()][0]; assert.equal(deadline.ms, 15000); assert.equal(JSON_BODY_TIMEOUT_MS, 15000);
  req.write('{'); req.write('"code":'); assert.equal(timer.pending.size, 1); assert.equal([...timer.pending.values()][0], deadline);
  deadline.fn(); await rejection; assert.equal(req.isPaused(), true); cleaned(req, timer); req.destroy();
});
test('JSON success, invalid JSON, size and interruptions remove all owned listeners/timers', async () => {
  for (const mode of ['ok', 'invalid', 'oversize', 'aborted', 'close', 'error']) {
    const req = source(), timer = clock(), result = body(req, 4, timer);
    const check = mode === 'ok' ? result.then(value => assert.deepEqual(value, {})) : assert.rejects(result, e => e.code === (mode === 'oversize' ? 'BODY_TOO_LARGE' : mode === 'invalid' ? 'INVALID_JSON' : 'BODY_INTERRUPTED'));
    if (mode === 'ok') req.end('{}'); else if (mode === 'invalid') req.end('[]'); else if (mode === 'oversize') req.write('12345'); else req.emit(mode, new Error('fixture interruption'));
    await check; cleaned(req, timer); req.destroy();
  }
  for (const headers of [{ 'content-type': 'text/plain' }, { 'content-encoding': 'gzip' }, { 'content-length': '999' }]) {
    const req = source(), timer = clock(); Object.assign(req.headers, headers); await assert.rejects(body(req, 4, timer)); cleaned(req, timer); req.destroy();
  }
});
test('authenticated raw upload never installs the JSON 15s timer and completes under the unchanged 120s server limit', async t => {
  const f = await fixture(t), timer = clock(), server = createBridge({ ...f, bodyClock: timer });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1'); let outgoing;
  const response = new Promise((resolve, reject) => {
    outgoing = request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/uploads', method: 'POST', headers: {
      Host: '100.64.0.10:47831', Origin: ORIGIN, Cookie: `codex_phone=${paired.token}`, 'X-Codex-CSRF': paired.session.csrf,
      'Content-Type': 'text/plain', 'Content-Length': '5', 'X-Upload-Name': 'fixture.txt'
    } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }); outgoing.on('error', reject); outgoing.write('he');
  });
  await waitFor(() => f.engine.uploads.active.size === 1); assert.equal(timer.pending.size, 0); assert.equal(server.requestTimeout, 120000);
  outgoing.end('llo'); assert.equal(await response, 200); assert.equal(timer.pending.size, 0); assert.equal(f.engine.uploads.active.size, 0); assert.equal(f.desktop.calls.length, 0);
});
test('real HTTP keeps upload120s/header10s while JSON/pair408 and unauthenticated unread bodies close promptly without native dispatch', async t => {
  const f = await fixture(t), timer = clock(), server = createBridge({ ...f, bodyClock: timer });
  assert.equal(server.requestTimeout, 120000); assert.equal(server.headersTimeout, 10000);
  await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1');
  for (const path of ['/api/pair', '/api/send', '/api/uploads', '/']) {
    let incoming, closed = false;
    const response = new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, method: path === '/' ? 'GET' : 'POST', path,
        headers: { Host: '100.64.0.10:47831', Origin: ORIGIN, 'Content-Type': 'application/json', 'Content-Length': '100', ...(path === '/api/send' ? { Cookie: `codex_phone=${paired.token}`, 'X-Codex-CSRF': paired.session.csrf } : {}) } }, res => {
        const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, data: JSON.parse(Buffer.concat(chunks)) }));
      });
      req.on('error', reject); req.on('close', () => { closed = true; }); req.write('{');
    });
    server.once('request', req => { incoming = req; });
    await waitFor(() => incoming);
    if (['/api/pair', '/api/send'].includes(path)) { assert.equal(timer.pending.size, 1); [...timer.pending.values()][0].fn(); }
    const result = await response; assert.equal(result.status, path === '/' ? 400 : path === '/api/uploads' ? 401 : 408); assert.equal(result.connection, 'close');
    assert.equal(result.data.error, path === '/' ? 'BODY_REJECTED' : path === '/api/uploads' ? 'AUTH_REQUIRED' : 'BODY_TIMEOUT'); await waitFor(() => incoming.destroyed && closed);
    assert.equal(timer.pending.size, 0); assert.equal(f.engine.uploads.active.size, 0);
  }
  assert.equal(f.desktop.calls.length, 0);
});
