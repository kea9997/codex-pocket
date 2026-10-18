import { lstatSync, realpathSync, openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { isAbsolute, resolve, dirname } from 'node:path';
import { BridgeError } from './rpc.mjs';

export function tailnetIPv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) return false;
  const n = value.split('.').map(Number);
  return n.every(v => v <= 255) && n[0] === 100 && n[1] >= 64 && n[1] <= 127;
}
export function validateConfig(value) {
  const fail = () => { throw new BridgeError('BRIDGE_CONFIG_INVALID'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'controllerThreadId,host,peers,port') fail();
  if (!tailnetIPv4(value.host) || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      !Array.isArray(value.peers) || !value.peers.length || value.peers.length > 16 ||
      value.peers.some(ip => !tailnetIPv4(ip) || ip === value.host) || new Set(value.peers).size !== value.peers.length ||
      typeof value.controllerThreadId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.controllerThreadId) || /^0{8}-/.test(value.controllerThreadId)) fail();
  return Object.freeze({ host: value.host, port: value.port, origin: `http://${value.host}:${value.port}`, peers: Object.freeze([...value.peers]), controllerThreadId: value.controllerThreadId });
}
export function ordinaryPath(path, file = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new BridgeError('PRIVATE_DIRECTORY_UNSAFE');
  let current = path;
  for (;;) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current === path && file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new BridgeError('PRIVATE_DIRECTORY_UNSAFE');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  if (realpathSync(path).toLowerCase() !== resolve(path).toLowerCase()) throw new BridgeError('PRIVATE_DIRECTORY_UNSAFE');
  return path;
}
export function loadConfig(dir) {
  ordinaryPath(dir);
  const path = resolve(dir, 'bridge.json'); ordinaryPath(path, true);
  const before = lstatSync(path), identity = s => [s.dev, s.ino, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join('/');
  if (!before.size || before.size > 4096) throw new BridgeError('BRIDGE_CONFIG_INVALID');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (identity(fstatSync(fd)) !== identity(before)) throw new Error();
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new Error(); offset += n; }
    ordinaryPath(path, true);
    if (identity(fstatSync(fd)) !== identity(before) || identity(lstatSync(path)) !== identity(before)) throw new Error();
    const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw new Error();
    return validateConfig(JSON.parse(text.replace(/^﻿/, '')));
  } catch { throw new BridgeError('BRIDGE_CONFIG_INVALID'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
