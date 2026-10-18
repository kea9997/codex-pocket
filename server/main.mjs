import { openSync, closeSync, writeFileSync, existsSync, unlinkSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rpc, BridgeError } from './rpc.mjs';
import { Desktop } from './desktop.mjs';
import { Auth } from './security.mjs';
import { Engine } from './engine.mjs';
import { createBridge, listen } from './http.mjs';
import { processPairingRequest } from './pairing.mjs';
import { Accounts } from './accounts.mjs';
import { loadConfig } from './config.mjs';
import { platformRequest } from './account-platform.mjs';

if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22 || process.argv.length !== 3) throw new BridgeError('WINDOWS_NODE22_PRIVATE_DIRECTORY_REQUIRED');
const dir = process.argv[2];
let config;
try {
  config = loadConfig(dir);
  await platformRequest({ action: 'private', path: dir, file: false });
  await platformRequest({ action: 'private', path: join(dir, 'bridge.json'), file: true });
} catch (e) {
  process.stderr.write(`${e instanceof BridgeError && /^[A-Z_]+$/.test(e.code) ? e.code : 'BRIDGE_CONFIG_UNAVAILABLE'}\n`);
  process.exit(1);
}
const logPath = join(dir, 'service.log');
const log = code => {
  if (!/^[A-Z_]+$/.test(code)) code = 'BRIDGE_ERROR';
  if (existsSync(logPath) && readFileSync(logPath).length > 48000) writeFileSync(logPath, '');
  appendFileSync(logPath, `${new Date().toISOString()} ${code}\n`, { mode: 0o600 });
};
const lock = join(dir, 'service.lock');
let fd;
try { fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
catch { log('INSTANCE_LOCKED'); process.exit(1); }
let engine, accounts, server, timer, stopping = false;
function shutdown(exitCode = 0) {
  if (stopping) return; stopping = true;
  clearInterval(timer); server?.close(); server?.closeAllConnections(); accounts?.close(); engine?.close();
  closeSync(fd); unlinkSync(lock); log(exitCode ? 'FAILED' : 'STOPPED'); process.exit(exitCode);
}
process.on('uncaughtException', () => { log('UNEXPECTED_FAILURE'); shutdown(1); });
process.on('unhandledRejection', () => { log('UNEXPECTED_FAILURE'); shutdown(1); });
try {
  // Configuration was validated before touching runtime state.
  const desktop = new Desktop({ controllerId: config.controllerThreadId });
  engine = new Engine(desktop, dir, { historyRpcFactory: async () => {
    const rpc = new Rpc(); rpc.on('request', m => rpc.reject(m.id));
    try { await rpc.start(); return rpc; } catch (e) { rpc.close(); throw e; }
  } });
  const auth = new Auth(dir); auth.issuePairing();
  accounts = new Accounts(engine, dir); await accounts.init();
  server = createBridge({ auth, engine, accounts, config }); await listen(server);
  const stopFile = join(dir, 'stop.request');
  if (existsSync(stopFile)) unlinkSync(stopFile);
  timer = setInterval(() => {
    if (existsSync(stopFile)) { unlinkSync(stopFile); shutdown(); return; }
    try { processPairingRequest(auth, dir); }
    catch { log('PAIRING_RENEWAL_FAILED'); }
  }, 1000);
  log('STARTED');
  process.on('SIGINT', () => shutdown()); process.on('SIGTERM', () => shutdown());
} catch (e) { log(e instanceof BridgeError ? e.code : 'START_FAILED'); shutdown(1); }
