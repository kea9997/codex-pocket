import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { ACCOUNT_LIMITS, accountError, credentials, boundedRead, inspectPath } from './account-data.mjs';
import { resolveCodexExecutable } from './codex-install.mjs';
import { Rpc, BridgeError } from './rpc.mjs';
import { accountConfigPolicy } from './account-policy.mjs';

// Start-Bridge resolves PS7 to an absolute executable; direct API use may discover pwsh on PATH.
export const ACCOUNT_POWERSHELL = process.env.CODEX_POCKET_PWSH || 'pwsh.exe';
const helper = fileURLToPath(new URL('../scripts/Account-Platform.ps1', import.meta.url));
const codes = new Set(['ACCOUNT_STORAGE_UNSAFE', 'ACCOUNT_CACHE_BUSY', 'ACCOUNT_CACHE_UNSUPPORTED', 'ACCOUNT_CACHE_CHANGED', 'ACCOUNT_STORAGE_UNSUPPORTED', 'ACCOUNT_APP_UNAVAILABLE', 'ACCOUNT_APP_CHANGED', 'ACCOUNT_DESKTOP_CLOSE_REQUIRED', 'ACCOUNT_RECOVERY_REQUIRED']);
// Fixed executable/script, JSON stdin, bounded output. Never a shell, policy bypass or HTTP command bridge.
export function platformRequest(input, { childFactory = spawn, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, count = 0, output = '', settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) { child?.kill(); reject(error); } else resolve(value);
    };
    try {
      child = childFactory(ACCOUNT_POWERSHELL, ['-NoProfile', '-NonInteractive', '-File', helper], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const decoder = new StringDecoder('utf8');
      child.stdout.on('data', chunk => {
        count += chunk.length;
        if (count > 1500000) return finish(new BridgeError('ACCOUNT_PLATFORM_FAILED'));
        output += decoder.write(chunk);
      });
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => finish(new BridgeError('ACCOUNT_PLATFORM_FAILED')));
      child.once('error', () => finish(new BridgeError('ACCOUNT_PLATFORM_UNAVAILABLE')));
      child.once('close', code => {
        try {
          output += decoder.end();
          const value = JSON.parse(output);
          if (code !== 0 || value.error) throw new BridgeError(codes.has(value.error) ? value.error : 'ACCOUNT_PLATFORM_FAILED');
          finish(null, value);
        } catch (e) { finish(e instanceof BridgeError ? e : new BridgeError('ACCOUNT_PLATFORM_FAILED')); }
      });
      timer = setTimeout(() => finish(new BridgeError('ACCOUNT_PLATFORM_TIMEOUT')), timeout); timer.unref?.();
      child.stdin.end(JSON.stringify(input) + '\n');
    } catch { finish(new BridgeError('ACCOUNT_PLATFORM_UNAVAILABLE')); }
  });
}
export function officialDevice(value) {
  if (!value || value.url !== 'https://auth.openai.com/codex/device' || typeof value.code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value.code)) accountError('ACCOUNT_DEVICE_UNAVAILABLE');
  return { url: value.url, code: value.code };
}
export function loginEnvironment(home, env = process.env) {
  const result = {};
  for (const key of ['SystemRoot', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'PATH', 'PATHEXT', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH']) if (env[key] !== undefined) result[key] = env[key];
  result.CODEX_HOME = home;
  return result;
}
// Stock device login only, in a private isolated home. No custom OAuth client or forwarded localhost callback.
export function startDeviceLogin(home, { childFactory = spawn, resolveExecutable = resolveCodexExecutable } = {}) {
  const child = childFactory(resolveExecutable(), ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'],
    { cwd: home, env: loginEnvironment(home), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = 0, settled = false, resolveDone, rejectDone;
  const codeListeners = new Set(), streams = { stdout: { decoder: new StringDecoder('utf8'), text: '' }, stderr: { decoder: new StringDecoder('utf8'), text: '' } };
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const clear = () => { for (const stream of Object.values(streams)) stream.text = ''; codeListeners.clear(); };
  const fail = code => { if (settled) return; settled = true; clear(); child.kill(); rejectDone(new BridgeError(code)); };
  const project = (final = false) => {
    // Require a terminated value, never a partial URL at a pipe chunk boundary. Streams cannot splice values.
    const texts = Object.values(streams).map(stream => stream.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') + (final ? '\n' : ''));
    const urls = texts.flatMap(text => text.match(/https?:\/\/[^\s<>"']+(?=[\s<>"'])/g) || []);
    if (urls.some(url => url !== 'https://auth.openai.com/codex/device')) return fail('ACCOUNT_DEVICE_UNAVAILABLE');
    const codes = [...new Set(texts.flatMap(text => text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b(?=[\s<>"'])/g) || []))];
    if (codes.length > 1) return fail('ACCOUNT_DEVICE_UNAVAILABLE');
    if (urls.length && codes.length === 1) { const device = officialDevice({ url: urls[0], code: codes[0] }); for (const fn of codeListeners) fn(device); }
  };
  const consume = (chunk, stream) => {
    if (settled) return;
    bytes += chunk.length;
    if (bytes > 16384) return fail('ACCOUNT_DEVICE_UNAVAILABLE');
    // Output is never returned or logged. Only the exact official URL and bounded code may be projected.
    stream.text += stream.decoder.write(chunk); project();
  };
  child.stdout.on('data', chunk => consume(chunk, streams.stdout)); child.stderr.on('data', chunk => consume(chunk, streams.stderr)); child.stdin.on('error', () => fail('ACCOUNT_DEVICE_FAILED'));
  child.on('error', () => fail('ACCOUNT_DEVICE_UNAVAILABLE'));
  child.once('close', code => {
    if (settled) return;
    for (const stream of Object.values(streams)) stream.text += stream.decoder.end();
    project(true); if (settled) return;
    settled = true; clear(); if (code === 0) resolveDone(); else rejectDone(new BridgeError('ACCOUNT_DEVICE_FAILED'));
  });
  child.stdin.end();
  return { done, onCode(fn) { codeListeners.add(fn); }, async cancel() {
    if (child.exitCode !== null && child.exitCode !== undefined) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeError('ACCOUNT_LOGIN_CLEANUP_REQUIRED')), 3000); timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
    });
  } };
}

export class AccountPlatform {
  constructor({ request = platformRequest, home = join(homedir(), '.codex'), env = process.env, rpcFactory = () => new Rpc(), loginFactory = startDeviceLogin } = {}) {
    this.request = request; this.home = home; this.env = env; this.authPath = join(home, 'auth.json'); this.rpcFactory = rpcFactory; this.loginFactory = loginFactory;
    // Exact-handle retirement + no-overwrite publication; encrypted recovery covers the brief missing-name gap.
    this.switchSupported = process.platform === 'win32';
  }
  async protect(bytes) { return Buffer.from((await this.request({ action: 'protect', data: bytes.toString('base64') })).data, 'base64'); }
  async unprotect(bytes) { return Buffer.from((await this.request({ action: 'unprotect', data: bytes.toString('base64') })).data, 'base64'); }
  privatePath(path, file) { return this.request({ action: 'private', path, file }); }
  prepare(root, path) { return this.request({ action: 'prepare', root, path }); }
  replace(path, expected, bytes, privateFile = false) { return this.request({ action: 'replace', path, expected, data: bytes.toString('base64'), private: privateFile, transaction: randomUUID() }); }
  async supported() {
    if (process.platform !== 'win32' || ['CODEX_HOME', 'CODEX_MANAGED_CONFIG', 'CODEX_CONFIG', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'CODEX_AUTH_JSON', 'CODEX_API_KEY'].some(k => this.env[k])) accountError('ACCOUNT_STORAGE_UNSUPPORTED');
    inspectPath(this.home);
    for (const name of ['requirements.toml', 'managed_config.toml']) if (inspectPath(join(this.home, name), { file: true, missing: true })) accountError('ACCOUNT_STORAGE_UNSUPPORTED');
    const raw = boundedRead(join(this.home, 'config.toml'), 256 * 1024, { missing: true });
    if (raw) accountConfigPolicy(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    await this.request({ action: 'policy' });
  }
  async readCurrent({ missing = false } = {}) {
    await this.supported();
    if (missing && !inspectPath(this.authPath, { file: true, missing: true })) return null;
    const result = await this.request({ action: 'cache', path: this.authPath });
    if (!/^[a-f0-9]{8}:[a-f0-9]{16}:[a-f0-9]{16}$/.test(result.fileId)) accountError('ACCOUNT_STORAGE_UNSAFE');
    return { ...credentials(Buffer.from(result.data, 'base64')), fileId: result.fileId };
  }
  currentIdentity() { return credentials(boundedRead(this.authPath, ACCOUNT_LIMITS.authBytes)).identity; }
  async readLogin(home) { return credentials(Buffer.from((await this.request({ action: 'cache', path: join(home, 'auth.json') })).data, 'base64')); }
  async install(expected, bytes, { fileId, transaction } = {}) {
    if (!this.switchSupported || !/^[a-f0-9-]{36}$/.test(transaction || '') || (expected !== null && (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{8}:[a-f0-9]{16}:[a-f0-9]{16}$/.test(fileId || '')))) accountError('ACCOUNT_STORAGE_UNSAFE');
    credentials(bytes); await this.supported();
    return this.request({ action: 'install', path: this.authPath, expected, fileId: fileId || null, transaction, data: bytes.toString('base64') });
  }
  inspect() { return this.request({ action: 'inspect' }); }
  closeGui(snapshot) {
    const roots = snapshot.processes.filter(p => p.root);
    if (roots.length !== 1) accountError('ACCOUNT_DESKTOP_CLOSE_REQUIRED');
    return this.request({ action: 'close', executable: snapshot.package.executable, pid: roots[0].pid, started: roots[0].started });
  }
  launch(snapshot) { return this.request({ action: 'launch', executable: snapshot.package.executable }); }
  async verify(cache, engine) {
    const snapshot = await this.inspect();
    if (snapshot.processes.filter(p => p.root).length !== 1) accountError('ACCOUNT_APP_UNCONFIRMED');
    const current = await this.readCurrent();
    if (current.identity !== cache.identity) accountError('ACCOUNT_CACHE_CHANGED');
    await engine.desktop.tools({ refresh: true }); // Exact dynamic pipe rediscovery, no account tool invented.
    const rpc = this.rpcFactory(); rpc.on?.('request', m => rpc.reject(m.id));
    try {
      await rpc.start(); const r = await rpc.request('account/read', { refreshToken: false });
      if (r?.account?.type !== 'chatgpt' || r.account.email !== cache.email || r.requiresOpenaiAuth !== false) accountError('ACCOUNT_LOGIN_UNCONFIRMED');
    } finally { if (rpc.stop) await rpc.stop(); else rpc.close(); }
    const refreshed = await this.readCurrent();
    if (refreshed.identity !== cache.identity) accountError('ACCOUNT_CACHE_CHANGED');
    return refreshed;
  }
}
