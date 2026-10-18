import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { imageFixture } from './media-fixture.mjs';
import { Media, imagePath, imageMime, markdownImages, MAX_IMAGE_BYTES } from '../server/media.mjs';
import { item } from '../server/engine.mjs';
import { sampleImage } from '../tools/sample-image.mjs';

const session = { id: 'own' }, token = media => media.url.split('/').pop();
const root = process.platform === 'win32' ? 'D:/images/' : '/images/';

test('Markdown image offsets support angle brackets/spaces but never fenced/inline/escaped code', () => {
  const value = '앞 ![무대](<D:/project with spaces/frame.png>) 뒤\n\n```md\n![코드](D:/bad.png)\n```\n~~~md\n![다른 코드](D:/bad.png)\n~~~\n`![인라인](D:/bad.png)` \\![escaped](D:/bad.png)\n![영화](D:/movie.mp4)';
  const images = markdownImages(value);
  assert.equal(images.length, 2); assert.equal(images[0].path, 'D:/project with spaces/frame.png');
  assert.equal(value.slice(images[0].start, images[0].end), '![무대](<D:/project with spaces/frame.png>)');
  assert.equal(images[1].path, 'D:/movie.mp4');
  assert.equal(markdownImages('```\n![unclosed](D:/bad.png)').length, 0);
  assert.equal(markdownImages('![x](D:/a.png) '.repeat(100)).length, 64);
});
test('known imageView/localImage/user image shapes and agent Markdown; reasoning never inspected', () => {
  const references = [], resolve = (path, alt) => { references.push(path); return { state: 'ready', url: '/api/media/' + 'a'.repeat(43), alt }; };
  const poison = { type: 'reasoning', get path() { throw new Error(); }, get text() { throw new Error(); }, get content() { throw new Error(); } };
  assert.equal(item(poison, 0, resolve), null);
  assert.equal(item({ type: 'imageView', path: root + 'view.png' }, 0, resolve).media.state, 'ready');
  const user = item({ type: 'userMessage', content: [{ type: 'text', text: '첨부 확인' }, { type: 'localImage', path: root + 'user.png' }, { type: 'image', url: 'https://invalid/image.png' }, { type: 'image', fileId: 'not-a-path', get path() { throw new Error(); } }] }, 0, resolve);
  assert.equal(user.images.length, 3); assert.equal(user.images[1].state, 'unavailable');
  const agent = item({ type: 'agentMessage', text: '![x](<D:/space here/a.png>)' }, 0, resolve);
  assert.equal(agent.images[0].start, 0); assert.equal(agent.images[0].media.state, 'ready');
  assert.deepEqual(references, [root + 'view.png', root + 'user.png', 'D:/space here/a.png']);
});
test('lexical path policy rejects traversal, UNC/device, URLs, secrets/config and unsupported media before touching disk', () => {
  const media = new Media({ io: { lstatSync() { throw new Error('must not inspect'); } } });
  for (const value of ['../x.png', '\\\\server\\x.png', '\\\\?\\D:\\x.png', '//server/x.png', 'file:///D:/x.png', 'https://invalid/x.png', 'data:image/png,x', root + '../x.png', root + 'sub//x.png', root + 'a.png:stream', root + 'NUL.png', root + '.env/x.png', root + 'AppData/x.png', root + 'CodexPhoneData/x.png', root + 'config/x.png', root + 'api_key.png', root + 'id_rsa.png', root + 'credentials.png', root + 'session-token.png', root + 'x%2e.png', root + 'x./y.png']) {
    assert.throws(() => imagePath(value), e => e.code === 'MEDIA_PATH_BLOCKED', value);
    assert.equal(media.register(session, 'thread', value).error, 'MEDIA_PATH_BLOCKED');
  }
  for (const ext of ['svg', 'html', 'webm', 'exe']) assert.equal(media.register(session, 'thread', root + 'frame.' + ext).error, 'MEDIA_TYPE_UNSUPPORTED');
  assert.ok(imagePath(root + 'frame with spaces.PNG'));
});
test('media handles are opaque, session-bound, only referenced/registered, expiring and revoked', t => {
  const { file } = imageFixture(t); let now = 1; const media = new Media({ now: () => now, ttl: 10 });
  const publicImage = media.register(session, 'thread', file, '무대');
  assert.equal(publicImage.state, 'ready'); assert.match(publicImage.url, /^\/api\/media\/[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(publicImage).includes(file));
  assert.deepEqual(media.register(session, 'thread', file, '무대'), publicImage);
  assert.equal(media.load(session, token(publicImage)).mime, 'image/png');
  assert.throws(() => media.load({ id: 'other' }, token(publicImage)), e => e.code === 'MEDIA_NOT_FOUND');
  assert.throws(() => media.load(session, 'a'.repeat(43)), e => e.code === 'MEDIA_NOT_FOUND');
  now = 12; assert.throws(() => media.load(session, token(publicImage)), e => e.code === 'MEDIA_NOT_FOUND');
  const renewed = media.register(session, 'thread', file); assert.notEqual(renewed.url, publicImage.url);
  media.revoke(session); assert.equal(media.entries.size, 0); assert.equal(media.keys.size, 0);
});
test('registry has global and per-session bounds; anonymous registration inspects nothing', t => {
  const { file } = imageFixture(t); const media = new Media({ limit: 3 });
  assert.equal(media.register(null, 'thread', file).state, 'unavailable'); assert.equal(media.entries.size, 0);
  const first = media.register(session, 'first', file);
  for (let n = 0; n < 10; n++) media.register(session, String(n), file);
  assert.equal(media.entries.size, 3); assert.equal(media.keys.size, 3);
  assert.throws(() => media.load(session, token(first)), e => e.code === 'MEDIA_NOT_FOUND');
  const own = new Media(); for (let n = 0; n < 140; n++) own.register(session, String(n), file);
  assert.equal(own.entries.size, 128);
});
test('missing/oversize/directory, symlink/junction, hardlink and canonical redirects fail closed', t => {
  const { dir, file } = imageFixture(t), media = new Media();
  assert.equal(media.register(session, 'thread', join(dir, 'missing.png')).error, 'MEDIA_MISSING');
  const huge = join(dir, 'huge.png'); const fd = fs.openSync(huge, 'w'); fs.ftruncateSync(fd, MAX_IMAGE_BYTES + 1); fs.closeSync(fd);
  assert.equal(media.register(session, 'thread', huge).error, 'MEDIA_TOO_LARGE');
  const directory = join(dir, 'folder.png'); fs.mkdirSync(directory); assert.equal(media.register(session, 'thread', directory).error, 'MEDIA_PATH_BLOCKED');
  const link = join(dir, 'linked'); fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(media.register(session, 'thread', join(link, 'sample with spaces.png')).error, 'MEDIA_PATH_BLOCKED');
  const hard = join(dir, 'hard.png'); fs.linkSync(file, hard); assert.equal(media.register(session, 'thread', hard).error, 'MEDIA_PATH_BLOCKED');
  const redirected = new Media({ io: { ...fs, realpathSync: value => value + '-redirect' } });
  assert.equal(redirected.register(session, 'thread', file).error, 'MEDIA_PATH_BLOCKED');
});
test('snapshot prevents replacement and mid-open/path swaps; no bytes returned and handles removed', t => {
  const { dir, file } = imageFixture(t), media = new Media(); const handle = media.register(session, 'thread', file);
  fs.renameSync(file, join(dir, 'before.png')); fs.writeFileSync(file, sampleImage());
  assert.throws(() => media.load(session, token(handle)), e => e.code === 'MEDIA_CHANGED'); assert.equal(media.entries.size, 0);
  let closed = false;
  const swapped = new Media({ io: { ...fs, openSync(value, flags) { const result = fs.openSync(value, flags); fs.renameSync(value, join(dir, 'during.png')); fs.writeFileSync(value, sampleImage()); return result; }, closeSync(fd) { closed = true; fs.closeSync(fd); } } });
  const next = swapped.register(session, 'thread', file);
  assert.throws(() => swapped.load(session, token(next)), e => e.code === 'MEDIA_CHANGED'); assert.equal(closed, true);
});
test('raster signature must match allowlisted extension; HTML/SVG renamed as PNG cannot be served', t => {
  const { file } = imageFixture(t), media = new Media();
  assert.equal(imageMime(sampleImage(), '.png'), 'image/png');
  assert.equal(imageMime(Buffer.from('ffd8ff00ffd9', 'hex'), '.jpg'), 'image/jpeg');
  assert.equal(imageMime(Buffer.from('4749463839610100010080000000', 'hex'), '.gif'), 'image/gif');
  const webp = Buffer.alloc(20); webp.write('RIFF'); webp.writeUInt32LE(12, 4); webp.write('WEBPVP8 ', 8); assert.equal(imageMime(webp, '.webp'), 'image/webp');
  for (const data of [Buffer.from('<svg></svg>'), Buffer.from('<html>secret</html>'), Buffer.from('not image')]) {
    fs.writeFileSync(file, data); const h = media.register(session, 'thread', file);
    assert.throws(() => media.load(session, token(h)), e => e.code === 'MEDIA_SIGNATURE_INVALID');
  }
  assert.throws(() => imageMime(sampleImage(), '.jpg'), e => e.code === 'MEDIA_SIGNATURE_INVALID');
  assert.throws(() => imageMime(webp.subarray(0, 19), '.webp'), e => e.code === 'MEDIA_SIGNATURE_INVALID');
});
