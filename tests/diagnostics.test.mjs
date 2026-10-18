import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBridge } from '../server/http.mjs';
import { fixture, httpCall } from './helpers.mjs';

test('diagnostics is shared single-flight/8s cached and probes only bounded allowlisted desktop list and readonly thread/list', async t => {
  const f = await fixture(t); let now = 1, release;
  f.engine.now = () => now;
  f.desktop.hook = async (tool, args) => { assert.equal(tool, 'list_threads'); assert.deepEqual(args, { limit: 50 }); await new Promise(resolve => { release = resolve; }); return { threads: [], pinnedThreads: [] }; };
  const first = f.engine.diagnostics(), second = f.engine.diagnostics(); assert.equal(first, second); release();
  const result = await first;
  assert.deepEqual(result, { checkedAt: 1, bridge: 'available', desktop: 'available', readonly: 'available', desktopSuccessAt: 1, readonlySuccessAt: 1 });
  assert.equal(f.desktop.calls.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'thread/list'); assert.equal(f.calls[0].params.limit, 1);
  await f.engine.diagnostics(); assert.equal(f.desktop.calls.length, 1);
  now += 8001; f.desktop.hook = async () => { throw new Error('SECRET-account-C:/private/path'); };
  f.rpc.request = async () => { throw new Error('SECRET-token'); };
  const failed = await f.engine.diagnostics(); assert.equal(failed.desktop, 'unavailable'); assert.equal(failed.readonly, 'unavailable');
  assert.equal(failed.desktopSuccessAt, 1); assert.equal(failed.readonlySuccessAt, 1);
  assert.ok(!JSON.stringify(failed).includes('SECRET')); assert.equal(f.engine.records.length, 0);
});
test('diagnostic desktop last success includes actual read, not merely socket presence; missing readonly source is not invented health', async t => {
  const f = await fixture(t); let now = 100; f.engine.now = () => now;
  await f.engine.desktopRead('original'); assert.equal(f.engine.desktopSuccessAt, 100);
  now = 200; f.engine.historyRpcFactory = null; f.engine.recent = null; f.desktop.hook = async () => { throw new Error('offline'); };
  const result = await f.engine.diagnostics(); assert.equal(result.desktop, 'unavailable'); assert.equal(result.desktopSuccessAt, 100); assert.equal(result.readonly, 'unsupported'); assert.equal(result.readonlySuccessAt, null);
});
test('diagnostics endpoint requires authentication, strict no-query GET and returns no tokens, account data, paths, thread text or errors', async t => {
  const f = await fixture(t), server = createBridge(f); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, options) => httpCall(server.address().port, path, options);
  assert.equal((await call('/api/diagnostics')).status, 401); assert.equal(f.desktop.calls.length, 0);
  const paired = f.auth.pair(JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code, '127.0.0.1'), headers = { Cookie: `codex_phone=${paired.token}` };
  for (const query of ['?threadId=other', '?path=secret', '?retry=1', '?x=1&x=2']) assert.equal((await call('/api/diagnostics' + query, { headers })).status, 400);
  const result = await call('/api/diagnostics', { headers }); assert.equal(result.status, 200); assert.equal(result.json.desktop, 'available');
  assert.deepEqual(Object.keys(result.json).sort(), ['bridge', 'checkedAt', 'desktop', 'desktopSuccessAt', 'readonly', 'readonlySuccessAt']);
  for (const hidden of [paired.token, paired.session?.csrf, 'PC 실시간 제목', 'thread-fixture', 'C:/', 'D:/', 'account', 'error']) if (hidden) assert.ok(!result.text.includes(hidden));
  assert.equal((await call('/api/diagnostics', { method: 'POST', headers })).status, 403); assert.equal(f.engine.records.length, 0);
});
