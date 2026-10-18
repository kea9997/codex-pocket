import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBridge } from '../server/http.mjs';
import { ORIGIN } from '../server/security.mjs';
import { fixture, httpCall } from './helpers.mjs';
import { imageFixture } from './media-fixture.mjs';
import { Questions } from '../server/questions.mjs';
import { questionFixture, thread, turnId } from './questions-fixture.mjs';

async function setup(t) {
  const f = await fixture(t); const server = createBridge(f);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  return { ...f, server, port, call: (path, options) => httpCall(port, path, options) };
}
async function pair(f) {
  const code = JSON.parse(readFileSync(join(f.dir, 'pairing.json'))).code;
  const result = await f.call('/api/pair', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: { code } });
  assert.equal(result.status, 200);
  const cookie = result.headers['set-cookie'][0].split(';')[0];
  const session = await f.call('/api/session', { headers: { Cookie: cookie } });
  return { cookie, csrf: session.json.csrf, setCookie: result.headers['set-cookie'][0] };
}
test('question GET requires authenticated own current history, accepts no path/query/mutation and returns sanitized readonly source data', async t => {
  const f = await setup(t), logs = questionFixture(t), route = `/api/threads/${thread}/questions`;
  f.engine.questions = new Questions({ root: logs.root });
  f.desktop.hook = async (_tool, args) => ({ thread: f.desktop.thread(args.threadId), turns: [{ id: turnId, status: 'inProgress', items: [] }] });
  f.engine.historyRpcFactory = async () => ({ closed: false, close() {}, async request(method, params) { assert.equal(method, 'thread/read'); assert.deepEqual(params, { threadId: thread, includeTurns: false }); return logs.metadata(); } });
  assert.equal((await f.call(route)).status, 401); const auth = await pair(f), headers = { Cookie: auth.cookie };
  assert.equal((await f.call(route, { headers })).json.state, 'unavailable');
  await f.call(`/api/threads/${thread}/history`, { headers }); const result = await f.call(route, { headers });
  assert.equal(result.status, 200); assert.equal(result.json.data[0].state, 'unconfirmed'); assert.ok(!result.text.includes(logs.file)); assert.ok(!result.text.includes('arguments'));
  assert.equal((await f.call(route + '?path=arbitrary.jsonl', { headers })).status, 400);
  assert.equal((await f.call(route, { headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
  const post = { method: 'POST', headers: { ...headers, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Codex-CSRF': auth.csrf }, data: {} };
  assert.equal((await f.call(route, post)).status, 404);
  f.auth.issuePairing(); const other = await pair(f); assert.equal((await f.call(route, { headers: { Cookie: other.cookie } })).json.state, 'unavailable');
  assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread')); assert.equal(f.engine.records.length, 0);
});
test('activity requires authentication, remains strictly readonly and has no production fixture/mutation endpoint', async t => {
  const f = await setup(t);
  assert.equal((await f.call('/api/activity')).status, 401);
  const auth = await pair(f), headers = { Cookie: auth.cookie };
  const result = await f.call('/api/activity', { headers });
  assert.equal(result.status, 200); assert.equal(result.json.available, true);
  assert.equal(result.json.data[0].preview.text, '기존 답변');
  assert.equal(f.engine.readChecks.size, 0);
  await f.call('/api/activity', { headers });
  assert.equal(f.desktop.calls.filter(c => c.tool === 'list_threads').length, 1);
  assert.equal(f.desktop.calls.filter(c => c.tool === 'read_thread').length, 1);
  assert.ok(f.desktop.calls.every(c => ['list_threads', 'read_thread'].includes(c.tool)));
  assert.equal((await f.call('/api/activity?threadId=arbitrary', { headers })).status, 400);
  const post = { method: 'POST', headers: { ...headers, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Codex-CSRF': auth.csrf }, data: {} };
  assert.equal((await f.call('/api/activity', post)).status, 404);
  for (const route of ['/sample/activity', '/sample/runtime', '/sample/recency']) assert.equal((await f.call(route, post)).status, 404);
  assert.equal((await f.call('/sample-controls.js', { headers })).status, 404);
  await f.call('/api/logout', post); assert.equal((await f.call('/api/activity', { headers })).status, 401);
});
test('image GET is authenticated/session-bound, same-origin, opaque and readonly; no client path/query/filename lookup', async t => {
  const f = await setup(t), { file } = imageFixture(t);
  const arbitrary = '/api/media/' + 'a'.repeat(43);
  assert.equal((await f.call(arbitrary)).status, 401);
  const auth = await pair(f), headers = { Cookie: auth.cookie };
  let inspections = 0; const inspect = f.engine.media.inspect.bind(f.engine.media);
  f.engine.media.inspect = value => { inspections++; return inspect(value); };
  assert.equal((await f.call(arbitrary, { headers })).json.error, 'MEDIA_NOT_FOUND'); assert.equal(inspections, 0);
  f.desktop.hook = async (tool, args) => tool === 'read_thread' ? { thread: f.desktop.thread(args.threadId), turns: [{ id: 'image-turn', status: 'completed', items: [{ type: 'imageView', path: file }] }] } : undefined;
  const history = await f.call('/api/threads/thread-fixture/history', { headers });
  const media = history.json.data[0].items[0].media; assert.equal(media.state, 'ready'); assert.ok(!history.text.includes(file));
  const image = await f.call(media.url, { headers }); assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(image.headers['cache-control'], 'no-store');
  assert.equal(image.headers['x-content-type-options'], 'nosniff'); assert.equal(image.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(image.headers['content-disposition'], 'inline'); assert.match(image.headers['content-security-policy'], /img-src 'self'/);
  assert.equal((await f.call(media.url + '?path=' + encodeURIComponent(file), { headers })).status, 400);
  assert.equal((await f.call(media.url + '/image.png', { headers })).status, 404);
  // Encoded separators are rejected by the existing strict URL guard before route lookup.
  assert.equal((await f.call('/api/media?path=' + encodeURIComponent(file), { headers })).status, 400);
  assert.equal((await f.call('/api/media?path=arbitrary.png', { headers })).status, 404);
  assert.equal((await f.call(media.url, { headers: { ...headers, Host: 'evil.invalid' } })).status, 403);
  assert.equal((await f.call(media.url, { headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
  f.auth.issuePairing(); const other = await pair(f);
  assert.equal((await f.call(media.url, { headers: { Cookie: other.cookie } })).json.error, 'MEDIA_NOT_FOUND');
  const post = { method: 'POST', headers: { ...headers, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Codex-CSRF': auth.csrf }, data: {} };
  assert.equal((await f.call(media.url, post)).status, 404);
  await f.call('/api/logout', post); assert.equal(f.engine.media.entries.size, 0);
  assert.equal((await f.call(media.url, { headers })).status, 401);
  assert.ok(f.desktop.calls.every(c => c.tool === 'read_thread'));
});
test('health is minimal, thread/history and removed event paths expose no data without auth', async t => {
  const f = await setup(t);
  assert.deepEqual((await f.call('/health')).json, { service: 'codex-phone', ok: true });
  for (const path of ['/api/threads', '/api/threads/thread-fixture/history', '/api/threads/thread-fixture/events'])
    assert.equal((await f.call(path)).status, 401);
  const auth = await pair(f);
  for (const path of ['/server/main.mjs', '/tools/schema/ClientRequest.json', '/api/fs', '/api/rpc', '/api/threads/../../config']) {
    const res = await f.call(path, { headers: { Cookie: auth.cookie } }); assert.notEqual(res.status, 200);
  }
  assert.match(auth.setCookie, /HttpOnly/); assert.match(auth.setCookie, /SameSite=Strict/); assert.ok(!auth.setCookie.includes('Secure'));
});
test('mutations enforce CSRF and exact origin independently; no CORS headers and untrusted Host rejected', async t => {
  const f = await setup(t), auth = await pair(f);
  const headers = { Cookie: auth.cookie, 'Content-Type': 'application/json' };
  assert.equal((await f.call('/api/logout', { method: 'POST', headers, data: {} })).json.error, 'ORIGIN_REQUIRED');
  assert.equal((await f.call('/api/logout', { method: 'POST', headers: { ...headers, Origin: ORIGIN }, data: {} })).json.error, 'CSRF_REJECTED');
  assert.equal((await f.call('/api/logout', { method: 'POST', headers: { ...headers, Origin: 'https://evil.invalid', 'X-Codex-CSRF': auth.csrf }, data: {} })).status, 403);
  const foreign = await f.call('/api/threads', { headers: { Cookie: auth.cookie, Host: 'evil.invalid' } });
  assert.equal(foreign.status, 403); assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.call('/health', { method: 'OPTIONS' })).status, 405);
});
test('body limit, JSON content type, input allowlist and redacted error responses', async t => {
  const f = await setup(t), auth = await pair(f);
  const headers = { Origin: ORIGIN, Cookie: auth.cookie, 'X-Codex-CSRF': auth.csrf, 'Content-Type': 'application/json' };
  assert.equal((await f.call('/api/send', { method: 'POST', headers, data: 'x'.repeat(65537) })).status, 413);
  assert.equal((await f.call('/api/send', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, data: '{}' })).status, 415);
  assert.equal((await f.call('/api/send', { method: 'POST', headers, data: '{' })).status, 400);
  assert.equal((await f.call('/api/send', { method: 'POST', headers, data: { command: 'anything' } })).json.error, 'INVALID_FIELDS');
  const error = await f.call('/api/threads/thread-fixture/history?cursor=' + 'x'.repeat(4100), { headers: { Cookie: auth.cookie } });
  assert.equal(error.status, 400); assert.ok(!error.text.includes('fixture-private-error'));
});
test('HTTP sends to existing ID once, returns delivery receipt and polls actual native history/status', async t => {
  const f = await setup(t), auth = await pair(f);
  const headers = { Origin: ORIGIN, Cookie: auth.cookie, 'X-Codex-CSRF': auth.csrf, 'Content-Type': 'application/json' };
  const msg = { threadId: 'thread-fixture', requestId: randomUUID(), text: '후속' };
  const sent = await f.call('/api/send', { method: 'POST', headers, data: msg });
  assert.equal(sent.status, 200); assert.equal(sent.json.state, 'delivered');
  assert.equal((await f.call('/api/send', { method: 'POST', headers, data: msg })).json.state, 'delivered');
  assert.equal(f.desktop.calls.filter(c => c.tool === 'send_message_to_thread').length, 1);
  const receipt = await f.call(`/api/requests/${msg.requestId}`, { headers: { Cookie: auth.cookie } });
  assert.equal(receipt.json.state, 'delivered');
  f.desktop.status = 'active';
  const meta = await f.call('/api/threads/thread-fixture', { headers: { Cookie: auth.cookie } });
  assert.equal(meta.json.thread.status, 'active'); assert.equal(meta.json.capability.approvalsOnPc, true);
  assert.equal((await f.call('/api/threads/thread-fixture/history', { headers: { Cookie: auth.cookie } })).status, 200);
  for (const path of ['/api/threads/thread-fixture/events', '/api/threads/thread-fixture/approvals'])
    assert.equal((await f.call(path, { headers: { Cookie: auth.cookie } })).status, 404);
  for (const path of ['/api/approval', '/api/interrupt', '/api/rpc', '/api/tools/call'])
    assert.equal((await f.call(path, { method: 'POST', headers, data: {} })).status, 404);
  assert.ok(!f.calls.some(c => c.method === 'turn/start'));
});
test('64KiB send transport accepts 16000 Korean UTF16 chars, rejects char/byte overflow and retains tiny pair limit', async t => {
  const f = await setup(t), auth = await pair(f);
  const headers = { Origin: ORIGIN, Cookie: auth.cookie, 'X-Codex-CSRF': auth.csrf, 'Content-Type': 'application/json' };
  const msg = { threadId: 'thread-fixture', requestId: randomUUID(), text: '한'.repeat(16000) };
  assert.equal((await f.call('/api/send', { method: 'POST', headers, data: msg })).status, 200);
  assert.equal((await f.call('/api/send', { method: 'POST', headers, data: { ...msg, requestId: randomUUID(), text: '한'.repeat(16001) } })).json.error, 'INVALID_INPUT');
  assert.equal((await f.call('/api/send', { method: 'POST', headers, data: 'x'.repeat(65537) })).status, 413);
  assert.equal((await f.call('/api/pair', { method: 'POST', headers, data: { code: 'x'.repeat(256) } })).status, 413);
  assert.equal(f.desktop.calls.filter(c => c.tool === 'send_message_to_thread').length, 1);
});
test('acknowledge is authenticated, CSRF protected, exact own request/thread and requires actual current history', async t => {
  const f = await setup(t), auth = await pair(f);
  const headers = { Origin: ORIGIN, Cookie: auth.cookie, 'X-Codex-CSRF': auth.csrf, 'Content-Type': 'application/json' };
  const msg = { threadId: 'thread-fixture', requestId: randomUUID(), text: '모의 불명 전송' };
  f.desktop.hook = async tool => { if (tool === 'send_message_to_thread') throw new Error('mock failure'); };
  assert.equal((await f.call('/api/send', { method: 'POST', headers, data: msg })).json.error, 'SEND_UNCERTAIN');
  const path = `/api/requests/${msg.requestId}/acknowledge`, data = { threadId: msg.threadId, confirmed: true };
  assert.equal((await f.call(path, { method: 'POST', headers: { Origin: ORIGIN }, data })).status, 401);
  assert.equal((await f.call(path, { method: 'POST', headers: { Origin: ORIGIN, Cookie: auth.cookie }, data })).status, 403);
  assert.equal((await f.call(path, { method: 'POST', headers, data })).json.error, 'READ_CURRENT_THREAD_FIRST');
  await f.call(`/api/threads/${msg.threadId}/history`, { headers: { Cookie: auth.cookie } });
  assert.equal((await f.call(path, { method: 'POST', headers, data: { ...data, threadId: 'wrong' } })).status, 404);
  const before = f.desktop.calls.length;
  assert.equal((await f.call(path, { method: 'POST', headers, data })).json.state, 'acknowledged');
  assert.equal(f.desktop.calls.length, before);
  assert.equal((await f.call('/api/send', { method: 'POST', headers, data: msg })).json.state, 'acknowledged');
  assert.equal(f.desktop.calls.length, before);
});
test('logout revokes cookie and subsequent polling requires new pairing', async t => {
  const f = await setup(t), auth = await pair(f);
  const result = await f.call('/api/logout', { method: 'POST', headers: { Cookie: auth.cookie, Origin: ORIGIN,
    'X-Codex-CSRF': auth.csrf, 'Content-Type': 'application/json' }, data: {} }); assert.equal(result.status, 200);
  assert.equal((await f.call('/api/threads', { headers: { Cookie: auth.cookie } })).status, 401);
});
test('served UI has strict CSP and no inline script, styles, remote dependencies, raw HTML injection or native JS bridge', async t => {
  const f = await setup(t); const page = await f.call('/');
  assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.ok(!page.text.includes('<script>')); assert.ok(!page.text.includes('onclick='));
  const js = await f.call('/app.js'); assert.ok(!js.text.includes('innerHTML')); assert.ok(!js.text.includes('eval('));
  for (const removed of ['desktopClosed', 'EventSource', '/api/interrupt', '/api/approval']) assert.ok(!js.text.includes(removed));
  assert.match(js.text, /crypto.getRandomValues/); assert.match(js.text, /document.execCommand\('copy'\)/);
  assert.match(js.text, /document.hidden/); assert.match(js.text, /2000 : 8000/);
  assert.ok(!page.text.includes('id="stop"')); assert.ok(!page.text.includes('id="approvals"'));
  const java = readFileSync(new URL('../android/app/src/main/java/kr/optiwork/codexphone/MainActivity.java', import.meta.url), 'utf8');
  assert.ok(!java.includes('addJavascriptInterface')); assert.ok(!java.includes('handler.proceed'));
  assert.match(java, /setAllowFileAccess\(false\)/); assert.match(java, /getPort\(\) == PocketConfig.PORT/);
});
