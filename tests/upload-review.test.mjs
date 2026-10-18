import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync, writeFileSync, linkSync, unlinkSync, renameSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Uploads, UPLOAD_LIMITS } from '../server/uploads.mjs';
import { Media, MAX_IMAGE_BYTES, imagePath } from '../server/media.mjs';
// Public prompts preserve operator input without injecting a private workflow.
import { createBridge } from '../server/http.mjs';
import { ORIGIN } from '../server/security.mjs';
import { fixture, temp, httpCall } from './helpers.mjs';
import { installOptions } from './options-fixture.mjs';
const owner = { id: 'a'.repeat(64) }, foreign = { id: 'b'.repeat(64) };
const attached = r => ({ handle: r.handle, sha256: r.sha256, size: r.size });
const png = () => { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(b); b.write('IHDR', 12); return b; };
function stage(uploads, session = owner, bytes = png(), name = '선택.png', mime = 'image/png') {
  const req = Readable.from([bytes]); req.headers = { 'content-length': String(bytes.length), 'content-type': mime, 'x-upload-name': encodeURIComponent(name) };
  return uploads.receive(session, req, () => {});
}
async function served(t, f) {
  const server = createBridge(f); await new Promise(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1');
  const headers = { Cookie: `codex_phone=${paired.token}`, Origin: ORIGIN, 'X-Codex-CSRF': paired.session.csrf, 'Content-Type': 'application/json' };
  return { session: paired.session, headers, call: (path, opts = {}) => httpCall(server.address().port, path, { headers, ...opts }) };
}
test('pre-dispatch model/create-target rejections release attachment cancellation over HTTP; no native writes', async t => {
  const f = await fixture(t); installOptions(f.desktop); const h = await served(t, f);
  for (const kind of ['send', 'create']) {
    const r = await stage(f.engine.uploads, h.session), data = { requestId: randomUUID(), text: '모의 요청', attachments: [attached(r)], ...(kind === 'send' ? { threadId: 'thread-fixture', model: 'invalid-model' } : { target: { type: 'project', projectId: 'missing-project' } }) };
    const response = await h.call(`/api/${kind}`, { method: 'POST', data }); assert.notEqual(response.status, 200);
    assert.equal(f.engine.records.at(-1).state, 'rejected');
    const removed = await h.call(`/api/uploads/${r.handle}/cancel`, { method: 'POST', data: {} }); assert.equal(removed.status, 200); assert.equal(existsSync(f.engine.uploads.path(r.handle, 'png')), false);
  }
  assert.ok(!f.desktop.calls.some(c => ['create_thread', 'send_message_to_thread'].includes(c.tool)));
});
test('rejected-only staging expires and cleans across restart, but any protected reference still pins bytes', async t => {
  let now = Date.now(); const dir = temp(t), records = [], uploads = new Uploads(dir, () => records, { now: () => now });
  const rejected = await stage(uploads); records.push({ state: 'rejected', attachments: [attached(rejected)] });
  const protectedRows = [];
  for (const state of ['reserved', 'active', 'pending', 'uncertain', 'delivered', 'acknowledged']) {
    const r = await stage(uploads); records.push({ state, attachments: [attached(r)] }, { state: 'rejected', attachments: [attached(r)] }); protectedRows.push(r);
    assert.throws(() => uploads.cancel(owner, r.handle), /UPLOAD_IN_USE/);
  }
  now += 2 * UPLOAD_LIMITS.stagingMs; assert.throws(() => uploads.select(owner, [attached(rejected)]), /UPLOAD_EXPIRED/);
  const restarted = new Uploads(dir, () => records, { now: () => now }); assert.equal(restarted.rows.length, 6); assert.equal(existsSync(restarted.path(rejected.handle, 'png')), false);
  for (const r of protectedRows) { assert.throws(() => restarted.cancel(owner, r.handle), /UPLOAD_IN_USE/); assert.ok(existsSync(restarted.path(r.handle, 'png'))); }
});
test('real filesystem own immutable upload imageView produces only an opaque authenticated media URL; foreign, changed and private paths stay blocked', async t => {
  const f = await fixture(t); f.engine.uploads = new Uploads(join(f.dir, 'CodexPhoneData'), () => f.engine.records); const h = await served(t, f);
  const r = await stage(f.engine.uploads, h.session), p = f.engine.uploads.path(r.handle, 'png');
  assert.throws(() => imagePath(p), /MEDIA_PATH_BLOCKED/);
  f.desktop.hook = (tool, args) => tool === 'read_thread' ? { thread: f.desktop.thread(args.threadId), turns: [{ id: 'image-turn', items: [{ type: 'imageView', path: p }] }] } : undefined;
  const history = await h.call('/api/threads/thread-fixture/history'); const image = history.json.data[0].items[0].media;
  assert.equal(image.state, 'ready'); assert.match(image.url, /^\/api\/media\/[A-Za-z0-9_-]{43}$/); assert.ok(!JSON.stringify(history.json).includes(p));
  const bytes = await h.call(image.url); assert.equal(bytes.status, 200); assert.equal(bytes.headers['content-type'], 'image/png'); assert.deepEqual(bytes.data, png());
  const token = image.url.split('/').at(-1); assert.throws(() => f.engine.media.load(foreign, token), /MEDIA_NOT_FOUND/);
  assert.equal(f.engine.media.register(foreign, 'thread-fixture', p).state, 'unavailable');
  const unknown = join(f.engine.uploads.root, 'z'.repeat(43) + '.png'); writeFileSync(unknown, png()); assert.equal(f.engine.media.register(h.session, 'thread-fixture', unknown).state, 'unavailable');
  const credential = join(f.dir, 'credentials.png'); writeFileSync(credential, png()); assert.equal(f.engine.media.register(h.session, 'thread-fixture', credential).error, 'MEDIA_PATH_BLOCKED');
  const secret = join(f.dir, 'CodexPhoneData', 'token.png'); writeFileSync(secret, png()); assert.equal(f.engine.media.register(h.session, 'thread-fixture', secret).error, 'MEDIA_PATH_BLOCKED');
  for (const alias of [p.replaceAll('\\', '/').replace('/uploads/', '/uploads/../uploads/'), p.replaceAll('\\', '/') + ':stream']) assert.equal(f.engine.media.register(h.session, 'thread-fixture', alias).state, 'unavailable');
  const changed = png(); changed[32] = 1; writeFileSync(p, changed); assert.equal((await h.call(image.url)).status, 409); assert.equal(f.engine.media.register(h.session, 'thread-fixture', p).state, 'unavailable');
  assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread'));
});
test('upload preview keeps 16MiB limit, signature/link/root/expiry/manifest/revocation guards and never broadens ordinary Media', async t => {
  let now = Date.now(); const uploads = new Uploads(join(temp(t), 'CodexPhoneData'), () => [], { now: () => now });
  const media = new Media({ ownedUpload: (session, raw) => uploads.mediaSource(session, raw) });
  const register = r => media.register(owner, 'thread', uploads.path(r.handle, 'png'));
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1); png().copy(oversized); const big = await stage(uploads, owner, oversized); assert.ok(big.size <= UPLOAD_LIMITS.file); assert.equal(register(big).error, 'MEDIA_TOO_LARGE');
  const weak = await stage(uploads, owner, png().subarray(0, 9)), weakView = register(weak); assert.throws(() => media.load(owner, weakView.url.split('/').at(-1)), /MEDIA_SIGNATURE_INVALID/);
  const linked = await stage(uploads), lp = uploads.path(linked.handle, 'png'); linkSync(lp, lp + '.link'); assert.equal(register(linked).state, 'unavailable'); unlinkSync(lp + '.link');
  const r = await stage(uploads), view = register(r), token = view.url.split('/').at(-1); assert.equal(new Media().register(owner, 'thread', uploads.path(r.handle, 'png')).error, 'MEDIA_PATH_BLOCKED');
  media.revoke(owner); assert.throws(() => media.load(owner, token), /MEDIA_NOT_FOUND/);
  const removed = register(r); uploads.cancel(owner, r.handle); assert.throws(() => media.load(owner, removed.url.split('/').at(-1)), /MEDIA_PATH_BLOCKED/);
  const reowned = await stage(uploads), ownView = register(reowned); uploads.rows.find(row => row.handle === reowned.handle).owner = foreign.id;
  assert.throws(() => media.load(owner, ownView.url.split('/').at(-1)), /MEDIA_PATH_BLOCKED/);
  const expired = await stage(uploads), expView = register(expired); now += 2 * UPLOAD_LIMITS.stagingMs; assert.throws(() => media.load(owner, expView.url.split('/').at(-1)), /UPLOAD_EXPIRED/);
  const redirected = new Uploads(temp(t), () => []), rr = await stage(redirected), rm = new Media({ ownedUpload: (s, p) => redirected.mediaSource(s, p) }), rv = rm.register(owner, 'thread', redirected.path(rr.handle, 'png'));
  const target = temp(t); renameSync(redirected.root, redirected.root + '-old'); symlinkSync(target, redirected.root, process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => rm.load(owner, rv.url.split('/').at(-1)), /UPLOAD_STORAGE_UNSAFE/);
});
test('only complete trusted same-owner/thread hash-bound attachment requests hide internal wrapper; truncation/foreign/forgery never infer text', async t => {
  const f = await fixture(t); f.desktop.controllerId = 'controller-fixture'; const r = await stage(f.engine.uploads); const text = '사진을 확인해 주세요.';
  await f.engine.send(owner, { threadId: 'thread-fixture', requestId: randomUUID(), text, attachments: [attached(r)] });
  const prompt = f.desktop.calls.find(c => c.tool === 'send_message_to_thread').args.prompt;
  const frame = `<codex_delegation><source_thread_id>controller-fixture</source_thread_id><input>${prompt}</input></codex_delegation>`;
  assert.ok(frame.length <= 1500); let payload = frame, truncated = false;
  f.desktop.hook = (tool, args) => tool === 'read_thread' ? { thread: f.desktop.thread(args.threadId), turns: [{ id: 'request-turn', items: [{ type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: { text: payload, truncated } }] }] } : undefined;
  const item = async (session = owner, thread = 'thread-fixture') => (await f.engine.history(thread, undefined, session)).data[0].items[0];
  assert.equal((await item()).text, `${text}\n\n첨부 1개 · PC에 전송한 파일`); assert.equal((await item()).requestState, 'complete');
  assert.match((await item(foreign)).text, /SHA256/); assert.match((await item(owner, 'other-thread')).text, /SHA256/);
  truncated = true; assert.equal((await item()).type, 'requestNotice'); assert.match((await item()).text, /잘려/);
  truncated = false; payload = frame.replace(text, '다른 요청'); assert.match((await item()).text, /SHA256/);
  payload = frame; const savedHash = f.engine.records[0].uploadPromptHash; delete f.engine.records[0].uploadPromptHash; assert.match((await item()).text, /SHA256/);
  f.engine.records[0].uploadPromptHash = savedHash; writeFileSync(f.engine.uploads.path(r.handle, 'png'), 'changed image'); assert.match((await item()).text, /SHA256/);
  assert.ok(prompt.startsWith(text + '\n\n'));
  const disk = readFileSync(f.engine.journalPath, 'utf8'); assert.ok(!disk.includes(text)); assert.ok(!disk.includes(f.engine.uploads.root));
});
