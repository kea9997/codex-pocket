import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { Files, FILE_LIMITS, attachmentName } from '../server/files.mjs';
import { markdownImages } from '../server/media.mjs';
import { item } from '../server/engine.mjs';
import { createBridge } from '../server/http.mjs';
import { ORIGIN } from '../server/security.mjs';
import { imageFixture } from './media-fixture.mjs';
import { fixture, httpCall, waitFor } from './helpers.mjs';
const owner = { id: 'owner' }, token = value => value.url.split('/').at(-1);
const pdf = Buffer.from('%PDF-1.7\nsynthetic fixture\n%%EOF\n');
function archive(names) {
  const entries = [], directory = []; let offset = 0;
  for (const name of names) {
    const bytes = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(1, 18); local.writeUInt32LE(1, 22); local.writeUInt16LE(bytes.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(1, 20); central.writeUInt32LE(1, 24); central.writeUInt16LE(bytes.length, 28); central.writeUInt32LE(offset, 42);
    const entry = Buffer.concat([local, bytes, Buffer.from('x')]); entries.push(entry); directory.push(central, bytes); offset += entry.length;
  }
  const bytes = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(bytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, bytes, end]);
}
test('only visible assistant local Markdown refs register downloads, including spaces and narrow drive prefix; never tools/user/plan/reasoning/code or remote URLs', () => {
  const text = '[PDF](</D:/results with spaces/result.pdf>) [ZIP](D:/results with spaces/result.zip) ![사진](D:/results/photo.png)\n```\n[APK](D:/bad.apk)\n```\n`[inline](D:/bad.zip)` [remote](https://invalid/a.pdf) [data](data:fake) [relative](a.pdf)';
  const refs = markdownImages(text, true); assert.equal(refs.length, 3); assert.equal(refs[1].path, 'D:/results with spaces/result.zip');
  const paths = [], resolve = path => { paths.push(path); return { state: 'ready' }; };
  assert.equal(item({ type: 'agentMessage', text }, 0, undefined, resolve).files.length, 3);
  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'userMessage', 'plan']) item({ type, text, content: [{ type: 'text', text }] }, 0, undefined, resolve);
  item({ type: 'reasoning', get text() { throw 0; } }, 0, undefined, resolve); assert.equal(paths.length, 3);
  const viewed = item({ type: 'imageView', path: 'D:/results/photo.png' }, 0, undefined, resolve);
  assert.equal(viewed.files.length, 1); assert.equal(paths.at(-1), 'D:/results/photo.png');
});
test('file registry extends types but preserves path/link/owner/TTL/count protections and image cap; MIME/signature mismatches fail closed', t => {
  const { dir, file: image } = imageFixture(t); let now = 1; const files = new Files({ now: () => now, ttl: 100 });
  for (const [name, bytes, mime] of [['result.pdf', pdf, 'application/pdf'], ['result.zip', archive(['a.txt']), 'application/zip'], ['result.apk', archive(['AndroidManifest.xml', 'classes.dex']), 'application/vnd.android.package-archive'], ['photo.png', fs.readFileSync(image), 'image/png']]) {
    const file = join(dir, name); fs.writeFileSync(file, bytes); const value = files.register(owner, 'thread', file);
    assert.equal(value.state, 'ready'); assert.equal(files.info(owner, token(value)).mime, mime); assert.ok(!JSON.stringify(value).includes(dir));
    assert.throws(() => files.info({ id: 'other' }, token(value)), e => e.status === 404);
  }
  for (const [name, bytes] of [['fake.pdf', Buffer.from('<html>')], ['broken.pdf', Buffer.from('%PDF-1.7 no eof')], ['fake.apk', archive(['a.txt'])], ['fake.zip', Buffer.from('PK not an archive')], ['script.png', Buffer.from('<svg/>')]]) {
    const file = join(dir, name); fs.writeFileSync(file, bytes); const value = files.register(owner, 'thread', file);
    assert.throws(() => files.info(owner, token(value)), e => e.status === 415); assert.ok(!files.entries.has(token(value)));
  }
  for (const name of ['../escape.pdf', 'AppData/result.pdf', '.private/result.pdf', 'secret-key.pdf', 'auth-token.pdf', 'result.html', 'result.svg', 'result.exe']) assert.equal(files.register(owner, 'thread', join(dir, name)).state, 'unavailable');
  const file = join(dir, 'result.pdf'), hard = join(dir, 'hard.pdf'); fs.linkSync(file, hard); assert.equal(files.register(owner, 'other', hard).error, 'MEDIA_PATH_BLOCKED'); fs.unlinkSync(hard);
  const link = join(dir, 'linked'); fs.symlinkSync(dir, link, 'junction'); assert.equal(files.register(owner, 'other', join(link, 'result.pdf')).error, 'MEDIA_PATH_BLOCKED');
  const huge = join(dir, 'huge.pdf'); fs.writeFileSync(huge, 'x'); fs.truncateSync(huge, FILE_LIMITS.pdf + 1); assert.equal(files.register(owner, 'thread', huge).error, 'MEDIA_TOO_LARGE');
  now += 101; files.prune(); assert.equal(files.entries.size, 0);
  for (let n = 0; n < 140; n++) files.register(owner, String(n), file); assert.equal(files.entries.size, 128); files.revoke(owner); assert.equal(files.entries.size, 0);
});
test('bounded ZIP structure rejects traversal, encryption, false central/local offset and missing APK entries without extraction', t => {
  const { dir } = imageFixture(t);
  const cases = [archive(['../escape']), archive(['C:/escape']), archive(['\\escape']), archive(['safe'])];
  cases[3].writeUInt16LE(1, 6); // Local header differs from the central directory.
  for (let n = 0; n < cases.length; n++) {
    const file = join(dir, `bad-${n}.zip`); fs.writeFileSync(file, cases[n]); const files = new Files(), value = files.register(owner, 't', file);
    assert.throws(() => files.info(owner, token(value)), e => e.code === 'FILE_SIGNATURE_INVALID');
  }
  assert.ok(!attachmentName('한글\r\n"evil.pdf').includes('\r')); assert.match(attachmentName('한글.pdf'), /filename\*=UTF-8''/);
});
async function httpFixture(t, size) {
  const f = await fixture(t), { dir } = imageFixture(t), file = join(dir, '실제 결과.pdf'); fs.writeFileSync(file, pdf);
  if (size) { fs.truncateSync(file, size); const fd = fs.openSync(file, 'r+'); try { fs.writeSync(fd, Buffer.from('%%EOF\n'), 0, 6, size - 6); } finally { fs.closeSync(fd); } }
  f.desktop.hook = async (tool, args) => tool === 'read_thread' ? { thread: f.desktop.thread(args.threadId), turns: [{ id: 'result', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: '[결과](<' + file.replaceAll('\\', '/') + '>)' }] }] } : undefined;
  const server = createBridge(f); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, options) => httpCall(server.address().port, path, options), paired = f.auth.pair(JSON.parse(fs.readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1');
  const headers = { Cookie: `codex_phone=${paired.token}` }, page = (await call('/api/threads/thread-fixture/history', { headers })).json;
  return { ...f, file, call, headers, port: server.address().port, session: paired.session, value: page.data[0].items[0].files[0].file };
}
test('authenticated file info/download uses opaque owner handle, revision/If-Match, attachment/nosniff and exact ranges; query/foreign-origin/mutation/logout denied', async t => {
  const f = await httpFixture(t), url = f.value.url;
  assert.equal((await f.call(url)).status, 401);
  const info = await f.call(url + '/info', { headers: f.headers }); assert.equal(info.json.size, pdf.length); assert.match(info.json.revision, /^[a-f0-9]{64}$/); assert.ok(!info.text.includes(f.file));
  const value = await f.call(url, { headers: { ...f.headers, 'If-Match': '"' + info.json.revision + '"' } });
  assert.equal(value.status, 200); assert.deepEqual(value.data, pdf); assert.equal(value.headers['content-type'], 'application/pdf'); assert.match(value.headers['content-disposition'], /^attachment;/); assert.equal(value.headers['x-content-type-options'], 'nosniff');
  assert.equal((await f.call(url, { headers: { ...f.headers, 'If-Match': '"wrong"' } })).status, 412);
  const range = await f.call(url, { headers: { ...f.headers, Range: 'bytes=-6' } }); assert.equal(range.status, 206); assert.deepEqual(range.data, pdf.subarray(-6));
  assert.equal((await f.call(url, { headers: { ...f.headers, Range: 'bytes=-0' } })).status, 416);
  for (const route of [url + '?path=secret', url + '/info?thread=other']) assert.equal((await f.call(route, { headers: f.headers })).status, 400);
  assert.equal((await f.call(url, { headers: { ...f.headers, Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await f.call(url, { method: 'POST', headers: f.headers })).status, 403);
  await f.call('/api/logout', { method: 'POST', headers: { ...f.headers, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Codex-CSRF': f.session.csrf }, data: {} });
  assert.equal(f.engine.files.entries.size, 0); assert.equal((await f.call(url, { headers: f.headers })).status, 401); assert.equal(f.engine.records.length, 0);
});
test('large PDF uses guarded 64KiB streaming, abort closes descriptors, changed file invalidates info and handle', async t => {
  const f = await httpFixture(t, 64 * 1024 * 1024), opened = new Set(); let max = 0, chunk = 0;
  f.engine.files.io = { ...fs, readFileSync() { throw new Error('whole document read'); }, openSync(...a) { const fd = fs.openSync(...a); opened.add(fd); return fd; }, closeSync(fd) { opened.delete(fd); fs.closeSync(fd); }, readSync(fd, b, o, n, p) { max = Math.max(max, n); return fs.readSync(fd, b, o, n, p); }, createReadStream(file, options) { chunk = options.highWaterMark; const stream = fs.createReadStream(file, options); stream.once('close', () => opened.delete(options.fd)); return stream; } };
  const tail = await f.call(f.value.url, { headers: { ...f.headers, Range: 'bytes=-6' } }); assert.equal(tail.status, 206); assert.equal(tail.text, '%%EOF\n');
  await new Promise((resolve, reject) => { const req = request({ host: '127.0.0.1', port: f.port, path: f.value.url, headers: { Host: '100.64.0.10:47831', ...f.headers } }, res => { res.once('data', () => { req.destroy(); res.destroy(); resolve(); }); res.on('error', () => {}); }); req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); }); req.end(); });
  await waitFor(() => opened.size === 0); assert.ok(max <= 1024); assert.equal(chunk, 65536);
  fs.appendFileSync(f.file, 'changed'); const changed = await f.call(f.value.url + '/info', { headers: f.headers }); assert.equal(changed.status, 404); assert.equal(f.engine.files.entries.size, 0); assert.ok(!changed.text.includes(f.file));
});
