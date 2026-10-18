// Thin unsigned-build entrypoint. Uses the same portable builder; no downloads or installation.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2), allowed = new Set(['-HostIPv4', '-Port', '-SdkPath', '-JdkPath', '-BuildToolsVersion', '-PrivateDirectory']);
if (process.platform !== 'win32' || args.length % 2 || args.some((value, i) => i % 2 === 0 ? !allowed.has(value) : /[\0\r\n]/.test(value))) throw new Error('WINDOWS_BUILD_ARGUMENTS_REQUIRED');
const result = spawnSync(process.env.CODEX_POCKET_PWSH || 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../scripts/Build-Android.ps1', import.meta.url)), ...args, '-Unsigned'], { stdio: 'inherit', windowsHide: true, shell: false });
if (result.error || result.status !== 0) { process.stderr.write('ANDROID_UNSIGNED_BUILD_FAILED\n'); process.exitCode = 1; }
