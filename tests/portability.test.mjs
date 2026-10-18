import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
test('setup/task are explicit WhatIf/nooverwrite operations and production start requires private validated config', () => {
  const setup = source('scripts/Setup-Bridge.ps1'), task = source('scripts/Install-LoginTask.ps1'), main = source('server/main.mjs');
  for (const text of [setup, task]) { assert.match(text, /SupportsShouldProcess/); assert.match(text, /ShouldProcess/); assert.doesNotMatch(text, /Set-ExecutionPolicy|New-NetFirewall|tailscale (?:up|serve|funnel)|Start-ScheduledTask/); }
  assert.match(setup, /FileMode\]::CreateNew/); assert.match(task, /TASK_ALREADY_EXISTS_REVIEW_FIRST/); assert.doesNotMatch(task, /Register-ScheduledTask[^\n]*-Force/);
  assert.match(task, /CodexPocket-Bridge/); assert.match(main, /process\.argv\.length !== 3/);
  assert.ok(main.indexOf('loadConfig(dir)') < main.indexOf('new Engine(')); assert.match(main, /controllerId: config\.controllerThreadId/);
  const stop = source('scripts/Stop-Bridge.ps1'); assert.match(stop, /CreateNew/); assert.doesNotMatch(stop, /Stop-Process|taskkill|Process\]::GetProcessById/);
});
test('Android build uses supplied standard toolchain/exact generated origin/new private work and installer signing, not source mutation or batch shell', () => {
  const build = source('scripts/Build-Android.ps1'), lease = source('scripts/Pocket-PrivateFile.cs');
  for (const pattern of [/ANDROID_SDK_ROOT/, /ANDROID_HOME/, /JAVA_HOME/, /JDK17_REQUIRED/, /EXACT_TAILNET_IPV4_REQUIRED/, /NewGuid/, /PocketConfig\.java/, /network_security_config\.xml/, /dev\.codexpocket\.app/, /--min-sdk-version', '26'/, /--target-sdk-version', '36'/, /com\.android\.tools\.r8\.D8/, /apksigner\.jar/, /CreateNew/, /SIGNING_ALREADY_IN_PROGRESS/, /SIGNING_STATE_INCONSISTENT/, /PocketPrivateFile\]::Open/, /ReleaseMutex/, /SIGNING_PASSWORD_FORMAT_INVALID/]) assert.match(build, pattern);
  assert.doesNotMatch(build, /cmd\.exe|\.bat\b|Invoke-Expression|adb(?:\.exe)?\s+install|Copy-Item[^\n]*-Destination \$source/);
  assert.match(build, /\[IO\.File\]::Move\(\$stagedKey, \$key\)/);
  assert.match(lease, /info\.Links != 1/); assert.match(lease, /GetFinalPathNameByHandleW/); assert.match(lease, /sd\.Owner != sid/); assert.match(lease, /sd\.DiscretionaryAcl\.Count != 1/); assert.match(lease, /directory \? 3u : 1u/);
  assert.match(build, /CODEX_POCKET_SIGN_PASS = \$oldPass/);
});
