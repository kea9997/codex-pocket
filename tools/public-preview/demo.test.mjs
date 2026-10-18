// Source-tree route test. The portable test template is demo-check.mjs, exported as demo.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createDemo } from './demo.mjs';

test('public demo source has no live transport and rejects native/account/send writes before reading a body', async t => {
  const server = createDemo(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.end();
  });
  assert.equal((await call('/api/threads/demo-chat')).data.capability.continuationEnabled, false);
  assert.equal((await call('/api/accounts')).data.supported, false);
  for (const path of ['/api/send', '/api/create', '/api/accounts/login', '/api/upload', '/native/files/cancel']) assert.equal((await call(path, 'POST')).status, 403);
});
