import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { createBridge } from '../server/http.mjs';
import { ORIGIN } from '../server/security.mjs';
import { fixture, httpCall, waitFor } from './helpers.mjs';
import { imageFixture } from './media-fixture.mjs';
import { sampleVideo } from '../tools/sample-video.mjs';

async function setup(t, size) {
  const f = await fixture(t), { dir } = imageFixture(t), file = join(dir, 'sample.mp4');
  fs.writeFileSync(file, sampleVideo());
  if (size) {
    const bytes = fs.readFileSync(file); let offset = 0, last = 0;
    while (offset < bytes.length) { last = offset; offset += bytes.readUInt32BE(offset); }
    assert.equal(bytes.toString('ascii', last + 4, last + 8), 'mdat');
    const fd = fs.openSync(file, 'r+'), header = Buffer.alloc(4); header.writeUInt32BE(size - last);
    try { fs.writeSync(fd, header, 0, 4, last); fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
  }
  const server = createBridge(f); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port, call = (path, options) => httpCall(port, path, options);
  const code = JSON.parse(fs.readFileSync(join(f.dir, 'pairing.json'))).code;
  const paired = await call('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: { code } });
  const cookie = paired.headers['set-cookie'][0].split(';')[0], headers = { Cookie: cookie };
  const csrf = (await call('/api/session', { headers })).json.csrf;
  f.desktop.hook = async (tool, args) => tool === 'read_thread' ? { thread: f.desktop.thread(args.threadId), turns: [{ id: 'movie-turn', status: 'completed', items: [{ id: 'video-agent', type: 'agentMessage', text: '![샘플](<' + file.replaceAll('\\', '/') + '>)' }] }] } : undefined;
  const page = await call('/api/threads/thread-fixture/history', { headers });
  const media = page.json.data[0].items[0].images[0].media;
  return { ...f, call, headers, port, csrf, media, file };
}
test('authenticated MP4 200/206 has exact lengths/MIME/ranges; malformed ranges 416, no auth/path/CORS escape', async t => {
  const f = await setup(t), source = fs.readFileSync(f.file), path = f.media.url;
  assert.equal(f.media.kind, 'video'); assert.equal((await f.call(path)).status, 401);
  const result = await f.call(path, { headers: f.headers }); assert.equal(result.status, 200); assert.deepEqual(result.data, source);
  assert.equal(result.headers['content-type'], 'video/mp4'); assert.equal(result.headers['accept-ranges'], 'bytes'); assert.equal(Number(result.headers['content-length']), source.length);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff'); assert.match(result.headers['content-security-policy'], /media-src 'self'/);
  for (const [range, start, end] of [['bytes=4-15', 4, 15], ['bytes=10-', 10, source.length - 1], ['bytes=-16', source.length - 16, source.length - 1]]) {
    const part = await f.call(path, { headers: { ...f.headers, Range: range } });
    assert.equal(part.status, 206); assert.deepEqual(part.data, source.subarray(start, end + 1)); assert.equal(part.headers['content-range'], `bytes ${start}-${end}/${source.length}`);
  }
  for (const Range of ['bytes=0-1,3-4', 'bytes=999999999-', 'bytes=-0']) {
    const invalid = await f.call(path, { headers: { ...f.headers, Range } }); assert.equal(invalid.status, 416); assert.equal(invalid.headers['content-range'], `bytes */${source.length}`);
  }
  assert.equal((await f.call(path + '?path=arbitrary', { headers: f.headers })).status, 400);
  for (const headers of [{ ...f.headers, Host: 'evil.invalid' }, { ...f.headers, Origin: 'https://evil.invalid' }]) assert.equal((await f.call(path, { headers })).status, 403);
  assert.equal((await f.call(path, { method: 'HEAD', headers: f.headers })).status, 405);
  f.auth.issuePairing(); const otherCode = JSON.parse(fs.readFileSync(join(f.dir, 'pairing.json'))).code;
  const other = await f.call('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: { code: otherCode } });
  assert.equal((await f.call(path, { headers: { Cookie: other.headers['set-cookie'][0].split(';')[0] } })).json.error, 'MEDIA_NOT_FOUND');
  assert.equal(result.headers['access-control-allow-origin'], undefined); assert.equal(result.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal((await f.call(path + '/movie.mp4', { headers: f.headers })).status, 404);
  await f.call('/api/logout', { method: 'POST', headers: { ...f.headers, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Codex-CSRF': f.csrf }, data: {} });
  assert.equal((await f.call(path, { headers: f.headers })).status, 401); assert.equal(f.engine.media.entries.size, 0);
  assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread'));
});
test('changed, missing and renamed HTML video fail closed with sanitized HTTP errors and invalidated handles', async t => {
  const f = await setup(t); fs.writeFileSync(f.file, '<html>not an MP4</html>');
  const changed = await f.call(f.media.url, { headers: f.headers }); assert.equal(changed.status, 404); assert.equal(changed.json.error, 'MEDIA_CHANGED');
  const renewed = (await f.call('/api/threads/thread-fixture/history', { headers: f.headers })).json.data[0].items[0].images[0].media;
  assert.notEqual(renewed.url, f.media.url);
  const invalid = await f.call(renewed.url, { headers: f.headers }); assert.equal(invalid.status, 415); assert.equal(invalid.json.error, 'MEDIA_SIGNATURE_INVALID');
  assert.ok(!invalid.text.includes(f.file)); assert.equal(f.engine.media.entries.size, 0);
  fs.writeFileSync(f.file, sampleVideo());
  const next = (await f.call('/api/threads/thread-fixture/history', { headers: f.headers })).json.data[0].items[0].images[0].media;
  fs.unlinkSync(f.file); assert.equal((await f.call(next.url, { headers: f.headers })).json.error, 'MEDIA_MISSING');
});
test('HTTP abort and invalid ranges close file descriptors; large MP4 streams with bounded reads instead of buffering', async t => {
  const size = 301 * 1024 * 1024, f = await setup(t, size), opened = new Set(); let maxHeaderRead = 0, maxChunk = 0;
  f.engine.media.io = { ...fs,
    readFileSync() { throw new Error('whole movie read forbidden'); },
    openSync(...args) { const fd = fs.openSync(...args); opened.add(fd); return fd; },
    closeSync(fd) { opened.delete(fd); fs.closeSync(fd); },
    readSync(fd, b, offset, length, position) { maxHeaderRead = Math.max(maxHeaderRead, length); return fs.readSync(fd, b, offset, length, position); },
    createReadStream(file, options) { maxChunk = options.highWaterMark; const stream = fs.createReadStream(file, options); stream.once('close', () => opened.delete(options.fd)); return stream; }
  };
  assert.equal((await f.call(f.media.url, { headers: { ...f.headers, Range: 'bytes=-0' } })).status, 416); assert.equal(opened.size, 0);
  const tail = await f.call(f.media.url, { headers: { ...f.headers, Range: 'bytes=-64' } });
  assert.equal(tail.status, 206); assert.equal(tail.data.length, 64); assert.equal(tail.headers['content-range'], `bytes ${size - 64}-${size - 1}/${size}`);
  await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: f.port, path: f.media.url, headers: { Host: '100.64.0.10:47831', ...f.headers } }, res => {
      res.once('data', () => { req.destroy(); res.destroy(); resolve(); }); res.on('error', () => {});
    }); req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); }); req.end();
  });
  await waitFor(() => opened.size === 0); assert.ok(maxHeaderRead <= 4096); assert.equal(maxChunk, 64 * 1024);
});
