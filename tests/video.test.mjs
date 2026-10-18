import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { sampleVideo } from '../tools/sample-video.mjs';
import { Media, imagePath, markdownImages } from '../server/media.mjs';
import { MAX_VIDEO_BYTES, validateMp4, videoRange } from '../server/video.mjs';
import { imageFixture } from './media-fixture.mjs';
import { waitFor } from './helpers.mjs';

const session = { id: 'own' }, token = value => value.url.split('/').pop();
function videoFixture(t) { const { dir } = imageFixture(t), file = join(dir, 'sample video.mp4'); fs.writeFileSync(file, sampleVideo()); return { dir, file }; }

test('local MP4 Markdown covers image/ordinary links, spaces and narrow /D:/ normalization; code/remote links not embedded', () => {
  const value = '![전환](<D:/space here/a.mp4>) [완곡](</D:/space here/b.mp4>) [원격](https://example.invalid/movie.mp4)\n`[코드](D:/code.mp4)`\n~~~md\n![코드](D:/code.mp4)\n~~~';
  const refs = markdownImages(value); assert.equal(refs.length, 2);
  assert.equal(refs[1].path, '/D:/space here/b.mp4'); assert.equal(value.slice(refs[1].start, refs[1].end), '[완곡](</D:/space here/b.mp4>)');
  if (process.platform === 'win32') assert.equal(imagePath('/D:/space here/b.mp4'), imagePath('D:/space here/b.mp4'));
  for (const file of ['/D:/../a.mp4', '//D:/x.mp4', '/D://x.mp4', '/D:/config/a.mp4', '\\\\host\\a.mp4', 'file:///D:/a.mp4']) assert.throws(() => imagePath(file), e => e.code === 'MEDIA_PATH_BLOCKED');
});
test('closed/open/suffix byte ranges clamp correctly; invalid, multiple and unsafe ranges are 416', () => {
  assert.deepEqual(videoRange(undefined, 100), { status: 200, start: 0, end: 99 });
  for (const [value, start, end] of [['bytes=10-19', 10, 19], ['bytes=98-200', 98, 99], ['bytes=40-', 40, 99], ['bytes=-10', 90, 99], ['bytes=-200', 0, 99]]) assert.deepEqual(videoRange(value, 100), { status: 206, start, end });
  for (const value of ['', 'items=1-2', 'bytes=0-1,4-5', 'bytes=-0', 'bytes=-', 'bytes=100-', 'bytes=5-4', 'bytes=9007199254740992-', 'bytes=0-NaN']) assert.throws(() => videoRange(value, 100), e => e.code === 'MEDIA_RANGE_INVALID' && e.status === 416);
});
test('MP4 box validation is bounded and rejects renamed HTML, truncation, fake brands, missing boxes and malformed sizes', t => {
  const { file } = videoFixture(t); const original = fs.readFileSync(file);
  const validate = () => { const fd = fs.openSync(file, 'r'); try { validateMp4(fs, fd, fs.fstatSync(fd).size); } finally { fs.closeSync(fd); } };
  validate();
  const badBrand = Buffer.from(original); badBrand.fill(0x78, 8, badBrand.readUInt32BE(0));
  const oversizedBox = Buffer.from(original); oversizedBox.writeUInt32BE(0xffffffff, 0);
  const extended = Buffer.alloc(16); extended.writeUInt32BE(1); extended.write('ftyp', 4); extended.writeBigUInt64BE(BigInt(MAX_VIDEO_BYTES) + 1n, 8);
  for (const data of [Buffer.from('<html>not video</html>'), original.subarray(0, 10), original.subarray(0, original.readUInt32BE(0)), badBrand, oversizedBox, extended]) {
    fs.writeFileSync(file, data); assert.throws(validate, e => e.code === 'MEDIA_SIGNATURE_INVALID');
  }
});
test('video registry preserves session/TTL/revocation/file identity and raster cap; large video never allocates whole file', async t => {
  const { file, dir } = videoFixture(t); let now = 1, maxRead = 0;
  const media = new Media({ now: () => now, ttl: 100, io: { ...fs, readFileSync() { throw new Error('whole-file reads forbidden'); }, readSync(fd, buffer, offset, length, position) { maxRead = Math.max(maxRead, length); return fs.readSync(fd, buffer, offset, length, position); } } });
  // Extend the final mdat, not moov: a sparse, generated 301MiB file needs no large Buffer.
  const bytes = fs.readFileSync(file); let offset = 0, last = 0;
  while (offset < bytes.length) { last = offset; offset += bytes.readUInt32BE(offset); }
  assert.equal(bytes.toString('ascii', last + 4, last + 8), 'mdat');
  const fd = fs.openSync(file, 'r+'); const size = 301 * 1024 * 1024; const header = Buffer.alloc(4); header.writeUInt32BE(size - last); fs.writeSync(fd, header, 0, 4, last); fs.ftruncateSync(fd, size); fs.closeSync(fd);
  const publicVideo = media.register(session, 'thread', file); assert.equal(publicVideo.kind, 'video'); assert.ok(!JSON.stringify(publicVideo).includes(file));
  assert.throws(() => media.openVideo({ id: 'other' }, token(publicVideo)), e => e.code === 'MEDIA_NOT_FOUND');
  assert.throws(() => media.load(session, token(publicVideo)), e => e.code === 'MEDIA_TYPE_UNSUPPORTED');
  const opened = media.openVideo(session, token(publicVideo)); assert.equal(opened.size, size); const stream = opened.stream(size - 64, size - 1);
  let length = 0; for await (const chunk of stream) length += chunk.length;
  assert.equal(length, 64); assert.ok(maxRead <= 4096); assert.equal(media.entries.size, 1);
  const live = media.openVideo(session, token(publicVideo)).stream(0, size - 1); live.on('error', () => {}); live.resume(); media.revoke(session);
  await waitFor(() => live.destroyed); assert.equal(media.entries.size, 0);
  const next = media.register(session, 'thread', file); now = 102; assert.throws(() => media.openVideo(session, token(next)), e => e.code === 'MEDIA_NOT_FOUND');
  const tooLarge = join(dir, 'too-large.mp4'); const huge = fs.openSync(tooLarge, 'w'); fs.ftruncateSync(huge, MAX_VIDEO_BYTES + 1); fs.closeSync(huge);
  assert.equal(media.register(session, 'thread', tooLarge).error, 'MEDIA_TOO_LARGE');
});
test('video source swaps and mid-stream changes fail closed with sanitized errors; abort closes owned descriptor', async t => {
  const { file, dir } = videoFixture(t), openFds = new Set();
  const io = { ...fs, openSync(...args) { const fd = fs.openSync(...args); openFds.add(fd); return fd; }, closeSync(fd) { openFds.delete(fd); fs.closeSync(fd); }, createReadStream(file, options) { const stream = fs.createReadStream(file, options); stream.once('close', () => openFds.delete(options.fd)); return stream; } };
  const media = new Media({ io }), publicVideo = media.register(session, 'thread', file);
  const opened = media.openVideo(session, token(publicVideo)); const stream = opened.stream(0, opened.size - 1); stream.on('error', () => {}); stream.destroy();
  await waitFor(() => openFds.size === 0);
  fs.renameSync(file, join(dir, 'before.mp4')); fs.writeFileSync(file, sampleVideo());
  assert.throws(() => media.openVideo(session, token(publicVideo)), e => e.code === 'MEDIA_CHANGED'); assert.equal(openFds.size, 0);
  const next = media.register(session, 'thread', file), movie = media.openVideo(session, token(next));
  fs.appendFileSync(file, Buffer.from('changed'));
  await assert.rejects(async () => { for await (const _ of movie.stream(0, movie.size - 1)) { /* Consume only generated media. */ } }, e => e.code === 'MEDIA_CHANGED');
  await waitFor(() => openFds.size === 0);
});
