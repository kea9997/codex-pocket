import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_POWERSHELL } from '../server/account-platform.mjs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

for (const phase of ['staged', 'held', 'published']) test(`Windows process exit at ${phase} leaves no plaintext staging or backup`, { skip: process.platform !== 'win32' || process.env.CODEX_POCKET_WINDOWS_QA !== '1', timeout: 20000 }, async t => {
  const root = join(tmpdir(), 'CodexPhone-Crash-QA-' + randomUUID()); fs.mkdirSync(root);
  t.after(() => {
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    for (const name of fs.readdirSync(root)) {
      assert.ok(['auth.json', 'recovery.bin'].includes(name));
      const path = join(root, name), stat = fs.lstatSync(path); assert.ok(stat.isFile() && stat.nlink === 1); fs.unlinkSync(path);
    }
    fs.rmdirSync(root);
  });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(ACCOUNT_POWERSHELL, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../scripts/Test-AccountCrash.ps1', import.meta.url)), '-Phase', phase, '-FixtureRoot', root], { windowsHide: true, timeout: 15000, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', b => { errors += b; }); child.on('error', reject); child.on('close', code => resolve({ code, errors }));
  });
  assert.equal(result.code, 77, result.errors);
  assert.deepEqual(fs.readdirSync(root).sort(), phase === 'staged' ? ['auth.json', 'recovery.bin'] : ['recovery.bin']);
  const recovery = fs.readFileSync(join(root, 'recovery.bin')); assert.ok(!recovery.includes(Buffer.from('synthetic crash')));
  if (phase === 'staged') assert.equal(fs.readFileSync(join(root, 'auth.json'), 'utf8'), 'synthetic crash previous only');
});

// Fixed reviewed synthetic scripts: generate their own GUID temp roots; no production auth/GUI actions.
for (const [script, marker] of [['Test-AccountPublication.ps1', 'ACCOUNT_PUBLICATION_SYNTHETIC_QA_PASSED'], ['Test-AccountPlatform.ps1', 'ACCOUNT_PLATFORM_SYNTHETIC_QA_PASSED'], ['Test-AccountProcesses.ps1', 'ACCOUNT_PROCESSES_SYNTHETIC_QA_PASSED']]) {
  test(`Windows synthetic helper: ${script}`, { skip: process.platform !== 'win32' || process.env.CODEX_POCKET_WINDOWS_QA !== '1', timeout: 120000 }, async () => {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(ACCOUNT_POWERSHELL, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))], { windowsHide: true, timeout: 110000, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = '';
      child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
      child.on('error', reject); child.on('close', code => resolve({ code, output, errors }));
    });
    assert.equal(result.code, 0, result.errors); assert.equal(result.output.trim(), marker);
  });
}
