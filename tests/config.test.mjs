import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { validateConfig, tailnetIPv4, loadConfig, ordinaryPath } from '../server/config.mjs';
import { guardPeer, guardRequest } from '../server/security.mjs';
import { Media } from '../server/media.mjs';
import { Files } from '../server/files.mjs';
import { Engine } from '../server/engine.mjs';
import { sampleImage } from '../tools/sample-image.mjs';
import { imageFixture } from './media-fixture.mjs';
import { temp, MockDesktop } from './helpers.mjs';

const example = () => ({ host: '100.64.0.10', port: 47832, peers: ['100.64.0.11'], controllerThreadId: '12345678-1234-1234-1234-123456789abc' });
const invalid = fn => assert.throws(fn, e => e.code === 'BRIDGE_CONFIG_INVALID');
test('production configuration accepts only exact canonical tailnet peers/port/controller and immutable projection', () => {
  for (const ip of ['100.64.0.0', '100.127.255.255', '100.64.0.10']) assert.equal(tailnetIPv4(ip), true);
  for (const ip of ['0.0.0.0', '127.0.0.1', '192.168.1.2', '8.8.8.8', '100.63.255.255', '100.128.0.0', '100.064.0.1', '100.64.0.256', '100.64.0.1:47831', 'pc.example.invalid', '::1', null]) {
    assert.equal(tailnetIPv4(ip), false); invalid(() => validateConfig({ ...example(), host: ip }));
  }
  for (const change of [{ port: 80 }, { port: 65536 }, { port: '47832' }, { port: 47832.5 }, { peers: [] }, { peers: ['127.0.0.1'] }, { peers: ['100.64.0.10'] }, { peers: ['100.64.0.11', '100.64.0.11'] }, { peers: Array(17).fill('100.64.0.11') }, { controllerThreadId: 'configure-me' }, { controllerThreadId: '00000000-0000-0000-0000-000000000000' }, { origin: 'https://other.invalid' }]) invalid(() => validateConfig({ ...example(), ...change }));
  const input = example(), config = validateConfig(input); input.peers.push('100.64.0.12');
  assert.equal(config.origin, 'http://100.64.0.10:47832'); assert.equal(config.peers.length, 1);
  assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.peers));
  for (const address of ['100.64.0.10', '::ffff:100.64.0.11']) guardPeer(address, config);
  for (const address of ['100.64.0.12', '127.0.0.1', '::1']) assert.throws(() => guardPeer(address, config), e => e.code === 'PEER_REJECTED');
  const req = { method: 'POST', headers: { host: '100.64.0.10:47832', origin: config.origin } }; guardRequest(req, config);
  for (const headers of [{ ...req.headers, host: '100.64.0.10:47831' }, { ...req.headers, origin: 'http://100.64.0.10:47831' }, { host: req.headers.host }]) assert.throws(() => guardRequest({ ...req, headers }, config));
});
test('configuration loading is mandatory, bounded and rejects nonordinary or hardlinked files without reading other state', t => {
  const dir = temp(t), file = join(dir, 'bridge.json');
  assert.throws(() => loadConfig(dir));
  fs.writeFileSync(file, JSON.stringify(example())); assert.equal(loadConfig(dir).port, 47832);
  assert.throws(() => ordinaryPath('relative')); assert.equal(ordinaryPath(resolve(dir)), resolve(dir));
  fs.linkSync(file, join(dir, 'other.json')); assert.throws(() => loadConfig(dir), e => e.code === 'PRIVATE_DIRECTORY_UNSAFE');
  fs.unlinkSync(join(dir, 'other.json')); fs.writeFileSync(file, ' '.repeat(4097)); invalid(() => loadConfig(dir));
  fs.writeFileSync(file, '{}'); invalid(() => loadConfig(dir));
});
test('configured private root excludes images and result files regardless of directory name; sibling results and exact owned uploads remain usable', t => {
  const { dir } = imageFixture(t), privateRoot = join(dir, 'ordinary-store'), sibling = join(dir, 'ordinary-store-results');
  fs.mkdirSync(privateRoot); fs.mkdirSync(sibling);
  const privateFile = join(privateRoot, 'frame.png'), publicFile = join(sibling, 'frame.png');
  fs.writeFileSync(privateFile, sampleImage()); fs.writeFileSync(publicFile, sampleImage());
  const session = { id: 'own' }, media = new Media({ privateRoot }), files = new Files({ privateRoot });
  for (const registry of [media, files]) {
    assert.equal(registry.register(session, 'thread', privateFile).error, 'MEDIA_PATH_BLOCKED');
    assert.equal(registry.register(session, 'thread', publicFile).state, 'ready');
  }
  const upload = new Media({ privateRoot, ownedUpload: (owner, raw) => owner === session && raw === privateFile ? { file: privateFile, sha256: 'fixture' } : null });
  assert.equal(upload.register(session, 'thread', privateFile).state, 'ready');
  assert.equal(upload.register({ id: 'foreign' }, 'thread', privateFile).error, 'MEDIA_PATH_BLOCKED');
  const engine = new Engine(new MockDesktop(), privateRoot); t.after(() => engine.close());
  assert.equal(engine.media.register(session, 'thread', privateFile).error, 'MEDIA_PATH_BLOCKED');
  assert.equal(engine.files.register(session, 'thread', privateFile).error, 'MEDIA_PATH_BLOCKED');
});
