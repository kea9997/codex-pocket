import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSource } from '../tools/source-package.mjs';

test('every manifest JS/MJS file parses without executing service, probe, builder or Windows helpers', t => {
  const root = fileURLToPath(new URL('../', import.meta.url)), files = checkSource().manifest.files.filter(name => /\.(?:mjs|js)$/.test(name));
  for (const name of files) {
    const result = spawnSync(process.execPath, ['--check', join(root, name)], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, name + '\n' + result.stderr);
  }
  t.diagnostic(`${files.length} JavaScript syntax checks passed; PowerShell/C#/SDK/device checks are separate.`);
});
