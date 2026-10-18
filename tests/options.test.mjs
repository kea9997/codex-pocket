import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { advertisedModels, localProjects, Options } from '../server/options.mjs';
import { Engine } from '../server/engine.mjs';
import { BridgeError } from '../server/rpc.mjs';
import { hash, saveJson } from '../server/security.mjs';
import { fixture, temp, MockDesktop, waitFor, httpCall } from './helpers.mjs';
import { createBridge } from '../server/http.mjs';
import { ORIGIN, COOKIE } from '../server/security.mjs';
import { modelTool, installOptions, projects, destinationNote } from './options-fixture.mjs';
const owner = { id: 'creation-owner' }, other = { id: 'other-owner' };
const rejects = (p, code) => assert.rejects(p, e => e.code === code);
const input = () => ({ requestId: randomUUID(), text: '합성 새 요청 · 절대 실제 전송 아님', target: { type: 'projectless' } });

test('strict host advertisement discovers new model IDs and per-model order, intersects thinking enum, and prefers structured enums', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `new-fixture-${i}`, efforts: i % 2 ? ['high', 'low', 'ultra'] : ['low', 'high'] }));
  const tool = modelTool('create_thread', rows);
  assert.deepEqual(advertisedModels(tool), rows);
  tool.inputSchema.properties.thinking.enum = ['low', 'high'];
  assert.deepEqual(advertisedModels(tool)[1].efforts, ['high', 'low']);
  tool.inputSchema.properties.model.enum = ['unadvertised']; assert.deepEqual(advertisedModels(tool), []);
  const structured = modelTool('create_thread');
  structured.inputSchema.properties.model = { enum: ['structured'] };
  structured.inputSchema.oneOf = [{ properties: { model: { const: 'structured' }, thinking: { enum: ['high', 'low'] } } }];
  assert.deepEqual(advertisedModels(structured), [{ id: 'structured', efforts: ['high', 'low'] }]);
  delete structured.inputSchema.oneOf;
  assert.deepEqual(advertisedModels(structured), [{ id: 'structured', efforts: [] }]); // No effort combinations inferred from a global enum.
});
test('both observed native advertisement forms discover seven synthetic models, accepting only the exact create destination note at the final list boundary', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `host-new-${i}`, efforts: i % 2 ? ['high', 'low', 'ultra'] : ['medium', 'xhigh'] }));
  const create = modelTool('create_thread', rows), send = modelTool('send_message_to_thread', rows);
  const original = create.inputSchema.properties.model.description, bare = send.inputSchema.properties.model.description;
  assert.equal(original, bare + destinationNote);
  assert.deepEqual(advertisedModels(create), rows); assert.deepEqual(advertisedModels(send), rows);
  for (const description of [original + ' Untrusted tail.', original + destinationNote, bare + ' Untrusted tail.',
    bare + destinationNote.replace('when the tool runs.', 'for every model.'), bare + destinationNote.replace("host's", 'hosts'),
    bare.slice(0, -1) + destinationNote, bare + '\n' + destinationNote.trim(),
    bare + ' appended-model (Synthetic; supported reasoning efforts: high).',
    original + ' appended-model (Synthetic; supported reasoning efforts: high).',
    original + ' Models and supported reasoning efforts on the calling host: appended-model (Synthetic; supported reasoning efforts: high).']) {
    create.inputSchema.properties.model.description = description; assert.deepEqual(advertisedModels(create), []);
  }
  create.inputSchema.properties.model.description = original;
  create.inputSchema.properties.model.enum = ['not-in-list']; assert.deepEqual(advertisedModels(create), []); delete create.inputSchema.properties.model.enum;
  send.inputSchema.properties.model.description = original; assert.deepEqual(advertisedModels(send), []); // This suffix is evidenced only for create.
  send.inputSchema.properties.model.description = bare;
  const desktop = new MockDesktop(); installOptions(desktop);
  desktop.catalog = [...desktop.catalog.filter(t => !['create_thread', 'send_message_to_thread'].includes(t.name)), create, send];
  const options = new Options(desktop), result = await options.snapshot();
  assert.equal(result.create.state, 'ready'); assert.equal(result.send.state, 'ready'); assert.equal(result.create.models.length, 7); assert.equal(result.send.models.length, 7);
  assert.ok(!JSON.stringify(result).includes(destinationNote)); assert.ok(desktop.calls.every(c => c.tool === 'list_projects'));
});
test('unrecognized, malformed, duplicate, excessive and hostile metadata fail closed without reflecting descriptions', () => {
  const base = modelTool('send_message_to_thread');
  for (const description of [null, '', 'Public model list: guessed (high)', 'Models and supported reasoning efforts on the calling host: guess (text; supported reasoning efforts: high), ',
    base.inputSchema.properties.model.description.replace('low, high', 'high, high'),
    base.inputSchema.properties.model.description.replace('low, high', 'high, invented'),
    base.inputSchema.properties.model.description.replace('fixture-deep', 'fixture-fast'),
    base.inputSchema.properties.model.description.replace('fixture-fast', '../path'),
    base.inputSchema.properties.model.description + ' PRIVATE_RAW_SCHEMA', 'x'.repeat(24001)]) {
    const tool = modelTool('send_message_to_thread'); tool.inputSchema.properties.model.description = description;
    assert.deepEqual(advertisedModels(tool), [], String(description).slice(0, 100));
  }
  for (const thinking of [null, ['invented'], ['high', 'high'], []]) {
    const tool = modelTool('create_thread'); tool.inputSchema.properties.thinking.enum = thinking; assert.deepEqual(advertisedModels(tool), []);
  }
  for (const oneOf of [null, {}, 'malformed', [], Array(33).fill({})]) {
    const tool = modelTool('create_thread'); tool.inputSchema.oneOf = oneOf; assert.deepEqual(advertisedModels(tool), []);
  }
  assert.deepEqual(localProjects(projects), [{ id: 'fixture-project', label: '합성 로컬 프로젝트' }]);
  assert.deepEqual(localProjects({ projects: [{ ...projects.projects[0], projectId: '../path' }, { ...projects.projects[0], label: 'bad\nlabel' }] }), []);
});
test('bounded shared options cache reads only native metadata/projects, clears old choices on failure, and fresh validation bypasses TTL', async t => {
  const desktop = new MockDesktop(); installOptions(desktop); let now = 100, reads = 0;
  desktop.tools = async ({ refresh }) => { assert.equal(refresh, true); reads++; return desktop.catalog; };
  const options = new Options(desktop, { now: () => now });
  const first = await options.snapshot(); assert.equal(reads, 1);
  assert.equal(first.create.models.length, 2); assert.equal(first.send.models.length, 1); assert.equal(first.source, 'pc-desktop');
  await options.snapshot(); assert.equal(reads, 1);
  assert.ok(!JSON.stringify(first).includes('PRIVATE')); assert.ok(!JSON.stringify(first).includes('SECRET'));
  await options.validate('send', { model: 'fixture-fast', thinking: 'high' }); assert.equal(reads, 2);
  await rejects(options.validate('send', { model: 'fixture-deep' }), 'MODEL_CHOICE_UNAVAILABLE');
  desktop.tools = async () => { throw new Error('PRIVATE_RAW_ERROR'); }; now += 60001;
  const failure = await options.snapshot(); assert.equal(failure.send.available, false); assert.deepEqual(failure.create.models, []); assert.deepEqual(failure.projects.items, []);
  assert.ok(desktop.calls.every(c => c.tool === 'list_projects'));
});
test('send exact optional pairs are revalidated, defaults retain legacy hash/args, and UUID choice changes conflict even after restart', async t => {
  const f = await fixture(t); installOptions(f.desktop);
  const msg = { threadId: 'thread-fixture', requestId: randomUUID(), text: '합성 후속' };
  await f.engine.send(owner, msg);
  assert.equal(f.engine.records[0].payload, hash(JSON.stringify({ id: msg.threadId, message: msg.text })));
  assert.deepEqual(f.desktop.calls.find(c => c.tool === 'send_message_to_thread').args, { threadId: msg.threadId, hostId: 'local', prompt: msg.text });
  await rejects(f.engine.send(owner, { ...msg, model: 'fixture-fast' }), 'REQUEST_ID_CONFLICT');
  const explicit = { ...msg, requestId: randomUUID(), model: 'fixture-fast', thinking: 'high' };
  assert.equal((await f.engine.send(owner, explicit)).state, 'delivered');
  assert.equal(f.desktop.calls.filter(c => c.tool === 'send_message_to_thread').at(-1).args.thinking, 'high');
  const restored = new Engine(f.desktop, f.dir); await restored.send(owner, explicit);
  for (const change of [{ thinking: 'low' }, { model: 'fixture-deep' }, { model: undefined }]) await rejects(restored.send(owner, { ...explicit, ...change }), change.model === undefined && 'model' in change ? 'INVALID_MODEL_CHOICE' : 'REQUEST_ID_CONFLICT');
  const before = f.desktop.calls.filter(c => c.tool === 'send_message_to_thread').length;
  for (const choice of [{ model: 'fixture-fast', thinking: 'ultra' }, { model: 'fixture-deep' }, { model: 'unknown' }]) await rejects(f.engine.send(owner, { ...msg, requestId: randomUUID(), ...choice }), 'MODEL_CHOICE_UNAVAILABLE');
  assert.equal(f.desktop.calls.filter(c => c.tool === 'send_message_to_thread').length, before);
  f.desktop.tools = async () => { throw new Error(); };
  assert.equal((await f.engine.send(owner, { ...msg, requestId: randomUUID() })).state, 'delivered');
});
test('create defaults omit settings, sends unchanged policy, verifies actual local Codex thread, and stores hash-only idempotent owner receipt', async t => {
  const f = await fixture(t); installOptions(f.desktop); const msg = input();
  const result = await f.engine.create(owner, msg); assert.equal(result.state, 'delivered'); assert.equal(result.threadId, 'created-fixture');
  assert.deepEqual(f.desktop.calls.find(c => c.tool === 'create_thread').args, { target: { type: 'projectless' }, prompt: msg.text });
  assert.ok(f.desktop.calls.some(c => c.tool === 'read_thread' && c.args.threadId === 'created-fixture'));
  const count = f.desktop.calls.length; assert.deepEqual(await f.engine.create(owner, msg), result); assert.equal(f.desktop.calls.length, count);
  assert.throws(() => f.engine.receipt(other, msg.requestId), e => e.code === 'REQUEST_NOT_FOUND'); assert.equal(f.engine.creationState(other).request, null);
  await rejects(f.engine.create(other, msg), 'REQUEST_ID_CONFLICT');
  await rejects(f.engine.create(owner, { ...msg, model: 'fixture-fast' }), 'REQUEST_ID_CONFLICT');
  const disk = readFileSync(join(f.dir, 'requests.json'), 'utf8'); assert.ok(!disk.includes(msg.text)); assert.ok(!disk.includes('SECRET')); assert.ok(!disk.includes('projectless'));
  const restored = new Engine(f.desktop, f.dir); assert.deepEqual(await restored.create(owner, msg), result); assert.equal(f.desktop.calls.length, count);
  assert.ok(!f.calls.some(c => /start|resume|fork/.test(c.method)));
});
test('advertised real local thread ID is verified authoritatively without assuming status literals or rejecting a coexisting setup ID', async t => {
  for (const extra of [{}, { status: 'created' }, { status: 'pending' }, { status: { type: 'active' } }, { clientThreadId: 'PRIVATE_CLIENT_ID' }, { status: 'queued', clientThreadId: 'PRIVATE_CLIENT_ID' }]) {
    const f = await fixture(t); installOptions(f.desktop);
    f.desktop.hook = async tool => tool === 'list_projects' ? projects : tool === 'create_thread' ? { threadId: 'created-fixture', hostId: 'local', ...extra } : undefined;
    const msg = input(), receipt = await f.engine.create(owner, msg);
    assert.equal(receipt.state, 'delivered'); assert.equal(receipt.threadId, 'created-fixture');
    assert.equal(f.desktop.calls.filter(c => c.tool === 'read_thread' && c.args.threadId === 'created-fixture').length, 1);
    assert.ok(!f.desktop.calls.some(c => c.args.threadId === 'PRIVATE_CLIENT_ID')); assert.ok(!readFileSync(join(f.dir, 'requests.json'), 'utf8').includes('PRIVATE_CLIENT_ID'));
    const count = f.desktop.calls.length; assert.deepEqual(await new Engine(f.desktop, f.dir).create(owner, msg), receipt); assert.equal(f.desktop.calls.length, count);
  }
  for (const thread of [{ id: 'wrong', kind: 'codex', hostId: 'local' }, { id: 'created-fixture', kind: 'other', hostId: 'local' }, { id: 'created-fixture', kind: 'codex', hostId: 'remote' }]) {
    const f = await fixture(t); installOptions(f.desktop);
    f.desktop.hook = async tool => tool === 'list_projects' ? projects : tool === 'create_thread' ? { threadId: 'created-fixture', hostId: 'local', clientThreadId: 'PRIVATE_CLIENT_ID' } : tool === 'read_thread' ? { thread, turns: [] } : undefined;
    const msg = input(); await rejects(f.engine.create(owner, msg), 'CREATE_UNCERTAIN'); assert.equal(f.engine.receipt(owner, msg.requestId).threadId, null);
    assert.ok(!f.desktop.calls.some(c => c.tool === 'send_message_to_thread' || c.args.threadId === 'PRIVATE_CLIENT_ID'));
  }
});
test('advertised client-only setup results are pending observations without any status requirement, destination read, stored client ID or automatic recreation', async t => {
  for (const extra of [{}, { hostId: 'local' }, { status: 'pending' }, { status: 'ready' }, { status: 'setting-up' }, { threadId: null }]) {
    const f = await fixture(t); installOptions(f.desktop);
    f.desktop.hook = async tool => tool === 'list_projects' ? projects : tool === 'create_thread' ? { clientThreadId: 'PRIVATE_CLIENT_ID', ...extra } : undefined;
    const msg = input(), receipt = await f.engine.create(owner, msg);
    assert.equal(receipt.state, 'pending'); assert.equal(receipt.threadId, null); assert.equal(f.desktop.calls.filter(c => c.tool === 'read_thread').length, 0);
    assert.ok(!JSON.stringify(receipt).includes('CLIENT')); assert.ok(!readFileSync(join(f.dir, 'requests.json'), 'utf8').includes('CLIENT'));
    const restored = new Engine(f.desktop, f.dir); assert.deepEqual(await restored.create(owner, msg), receipt); await rejects(restored.create(owner, input()), 'PREVIOUS_CREATE_UNCERTAIN');
    const count = f.desktop.calls.length; restored.acknowledgeCreation(owner, msg.requestId, { confirmed: true }); assert.equal(f.desktop.calls.length, count);
    assert.equal(f.desktop.calls.filter(c => c.tool === 'create_thread').length, 1);
  }
});
test('explicit creation failures and malformed advertised fields stay uncertain without reading or falling back to setup IDs', async t => {
  const real = { threadId: 'created-fixture', hostId: 'local' };
  for (const result of [null, [], {}, { status: 'ready' }, { status: 'pending' }, { clientThreadId: '' }, { clientThreadId: {} }, { clientThreadId: 'x'.repeat(257) },
    { clientThreadId: 'bad\nid' }, { clientThreadId: 'PRIVATE_CLIENT_ID', hostId: 'remote' }, { ...real, hostId: undefined }, { ...real, hostId: 'remote' },
    { ...real, threadId: '../path', clientThreadId: 'PRIVATE_CLIENT_ID' }, { ...real, threadId: '', clientThreadId: 'PRIVATE_CLIENT_ID' },
    { ...real, success: false }, { ...real, isError: true }, { ...real, error: { message: 'PRIVATE_ERROR' } },
    ...['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'aborted', 'Failed', 'ERROR', ' canceled '].map(status => ({ ...real, status })), { ...real, status: { type: 'failed' } }]) {
    const f = await fixture(t); installOptions(f.desktop);
    f.desktop.hook = async tool => tool === 'list_projects' ? projects : tool === 'create_thread' ? result : undefined;
    const msg = input(); await rejects(f.engine.create(owner, msg), 'CREATE_UNCERTAIN');
    assert.equal(f.engine.receipt(owner, msg.requestId).state, 'uncertain'); assert.equal(f.engine.receipt(owner, msg.requestId).threadId, null);
    assert.equal(f.desktop.calls.filter(c => c.tool === 'read_thread').length, 0);
    await rejects(f.engine.create(owner, input()), 'PREVIOUS_CREATE_UNCERTAIN'); assert.equal(f.desktop.calls.filter(c => c.tool === 'create_thread').length, 1);
  }
});
test('create accepts only current local registered targets and advertised creation pairs, not send-only guesses, paths or environment controls', async t => {
  const f = await fixture(t); installOptions(f.desktop);
  const msg = { ...input(), target: { type: 'project', projectId: 'fixture-project' }, model: 'fixture-deep', thinking: 'ultra' };
  await f.engine.create(owner, msg);
  const args = f.desktop.calls.find(c => c.tool === 'create_thread').args;
  assert.deepEqual(args.target, { type: 'project', projectId: 'fixture-project', environment: { type: 'local' } }); assert.equal(args.model, msg.model); assert.equal(args.thinking, 'ultra');
  for (const target of [{ type: 'cloud' }, { type: 'projectless', cwd: 'D:/arbitrary' }, { type: 'project', projectId: 'fixture-project', environment: { type: 'remote' } }]) await assert.rejects(f.engine.create(owner, { ...input(), target }));
  for (const projectId of ['remote-project', 'cloud-project', 'worktree-project', 'unregistered']) await rejects(f.engine.create(owner, { ...input(), target: { type: 'project', projectId } }), 'PROJECT_UNAVAILABLE');
  await rejects(f.engine.create(owner, { ...input(), model: 'fixture-fast', thinking: 'ultra' }), 'MODEL_CHOICE_UNAVAILABLE');
  assert.equal(f.desktop.calls.filter(c => c.tool === 'create_thread').length, 1);
});
test('create concurrent UUIDs are never queued, timeout/restart stays uncertain, pending client IDs never become destinations; acknowledgement never retries', async t => {
  for (const outcome of ['timeout', 'pending', 'remote', 'mismatch', 'malformed']) {
    const f = await fixture(t); installOptions(f.desktop); let release;
    f.desktop.hook = async (tool, args) => {
      if (tool === 'list_projects') return projects;
      if (tool === 'create_thread') {
        await new Promise(r => { release = r; });
        if (outcome === 'timeout') throw new BridgeError('DESKTOP_TIMEOUT');
        if (outcome === 'pending') return { status: 'pending', clientThreadId: 'PRIVATE_CLIENT_ID' };
        if (outcome === 'malformed') return { status: 'ready' }; // Status alone supplies neither advertised ID shape.
        return { status: 'ready', hostId: outcome === 'remote' ? 'remote' : 'local', threadId: 'created-fixture' };
      }
      if (outcome === 'mismatch' && tool === 'read_thread') return { thread: f.desktop.thread('wrong'), turns: [] };
    };
    const msg = input(), flight = f.engine.create(owner, msg); const observed = flight.catch(e => e);
    await waitFor(() => release);
    assert.equal((await f.engine.create(owner, msg)).state, 'reserved'); await rejects(f.engine.create(owner, input()), 'CREATE_IN_PROGRESS');
    release(); const result = await observed;
    if (outcome === 'pending') assert.equal(result.state, 'pending'); else assert.equal(result.code, 'CREATE_UNCERTAIN');
    const restored = new Engine(f.desktop, f.dir); const receipt = restored.receipt(owner, msg.requestId);
    assert.ok(['pending', 'uncertain'].includes(receipt.state)); assert.equal(receipt.threadId, null);
    assert.ok(!JSON.stringify(receipt).includes('CLIENT')); assert.ok(!readFileSync(join(f.dir, 'requests.json'), 'utf8').includes('CLIENT'));
    assert.ok(!f.desktop.calls.some(c => c.args.threadId === 'PRIVATE_CLIENT_ID'));
    await rejects(restored.create(owner, input()), 'PREVIOUS_CREATE_UNCERTAIN');
    const count = f.desktop.calls.length;
    assert.throws(() => restored.acknowledgeCreation(other, msg.requestId, { confirmed: true }), e => e.code === 'REQUEST_NOT_FOUND');
    assert.throws(() => restored.acknowledgeCreation(owner, msg.requestId, { confirmed: false }), e => e.code === 'CONFIRMATION_REQUIRED');
    assert.equal(restored.acknowledgeCreation(owner, msg.requestId, { confirmed: true }).state, 'acknowledged');
    assert.equal((await restored.create(owner, msg)).state, 'acknowledged'); assert.equal(f.desktop.calls.length, count);
    assert.equal(f.desktop.calls.filter(c => c.tool === 'create_thread').length, 1);
  }
});
test('crashed create reservation blocks recreation, creation/send UUID namespaces conflict, and session invalidation before dispatch rejects without a mutation', async t => {
  const dir = temp(t), msg = input(); saveJson(join(dir, 'requests.json'), [{ kind: 'create', requestId: msg.requestId, owner: owner.id, state: 'reserved', createdAt: 1 }]);
  const desktop = new MockDesktop(); installOptions(desktop); const engine = new Engine(desktop, dir);
  assert.equal(engine.creationState(owner).request.state, 'uncertain'); await rejects(engine.create(owner, input()), 'PREVIOUS_CREATE_UNCERTAIN');
  await rejects(engine.send(owner, { threadId: 'thread-fixture', requestId: msg.requestId, text: msg.text }), 'REQUEST_ID_CONFLICT');
  const f = await fixture(t); installOptions(f.desktop);
  for (const operation of ['create', 'send']) {
    const value = operation === 'create' ? input() : { threadId: 'thread-fixture', requestId: randomUUID(), text: '합성' };
    await rejects(f.engine[operation](owner, value, () => { throw new BridgeError('AUTH_REQUIRED', 401); }), 'AUTH_REQUIRED');
  }
  assert.ok(!f.desktop.calls.some(c => ['create_thread', 'send_message_to_thread'].includes(c.tool)));
});
async function httpFixture(t) {
  const f = await fixture(t); installOptions(f.desktop); const server = createBridge(f);
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1');
  const headers = { Cookie: `${COOKIE}=${paired.token}`, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Codex-CSRF': paired.session.csrf };
  return { ...f, paired, headers, call: (path, opts = {}) => httpCall(server.address().port, path, { headers, ...opts }) };
}
test('options/create HTTP enforce authentication, exact queries, CSRF, owner receipts, bounded fields and no generic tool endpoint', async t => {
  const f = await httpFixture(t);
  for (const path of ['/api/options', '/api/create/state']) {
    assert.equal((await f.call(path, { headers: {} })).status, 401);
    assert.equal((await f.call(path + '?')).status, 400); assert.equal((await f.call(path + '?tool=create_thread')).status, 400);
  }
  const options = await f.call('/api/options'); assert.equal(options.status, 200); assert.equal(options.headers['cache-control'], 'no-store');
  assert.ok(!options.text.includes('PRIVATE')); assert.ok(!options.text.includes('inputSchema'));
  const msg = input();
  assert.equal((await f.call('/api/create', { method: 'POST', data: msg, headers: { ...f.headers, 'X-Codex-CSRF': 'wrong' } })).status, 403);
  assert.equal((await f.call('/api/create?', { method: 'POST', data: msg })).status, 400);
  assert.equal((await f.call('/api/create', { method: 'POST', data: { ...msg, path: 'D:/arbitrary' } })).status, 400);
  assert.equal((await f.call('/api/create', { method: 'POST', data: msg })).json.state, 'delivered');
  assert.equal((await f.call('/api/create', { method: 'POST', data: msg })).json.state, 'delivered');
  assert.equal(f.desktop.calls.filter(c => c.tool === 'create_thread').length, 1);
  assert.equal((await f.call('/api/tools/call', { method: 'POST', data: {} })).status, 404);
});
test('in-flight options logout leaks no result; create/send recheck session before mutation and after delivery without replay', async t => {
  for (const operation of ['options', 'create', 'send', 'create-dispatched']) {
    const f = await httpFixture(t); let release;
    if (operation === 'options' || operation === 'create') f.desktop.tools = async () => { await new Promise(r => { release = r; }); return f.desktop.catalog; };
    else f.desktop.hook = async (tool, args) => {
      if (tool === 'list_projects') return projects;
      if (tool === (operation === 'send' ? 'read_thread' : 'create_thread')) {
        await new Promise(r => { release = r; });
        if (operation === 'create-dispatched') return { status: 'ready', hostId: 'local', threadId: 'created-fixture' };
      }
    };
    const path = operation === 'options' ? '/api/options' : operation === 'send' ? '/api/send' : '/api/create';
    const flight = f.call(path, operation === 'options' ? {} : { method: 'POST', data: operation === 'send' ? { threadId: 'thread-fixture', requestId: randomUUID(), text: '합성' } : input() });
    await waitFor(() => release); f.auth.revoke(f.paired.session); release(); const response = await flight; assert.equal(response.status, 401);
    assert.equal(f.desktop.calls.filter(c => ['create_thread', 'send_message_to_thread'].includes(c.tool)).length, operation === 'create-dispatched' ? 1 : 0);
  }
});
