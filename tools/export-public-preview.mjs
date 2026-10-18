// Explicit text allowlist only. Never run this against a runtime data directory.
import { lstatSync, realpathSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const project = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const web = ['index.html', 'app.js', 'convenience.js', 'device-state.js', 'uploads.js', 'accounts.js', 'markdown-blocks.js', 'style.css'];
const files = [
  ...web.map(name => ['web/' + name, 'web/' + name]),
  ...['README.md', 'GUIDE.ko.md', 'CONTRIBUTING.md', 'LEGAL-REVIEW.md', 'demo.mjs'].map(name => ['tools/public-preview/' + name, name]),
  ['tools/public-preview/demo-check.mjs', 'demo.test.mjs'],
  ['tools/public-preview/demo-controls.js', 'web/demo-controls.js'],
  ['server/token-usage.mjs', 'token-usage.mjs'],
  ['LICENSE', 'LICENSE']
];
const release = { revision: 'public-preview', notes: ['Synthetic preview only. No Codex connection or real account operations.'] };
function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('PUBLIC_TRANSFORM_DRIFT');
  return text.replace(before, after);
}
function transform(name, text) {
  if (name === 'web/app.js') return `'use strict';globalThis.CodexPhoneRelease=Object.freeze(${JSON.stringify(release)});\n` + text;
  if (name !== 'web/index.html') return text;
  for (const [before, after] of [
    ['__WEB_REVISION__', 'public-preview'],
    ['<title>Codex 원격</title>', '<title>Codex Pocket · Synthetic Preview</title>'],
    ['Tailscale 전용. PC Codex를 열어 두세요. 승인·중지는 PC에서 처리합니다.', '합성 Preview 전용. 실제 Codex·계정·전송에는 연결하지 않습니다.'],
    ['<script src="/app.js" defer></script>', '<script src="/app.js" defer></script>\n  <script src="/demo-controls.js" defer></script>'],
    ['<nav id="threads"', '<details class="sample-qa"><summary>Synthetic Preview · 실제 연결 없음</summary><p class="tool-note">합성 자료만 제공하며 전송·로그인·업로드·기기 기능은 지원하지 않습니다.</p><button id="demoScenario" type="button">합성 토큰·초기화 다음 단계</button></details><nav id="threads"'],
    ['<span class="wordmark">Codex <span>원격</span></span>\n        <details', '<span class="wordmark">Codex <span>Preview</span></span>\n        <details']
  ]) text = replaceOnce(text, before, after);
  return text;
}
export function scanPublicText(text) {
  // Fail closed on known private-deployment residue; this is not a substitute for human review.
  if (/\b[A-Z]:[/\\]|(?:100\.[0-9]+\.[0-9]+\.[0-9]+)|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|\b(?:access_token|refresh_token)\s*[=:]\s*["'][^"']+["']/i.test(text)) throw new Error('PUBLIC_TEXT_REVIEW_REQUIRED');
}
function ordinaryDirectory(path) {
  let current = path;
  for (;;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PUBLIC_DESTINATION_UNSAFE');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  if (resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error('PUBLIC_DESTINATION_UNSAFE');
}
export function exportPublicPreview(destination) {
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('PUBLIC_DESTINATION_ABSOLUTE_REQUIRED');
  const target = resolve(destination), rel = relative(project, target);
  if (!rel || !rel.startsWith('..' + sep) && !isAbsolute(rel)) throw new Error('PUBLIC_DESTINATION_OUTSIDE_PROJECT_REQUIRED');
  ordinaryDirectory(dirname(target));
  try { lstatSync(target); throw new Error('PUBLIC_DESTINATION_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const output = new Map();
  for (const [source, name] of files) {
    const path = join(project, source), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== path) throw new Error('PUBLIC_SOURCE_UNSAFE');
    const bytes = readFileSync(path), text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || text.includes('\0')) throw new Error('PUBLIC_SOURCE_NOT_TEXT');
    output.set(name, transform(name, text));
  }
  output.set('package.json', JSON.stringify({ name: 'codex-pocket-preview', version: '0.0.0', private: true, license: 'MIT', type: 'module', engines: { node: '>=22' }, scripts: { start: 'node demo.mjs', test: 'node --test demo.test.mjs' } }, null, 2) + '\n');
  output.set('.gitignore', 'node_modules/\n*.log\n.env*\n.DS_Store\n');
  for (const text of output.values()) scanPublicText(text);
  const manifest = { scope: 'synthetic-web-preview-only', licenseDecision: 'MIT', files: [...output].map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') })) };
  output.set('EXPORT-MANIFEST.json', JSON.stringify(manifest, null, 2) + '\n');
  // Atomic directory claim; never delete/replace on failure. Inspect any partial export manually.
  mkdirSync(target); mkdirSync(join(target, 'web'));
  for (const [name, text] of output) writeFileSync(join(target, name), text, { flag: 'wx' });
  return manifest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { const result = exportPublicPreview(process.argv[2]); process.stdout.write(`Prepared ${result.files.length + 1} text files for local review only.\n`); }
  catch (error) { process.stderr.write(`${/^PUBLIC_[A-Z_]+$/.test(error.message) ? error.message : 'PUBLIC_EXPORT_FAILED'}\n`); process.exitCode = 1; }
}
