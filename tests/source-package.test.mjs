import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkSource, exportSource, scanSourceText } from '../tools/source-package.mjs';
import { temp } from './helpers.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
function exported(t) { const parent = temp(t), destination = join(parent, 'source with spaces'); return { destination, parent, manifest: exportSource(destination) }; }
test('full source manifest covers runtime/native/Windows helpers/tests/docs; new external export is hash-exact, testable, nonoverwriting and excludes neighbors', t => {
  const original = checkSource(), { destination, parent, manifest } = exported(t);
  fs.writeFileSync(join(parent, 'not-in-source.txt'), 'invented neighbor');
  assert.ok(original.files.length >= 150); assert.equal(manifest.files.length, original.files.length);
  assert.equal(checkSource(destination).files.length, original.files.length);
  for (const f of manifest.files) {
    const bytes = fs.readFileSync(join(destination, f.path)); assert.equal(bytes.length, f.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), f.sha256);
    assert.deepEqual(bytes, fs.readFileSync(join(root, f.path)));
  }
  assert.ok(!fs.existsSync(join(destination, 'not-in-source.txt')));
  assert.throws(() => exportSource(destination), /SOURCE_DESTINATION_EXISTS/);
  assert.throws(() => exportSource(join(root, 'never-create-source-copy')), /SOURCE_DESTINATION_OUTSIDE_PROJECT_REQUIRED/);
  assert.throws(() => exportSource('relative'), /SOURCE_DESTINATION_ABSOLUTE_REQUIRED/);
  const child = spawnSync(process.execPath, ['--test', 'tests/config.test.mjs', 'tests/rpc.test.mjs', 'tests/android-contract.test.mjs'], { cwd: destination, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
test('packaging fails on unlisted state/binary, manifest traversal/missing runtime, altered hashes, hardlinks and invalid UTF8 instead of silently dropping files', t => {
  const { destination } = exported(t), extra = join(destination, 'invented-state.json');
  fs.writeFileSync(extra, '{}'); assert.throws(() => checkSource(destination), /SOURCE_UNLISTED_OR_MISSING_FILE/); fs.unlinkSync(extra);
  const manifestPath = join(destination, 'SOURCE-MANIFEST.json'), raw = fs.readFileSync(manifestPath), manifest = JSON.parse(raw);
  manifest.files.push('../escape'); fs.writeFileSync(manifestPath, JSON.stringify(manifest)); assert.throws(() => checkSource(destination), /SOURCE_MANIFEST_INVALID/);
  manifest.files.pop(); manifest.files = manifest.files.filter(n => n !== 'server/engine.mjs'); fs.writeFileSync(manifestPath, JSON.stringify(manifest)); assert.throws(() => checkSource(destination), /SOURCE_MANIFEST_INCOMPLETE/);
  fs.writeFileSync(manifestPath, raw);
  const readme = join(destination, 'README.md'), saved = fs.readFileSync(readme);
  fs.appendFileSync(readme, '\nInvented change\n'); assert.throws(() => checkSource(destination), /SOURCE_HASHES_INVALID/); fs.writeFileSync(readme, saved);
  const linked = join(destination, '..', 'linked-readme'); fs.linkSync(readme, linked); assert.throws(() => checkSource(destination), /SOURCE_FILE_UNSAFE/); fs.unlinkSync(linked);
  fs.writeFileSync(readme, Buffer.from([0xff, 0x00])); assert.throws(() => checkSource(destination), /SOURCE_NOT_TEXT/);
});
test('privacy scan rejects unknown tailnet/identity/credential/key/email literals; narrow synthetic exceptions cannot excuse another file or real-shaped content', () => {
  for (const text of ['100.' + '111.1.2', '100.' + '118.1.2', '100.' + '70.1.2', 'C:/Users/' + 'HO' + 'ME/private', 'G' + '16', 'Z' + 'Book', 'company' + '3090', 'POLICY_' + 'REMINDER', 'D:/' + '02. development/app', 'access_' + 'token="unreviewed-secret"', '-----BEGIN ' + 'PRIVATE KEY-----', 'person@' + 'private.invalid', 'ghp_' + 'a'.repeat(30)]) assert.throws(() => scanSourceText('README.md', text), /SOURCE_REVIEW_REQUIRED/);
  assert.doesNotThrow(() => scanSourceText('README.md', 'Invented host 100.64.0.10; user@example.invalid; D:/sample/results'));
  assert.doesNotThrow(() => scanSourceText('tests/accounts-fixture.mjs', "access_" + "token: 'fixture-access-'"));
  assert.throws(() => scanSourceText('server/accounts.mjs', "access_" + "token: 'fixture-access-'"), /SOURCE_REVIEW_REQUIRED/);
  assert.throws(() => scanSourceText('tests/accounts-fixture.mjs', "access_" + "token: 'unreviewed-secret'"), /SOURCE_REVIEW_REQUIRED/);
});
