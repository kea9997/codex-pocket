import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCodexExecutable, CODEX_BIN_ROOT } from '../server/codex-install.mjs';
import { Rpc } from '../server/rpc.mjs';
import { temp } from './helpers.mjs';

const oldHash = 'e78bad9887fa50cf', newHash = '896a0166b774037a';
function installation(t) {
  const base = temp(t), root = join(base, 'bin'); fs.mkdirSync(root);
  const install = (hash = newHash, content = 'synthetic-not-an-executable') => {
    const directory = join(root, hash); fs.mkdirSync(directory, { recursive: true });
    const executable = join(directory, 'codex.exe'); fs.writeFileSync(executable, content); return executable;
  };
  return { base, root, install, resolve: () => resolveCodexExecutable({ root }) };
}
const unavailable = error => error.code === 'CODEX_INSTALL_UNAVAILABLE' && error.message === error.code;

test('fixed same-user install root discovers a unique new hash instead of a vanished cache, and re-resolves replacements', t => {
  assert.equal(CODEX_BIN_ROOT, join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin'));
  const f = installation(t); fs.mkdirSync(join(f.root, oldHash));
  assert.throws(f.resolve, unavailable);
  const current = f.install(); assert.equal(f.resolve(), current);
  fs.unlinkSync(current); const replacement = f.install('0123456789abcdef');
  assert.equal(f.resolve(), replacement);
});
test('no arbitrary root executable, malformed layout or newest-file fallback; ambiguous valid installs fail sanitized', t => {
  const f = installation(t); f.install('not-a-cache-hash'); f.install('ABCDEF0123456789');
  fs.writeFileSync(join(f.root, 'codex.exe'), 'not an installed candidate');
  assert.throws(f.resolve, unavailable);
  f.install(); f.install(oldHash);
  assert.throws(f.resolve, error => error.code === 'CODEX_INSTALL_AMBIGUOUS' && error.message === error.code);
  assert.throws(() => resolveCodexExecutable({ root: join(f.base, 'absent') }), unavailable);
  assert.throws(() => resolveCodexExecutable({ root: 'relative/bin' }), unavailable);
  assert.throws(() => resolveCodexExecutable({ root: f.root + '/../bin' }), unavailable);
});
test('candidate must be a nonempty regular unlinked file, not a directory, hardlink, redirected ancestor or reparse directory', t => {
  for (const kind of ['empty', 'directory', 'hardlink', 'junction', 'ancestor']) {
    const f = installation(t), executable = f.install();
    if (kind === 'empty') fs.writeFileSync(executable, '');
    if (kind === 'directory') { fs.unlinkSync(executable); fs.mkdirSync(executable); }
    if (kind === 'hardlink') fs.linkSync(executable, join(f.base, 'other.exe'));
    if (kind === 'junction') {
      fs.rmSync(join(f.root, newHash), { recursive: true });
      const other = join(f.base, 'other'); fs.mkdirSync(other); fs.writeFileSync(join(other, 'codex.exe'), 'synthetic');
      fs.symlinkSync(other, join(f.root, newHash), 'junction');
    }
    if (kind === 'ancestor') {
      const alias = join(f.base, 'alias'); fs.symlinkSync(f.root, alias, 'junction');
      assert.throws(() => resolveCodexExecutable({ root: alias }), unavailable); continue;
    }
    assert.throws(f.resolve, unavailable, kind);
  }
});
test('canonical file redirects, leaf links, identity changes and excessive install entries fail closed with descriptors released', t => {
  const f = installation(t), executable = f.install(); let opened = 0, closed = 0, originalSize, changedSize;
  const io = { ...fs, openSync(...args) { opened++; return fs.openSync(...args); }, closeSync(fd) { closed++; fs.closeSync(fd); }, fstatSync(fd) {
    const stat = fs.fstatSync(fd);
    // Small fixture sizes change exactly; Windows inode numbers may exceed safe integer precision.
    originalSize = stat.size; stat.size = originalSize + 1; changedSize = stat.size; return stat;
  } };
  assert.throws(() => resolveCodexExecutable({ root: f.root, io }), unavailable); assert.equal(opened, 1); assert.equal(closed, 1);
  assert.ok(Number.isSafeInteger(originalSize) && originalSize > 0 && originalSize < 1024);
  assert.ok(Number.isSafeInteger(changedSize)); assert.notEqual(changedSize, originalSize);
  assert.throws(() => resolveCodexExecutable({ root: f.root, io: { ...fs, realpathSync(target) { return target === executable ? target + '.redirect' : fs.realpathSync(target); } } }), unavailable);
  assert.throws(() => resolveCodexExecutable({ root: f.root, io: { ...fs, lstatSync(target) { const stat = fs.lstatSync(target); if (target === executable) stat.isSymbolicLink = () => true; return stat; } } }), unavailable);
  for (let n = 0; n < 64; n++) fs.writeFileSync(join(f.root, 'ignored-' + n), 'x');
  assert.throws(f.resolve, unavailable);
});
test('default resolver launch path is injectable only internally: real Node child initialization, missing-install retry and replacement restart stay readonly', async t => {
  const f = installation(t), launches = [], children = []; let resolutions = 0;
  const rpc = new Rpc({ resolveExecutable: () => { resolutions++; return f.resolve(); }, timeoutMs: 2000,
    childFactory(executable, args, options) {
      launches.push({ executable, args, options });
      // The candidate is synthetic. Only Node and our readonly fixture are actually executed.
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url)), 'readonly'], options);
      children.push(child); return child;
    } });
  rpc.on('request', message => rpc.reject(message.id));
  t.after(async () => { rpc.close(); await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null : new Promise(done => child.once('exit', done)))); });
  await assert.rejects(rpc.start(), unavailable); assert.equal(launches.length, 0);
  const current = f.install(); const first = rpc.start(), same = rpc.start(); assert.equal(first, same); await first;
  assert.equal(launches[0].executable, current); assert.deepEqual(launches[0].args, ['app-server', '--listen', 'stdio://']); assert.equal(launches[0].options.windowsHide, true);
  assert.equal((await rpc.request('thread/list')).data[0].name, '한글 저장 대화');
  const old = rpc.child; rpc.close(); fs.unlinkSync(current); const replacement = f.install('0123456789abcdef');
  await rpc.start(); old.emit('exit', 0, null); old.stdout.emit('data', Buffer.from('not-json\n'));
  assert.equal(rpc.closed, false); assert.equal(launches[1].executable, replacement); assert.equal(resolutions, 3);
  assert.equal((await rpc.request('thread/list', { cursor: 'next' })).nextCursor, null);
  for (const method of ['thread/resume', 'turn/start', 'thread/start', 'thread/fork', 'config/value/write', 'consume_usage_reset']) await assert.rejects(rpc.request(method), error => error.code === 'METHOD_NOT_ALLOWED');
});
test('synchronous private errors and actual missing-child spawn failures are sanitized; retry recovers without account or executable-policy changes', async t => {
  let fail = 'sync'; const dir = temp(t);
  const rpc = new Rpc({ executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url)), 'readonly'], timeoutMs: 2000,
    childFactory(...args) { if (fail === 'sync') throw new Error('private executable path and account data'); if (fail === 'async') return spawn(join(dir, 'missing.exe'), [], args[2]); return spawn(...args); } });
  await assert.rejects(rpc.start(), error => error.code === 'CODEX_DISCONNECTED' && error.message === error.code);
  fail = 'async'; await assert.rejects(rpc.start(), error => error.code === 'CODEX_DISCONNECTED' && error.message === error.code);
  fail = false;
  try { await rpc.start(); assert.equal((await rpc.request('thread/list')).data.length, 1); }
  finally { const child = rpc.child; rpc.close(); if (child.exitCode === null && child.signalCode === null) await new Promise(done => child.once('exit', done)); }
});
