import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.mjs';
import { browser } from './browser-fixture.mjs';
test('successful read retry clears stale connection error but preserves draft, loaded history and pending uncertainty', async () => {
  const f = await browser(); f.offline(true);
  await assert.rejects(f.ui.refreshCurrent()); f.ui.showError({ code: 'NETWORK' });
  assert.equal(f.el('chatError').hidden, false); assert.equal(f.el('send').disabled, true);
  f.offline(false); f.el('chatError').children[1].onclick();
  await waitFor(() => f.el('chatError').hidden);
  assert.equal(f.el('draft').value, '보존할 한글 초안'); assert.equal(f.el('send').disabled, false);
  assert.equal(f.ui.state.turns.size, 1);
  f.uncertain(true); f.ui.showError({ code: 'SEND_UNCERTAIN' }); await f.ui.refreshCurrent();
  assert.equal(f.el('chatError').hidden, false); assert.equal(f.el('send').disabled, true);
  f.ui.state.pending = { requestId: 'own-request', threadId: 'fixture' };
  f.ui.showError({ code: 'NETWORK' }); await f.ui.refreshCurrent(); assert.equal(f.el('chatError').hidden, false);
});
test('list retry clears offline status; explicit acknowledge preserves draft and never calls send', async () => {
  const f = await browser(); f.offline(true); await f.ui.loadList(); assert.match(f.el('listStatus').textContent, /연결할 수 없습니다/);
  f.offline(false); await f.ui.loadList(); assert.ok(!f.el('listStatus').textContent.includes('연결할 수 없습니다'));
  f.uncertain(true); f.ui.state.pending = { requestId: 'own-request', threadId: 'fixture' };
  f.ui.showError({ code: 'SEND_UNCERTAIN' }); await f.ui.refreshCurrent();
  assert.equal(f.el('sendRecovery').hidden, false);
  await f.el('acknowledgeSend').onclick();
  assert.equal(f.ui.state.pending, null); assert.equal(f.el('draft').value, '보존할 한글 초안');
  assert.equal(f.el('sendRecovery').hidden, true); assert.equal(f.el('chatError').hidden, true);
  assert.equal(f.calls.filter(c => c.path.endsWith('/acknowledge')).length, 1);
  assert.equal(f.calls.filter(c => c.path === '/api/send').length, 0);
});
