// Full source only: explicit reviewed names, bounded UTF-8 reads, no install/build/publish.
import * as fs from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const project = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const manifestName = 'SOURCE-MANIFEST.json', hashesName = 'SOURCE-HASHES.json';
const maxFile = 3 * 1024 * 1024, maxTotal = 32 * 1024 * 1024;
const fail = code => { throw new Error(code); };
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = s => [s.dev, s.ino, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join('/');
function ordinaryDirectory(path) {
  for (let current = path;; current = dirname(current)) {
    const s = fs.lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink() || !equalPath(fs.realpathSync(current), current)) fail('SOURCE_DIRECTORY_UNSAFE');
    if (dirname(current) === current) break;
  }
}
function readText(path) {
  ordinaryDirectory(dirname(path));
  const before = fs.lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxFile || !equalPath(fs.realpathSync(path), path)) fail('SOURCE_FILE_UNSAFE');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (identity(fs.fstatSync(fd)) !== identity(before)) fail('SOURCE_CHANGED');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) fail('SOURCE_CHANGED'); offset += n; }
    if (identity(fs.fstatSync(fd)) !== identity(before) || identity(fs.lstatSync(path)) !== identity(before)) fail('SOURCE_CHANGED');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('SOURCE_NOT_TEXT');
    return bytes;
  } finally { fs.closeSync(fd); }
}
export function scanSourceText(name, text) {
  // Known deployment residue is blocked even in tests. Do not include sensitive matches in errors.
  if (/100\.(?:111|118)\.[0-9]+\.[0-9]+|\b(?:G\x31\x36|Z\x42ook|company3\x30\x39\x30|POLICY_REM\x49NDER)\b|Users[/\\]+HOME\b|Codex(?:Phone|PocketPublic)Build|[A-Z]:[/\\]+(?:02\.|03\.)/i.test(text)) fail('SOURCE_REVIEW_REQUIRED');
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}/.test(text)) fail('SOURCE_REVIEW_REQUIRED');
  for (const match of text.matchAll(/\b100\.[0-9]+\.[0-9]+\.[0-9]+\b/g)) {
    if (/^100\.64\.0\.(?:0|[1-9][0-9]{0,2})$/.test(match[0]) && Number(match[0].split('.').at(-1)) <= 255) continue;
    if (name === 'tests/config.test.mjs' && /^100\.(?:63\.255\.255|127\.255\.255|128\.0\.0|064\.0\.1|64\.0\.256)$/.test(match[0])) continue;
    fail('SOURCE_REVIEW_REQUIRED');
  }
  for (const match of text.matchAll(/\b(?:access_token|refresh_token|api_key)["']?\s*[:=]\s*["']([^"'\r\n]+)["']/gi)) {
    // Only these two reviewed negative-fixture files may contain inert credential-looking literals.
    const fixture = name === 'tests/accounts-fixture.mjs' && /^fixture-(?:access|refresh)-$/.test(match[1]) ||
      name === 'tests/public-preview.test.mjs' && match[1] === 'synthetic-secret';
    if (!fixture) fail('SOURCE_REVIEW_REQUIRED');
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
    if (!match[0].endsWith('@example.invalid')) fail('SOURCE_REVIEW_REQUIRED');
  }
}
function safeName(name) {
  return typeof name === 'string' && /^(?:[A-Za-z0-9_-]+\/)*\.?[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(name) && !name.split('/').some(p => p === '.' || p === '..') && name !== hashesName;
}
function inventory(root) {
  const names = []; let count = 0;
  function visit(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++count > 1024) fail('SOURCE_INVENTORY_LIMIT');
      if (!prefix && entry.name === '.git') { if (!entry.isDirectory() || entry.isSymbolicLink()) fail('SOURCE_DIRECTORY_UNSAFE'); continue; }
      const name = prefix + entry.name, path = join(dir, entry.name);
      if (entry.isSymbolicLink() || !equalPath(fs.realpathSync(path), path)) fail('SOURCE_FILE_UNSAFE');
      if (entry.isDirectory()) visit(path, name + '/'); else names.push(name);
    }
  }
  visit(root); return names.sort();
}
export function checkSource(root = project) {
  root = resolve(root); ordinaryDirectory(root);
  const manifestBytes = readText(join(root, manifestName)); let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { fail('SOURCE_MANIFEST_INVALID'); }
  if (manifest?.format !== 1 || manifest.scope !== 'full-windows-android-source' || manifest.license !== 'MIT' || !Array.isArray(manifest.files) || manifest.files.length < 100 || manifest.files.length > 512 || manifest.files.some(n => !safeName(n)) || new Set(manifest.files).size !== manifest.files.length || !manifest.files.includes(manifestName)) fail('SOURCE_MANIFEST_INVALID');
  for (const required of ['server/main.mjs', 'server/accounts.mjs', 'server/engine.mjs', 'server/config.mjs', 'scripts/Build-Android.ps1', 'scripts/Setup-Bridge.ps1', 'android/app/src/main/AndroidManifest.xml', 'web/app.js', 'tests/config.test.mjs', 'LICENSE', 'README.md', 'GUIDE.ko.md', 'SECURITY.md', 'tools/source-package.mjs']) if (!manifest.files.includes(required)) fail('SOURCE_MANIFEST_INCOMPLETE');
  const names = inventory(root), hasHashes = names.includes(hashesName);
  if (JSON.stringify(names.filter(n => n !== hashesName)) !== JSON.stringify([...manifest.files].sort())) fail('SOURCE_UNLISTED_OR_MISSING_FILE');
  let total = 0; const content = new Map(), files = [];
  for (const name of manifest.files) {
    const bytes = readText(join(root, name)); total += bytes.length; if (total > maxTotal) fail('SOURCE_SIZE_LIMIT');
    scanSourceText(name, bytes.toString('utf8'));
    content.set(name, bytes); files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (hasHashes) {
    let hashes; try { hashes = JSON.parse(readText(join(root, hashesName))); } catch { fail('SOURCE_HASHES_INVALID'); }
    if (JSON.stringify(hashes) !== JSON.stringify({ format: 1, scope: manifest.scope, license: 'MIT', files })) fail('SOURCE_HASHES_INVALID');
  }
  return { manifest, content, files, bytes: total };
}
export function exportSource(destination, root = project) {
  if (typeof destination !== 'string' || !isAbsolute(destination)) fail('SOURCE_DESTINATION_ABSOLUTE_REQUIRED');
  const target = resolve(destination); root = resolve(root); ordinaryDirectory(dirname(target));
  const rel = relative(root, target), reverse = relative(target, root);
  if (!rel || !rel.startsWith('..' + sep) && !isAbsolute(rel) || !reverse || !reverse.startsWith('..' + sep) && !isAbsolute(reverse)) fail('SOURCE_DESTINATION_OUTSIDE_PROJECT_REQUIRED');
  try { fs.lstatSync(target); fail('SOURCE_DESTINATION_EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const checked = checkSource(root);
  // Claim a NEW directory only. Never delete/replace a partial output on failure.
  fs.mkdirSync(target);
  for (const [name, bytes] of checked.content) {
    fs.mkdirSync(dirname(join(target, name)), { recursive: true }); fs.writeFileSync(join(target, name), bytes, { flag: 'wx' });
  }
  const hashes = { format: 1, scope: checked.manifest.scope, license: 'MIT', files: checked.files };
  fs.writeFileSync(join(target, hashesName), JSON.stringify(hashes, null, 2) + '\n', { flag: 'wx' });
  return hashes;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) fail('SOURCE_ARGUMENTS_INVALID');
    const result = process.argv[2] ? exportSource(process.argv[2]) : checkSource();
    process.stdout.write(`Reviewed ${result.files.length} full-source text files. No build, install or publication performed.\n`);
  } catch (e) { process.stderr.write(`${/^SOURCE_[A-Z_]+$/.test(e.message) ? e.message : 'SOURCE_CHECK_FAILED'}\n`); process.exitCode = 1; }
}
