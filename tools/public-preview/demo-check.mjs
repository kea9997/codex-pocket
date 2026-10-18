import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createDemo } from './demo.mjs';
import { tokenActivity } from './token-usage.mjs';

export function call(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json, headers: res.headers }); });
    });
    req.on('error', reject); req.end(body);
  });
}
test('synthetic demo serves only fixed web assets and finite fixtures on loopback, never production mutations', async t => {
  const server = createDemo(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const get = (path, headers) => call(port, path, { headers });
  const page = await get('/'); assert.equal(page.status, 200); assert.match(page.text, /Synthetic Preview/); assert.doesNotMatch(page.text, /__WEB_REVISION__/);
  for (const path of ['/app.js', '/convenience.js', '/accounts.js', '/markdown-blocks.js', '/device-state.js', '/uploads.js', '/style.css', '/demo-controls.js']) assert.equal((await get(path)).status, 200);
  assert.equal((await get('/demo.mjs')).status, 404); assert.equal((await get('/../package.json')).status, 404);
  assert.equal((await get('/', { Host: 'remote.invalid' })).status, 403); assert.equal((await get('/', { Origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await get('/api/accounts')).json.supported, false);
  assert.equal((await get('/api/threads/demo-chat')).json.capability.continuationEnabled, false);
  assert.equal((await get('/api/threads/demo-chat/history')).json.data.length, 1);
  assert.match((await get('/api/media/demo-image')).text, /GENERATED DEMO/);
  for (const path of ['/api/send', '/api/create', '/api/upload', '/api/accounts/login', '/native/notifications/start']) assert.equal((await call(port, path, { method: 'POST', body: '{}', headers: { Origin: origin } })).status, 403);
  assert.equal((await call(port, '/demo/scenario', { method: 'POST', body: '{}' })).status, 403);
  const observations = [(await get('/api/usage')).json];
  for (let n = 0; n < 7; n++) {
    assert.equal((await call(port, '/demo/scenario', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Preview-Action': 'synthetic' }, body: '{}' })).status, 200);
    observations.push((await get('/api/usage')).json);
  }
  assert.equal(observations[0].tokenActivity.lifetimeTokens, 1234567); assert.equal(observations[1].tokenActivity.lifetimeTokens, 0);
  assert.equal(observations[2].tokenActivity.state, 'unknown'); assert.equal(observations[3].tokenActivity.state, 'unsupported'); assert.equal(observations[4].tokenActivity.state, 'unavailable'); assert.equal(observations[5].tokenActivity.stale, true);
  assert.ok(observations[6].buckets[0].primary.resetsAt * 1000 < Date.now()); assert.equal(observations[7].tokenActivity.daily[0].startDate, '2026-06-18'); assert.equal(observations[7].buckets[0].primary.resetsAt, null);
});
test('bounded account activity parser keeps zero, unknown and actual provided dates without quota estimates', () => {
  assert.deepEqual(tokenActivity({ summary: { lifetimeTokens: 0 }, dailyUsageBuckets: [{ startDate: '2026-02-29', tokens: 999 }] }), { lifetimeTokens: 0, peakDailyTokens: null, daily: [] });
  assert.equal(tokenActivity({ summary: { lifetimeTokens: Number.MAX_SAFE_INTEGER + 1 } }).lifetimeTokens, null);
  assert.equal(tokenActivity({ dailyUsageBuckets: [{ startDate: '2024-02-29', tokens: 42 }] }).daily[0].tokens, 42);
});
