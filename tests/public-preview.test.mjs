import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { exportPublicPreview, scanPublicText } from '../tools/export-public-preview.mjs';
import { temp, httpCall, waitFor } from './helpers.mjs';
import { browser } from './browser-fixture.mjs';

test('public exporter uses a fixed text whitelist, refuses overwrites and creates a self-contained portable testable demo without private residue', async t => {
  const parent = temp(t), destination = join(parent, 'review');
  writeFileSync(join(parent, 'unrelated-secret.txt'), 'DO-NOT-EXPORT');
  const manifest = exportPublicPreview(destination);
  assert.equal(manifest.scope, 'synthetic-web-preview-only'); assert.equal(manifest.licenseDecision, 'MIT');
  assert.deepEqual(readdirSync(join(destination, 'web')).sort(), ['accounts.js', 'app.js', 'convenience.js', 'demo-controls.js', 'device-state.js', 'index.html', 'markdown-blocks.js', 'style.css', 'uploads.js']);
  for (const row of manifest.files) {
    const bytes = readFileSync(join(destination, row.path)); scanPublicText(bytes.toString());
    assert.equal(bytes.length, row.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
    assert.ok(!bytes.includes(Buffer.from('DO-NOT-EXPORT')));
  }
  const page = readFileSync(join(destination, 'web/index.html'), 'utf8');
  assert.match(page, /Synthetic Preview/); assert.doesNotMatch(page, /__WEB_REVISION__|회사 Claude|회사 연결/);
  for (const excluded of ['server', 'android', 'scripts', 'tools', 'uploads', 'unrelated-secret.txt']) assert.ok(!readdirSync(destination).includes(excluded));
  assert.throws(() => exportPublicPreview(destination), /PUBLIC_DESTINATION_EXISTS/); assert.throws(() => exportPublicPreview('relative-path'), /ABSOLUTE_REQUIRED/);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; // Isolated child test runner, not recursive in-process discovery.
  const output = execFileSync(process.execPath, ['--test', 'demo.test.mjs'], { cwd: destination, env, encoding: 'utf8', timeout: 20000 });
  assert.match(output, /pass 2/); assert.match(output, /fail 0/);
  const { createDemo } = await import(pathToFileURL(join(destination, 'demo.mjs')));
  const server = createDemo(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (path, options = {}) => httpCall(server.address().port, path, { method: options.method ?? 'GET', data: options.body, headers: { Host: '127.0.0.1:' + server.address().port } });
  const f = await browser({ selected: false, assetRoot: pathToFileURL(join(destination, 'web') + '/'), activityCount: 1,
    requestHook: async (path, options) => { const result = await request(path, options); return { data: result.json, status: result.status }; } });
  await waitFor(() => !f.ui.state.usage.flight); assert.match(f.el('usageSummary').textContent, /누적 1,234,567/);
  await f.ui.openThread('demo-chat'); assert.equal(f.ui.state.selected, 'demo-chat'); assert.equal(f.el('draft').disabled, false); assert.equal(f.el('send').disabled, true);
  f.el('usageSummary').onclick(); assert.equal(f.ui.state.tools.pane, 'usage'); f.el('closeTools').onclick();
  f.el('chatTools').onclick(); f.el('quickContinue').onclick(); assert.match(f.el('draft').value, /계속 진행해줘/);
  assert.ok(!f.calls.some(c => c.path === '/api/send')); assert.equal(f.el('toolsDialog').open, false);
});
test('public text preflight blocks known deployment identities, absolute paths and credential-shaped assignments without rewriting unknown text', () => {
  for (const text of ['100.64.0.10', 'C:/Users/person', 'D:\\private', 'access_token="synthetic-secret"', 'BEGIN PRIVATE KEY']) assert.throws(() => scanPublicText(text), /PUBLIC_TEXT_REVIEW_REQUIRED/);
  assert.doesNotThrow(() => scanPublicText('http://127.0.0.1:47833 — synthetic preview, no actual account'));
});
