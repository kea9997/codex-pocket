import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';
import { deferred } from './accounts-fixture.mjs';

const revision = randomUUID(), nextRevision = randomUUID(), profileId = randomUUID();
function view(fields = {}) {
  return { revision, supported: true, switchSupported: false, switchReason: 'ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE', busy: false, error: null, recovery: false, verification: 'shared-cache-only',
    current: { email: 'sample@example.invalid', plan: 'plus', profileId }, profiles: [{ id: profileId, label: '개인 <문자>', email: 'sample@example.invalid', plan: 'plus', savedAt: 1, current: true }], operation: null, ...fields };
}
async function accountBrowser(options = {}) {
  let result = view(), hook;
  const f = await browser({ ...options, requestHook: async (path, input) => {
    const override = hook && await hook(path, input); if (override) return override;
    if (path === '/api/session') return { data: { csrf: 'fixture-csrf', storageScope: 'a'.repeat(64), accountRevision: revision } };
    if (path === '/api/accounts') return { data: result };
    if (path === '/api/accounts/presence') return { data: { revision: result.revision, busy: result.busy, recovery: result.recovery } };
    return null;
  } });
  await waitFor(() => f.ui.state.creation.checked && !f.ui.state.booting && f.ui.state.accounts.result);
  return { ...f, result(value) { result = value; }, accountHook(value) { hook = value; } };
}
test('human PC completion checkbox uses actual label activation, resets on target change, and binds the chosen target/revision/page to one explicit POST', async () => {
  const f = await accountBrowser(), second = { id: randomUUID(), label: '다른 계정', email: 'other@example.invalid', current: false };
  const result = view({ switchSupported: true, profiles: [...view().profiles, second] }); f.result(result); await f.el('refreshAccounts').onclick();
  f.el('accountProfiles').children[1].choose.click(); assert.equal(f.el('switchAccount').disabled, true);
  const label = f.document.createElement('label'); label.append(f.el('accountPcIdle')); label.click(); assert.equal(f.el('accountPcIdle').checked, true); assert.equal(f.el('switchAccount').disabled, false);
  f.el('accountProfiles').children[0].choose.click(); assert.equal(f.el('accountPcIdle').checked, false); assert.equal(f.el('switchAccount').disabled, true);
  f.el('accountProfiles').children[1].choose.click(); label.click();
  f.accountHook((path, options) => path === '/api/accounts/switch' ? { data: { ...result, operation: { id: JSON.parse(options.body).operationId, kind: 'switch', state: 'completed' } } } : null);
  const action = f.el('switchAccount').click(); assert.equal(f.el('accountConfirmDialog').open, true);
  assert.equal(f.calls.filter(c => c.path === '/api/accounts/switch').length, 0); f.el('approveAccountConfirmation').click(); await action;
  const request = f.calls.find(c => c.path === '/api/accounts/switch'), input = JSON.parse(request.options.body);
  assert.equal(input.profileId, second.id); assert.equal(input.pageId, f.ui.state.accounts.pageId); assert.equal(input.pcTasksComplete, true); assert.equal(input.confirmed, true); assert.equal(request.options.headers['X-Codex-Account-Revision'], revision);
  assert.equal(f.calls.filter(c => c.path === '/api/accounts/switch').length, 1);
});
test('stale recovery can use the freshly reviewed revision without adopting old content or reenabling native writes', async () => {
  const f = await accountBrowser(), draft = f.el('draft').value;
  const recovery = view({ revision: nextRevision, switchSupported: true, recovery: true, error: 'ACCOUNT_RECOVERY_REQUIRED' }); f.result(recovery); await f.el('refreshAccounts').onclick();
  assert.equal(f.ui.state.accounts.stale, true); f.el('accountPcIdle').click(); assert.equal(f.el('keepCurrentAccount').disabled, false);
  f.accountHook((path, options) => path === '/api/accounts/recover' ? { data: { ...recovery, recovery: false, error: null, operation: { id: JSON.parse(options.body).operationId, kind: 'recover', state: 'completed' } } } : null);
  const action = f.el('keepCurrentAccount').click(); assert.equal(f.el('accountConfirmDialog').open, true);
  assert.ok(!f.calls.some(c => c.path === '/api/accounts/recover')); f.el('approveAccountConfirmation').click(); await action;
  const request = f.calls.find(c => c.path === '/api/accounts/recover');
  assert.equal(request.options.headers['X-Codex-Account-Revision'], nextRevision); assert.equal(f.ui.state.accounts.revision, revision); assert.equal(f.ui.state.accounts.stale, true);
  assert.equal(f.el('draft').value, draft); assert.ok(!f.calls.some(c => ['/api/send', '/api/create', '/api/logout'].includes(c.path)));
});
test('device code receives focus once, polling preserves cancel focus, and page exit releases authenticated presence without URLs or beacons', async () => {
  const f = await accountBrowser(), op = { id: randomUUID(), kind: 'login', state: 'waiting', device: { url: 'https://auth.openai.com/codex/device', code: 'DEMO-0000' } };
  f.result(view({ busy: true, operation: op })); await f.el('refreshAccounts').onclick(); assert.equal(f.document.activeElement, f.el('accountDevice'));
  f.el('cancelAccountLogin').focus(); await f.el('refreshAccounts').onclick(); assert.equal(f.document.activeElement, f.el('cancelAccountLogin'));
  f.windowEvents.get('pagehide')(); const request = f.calls.filter(c => c.path === '/api/accounts/presence').at(-1);
  assert.equal(request.options.keepalive, true); assert.equal(JSON.parse(request.options.body).closed, true); assert.equal(request.options.headers['X-Codex-CSRF'], 'fixture-csrf'); assert.equal(request.options.credentials, 'same-origin'); assert.ok(!request.path.includes('?'));
});

test('PC #accounts entry and phone tool use the same responsive pane with explicit unsupported switch explanation and metadata-only memory', async () => {
  const f = await accountBrowser({ initialHash: '#accounts', selected: false });
  assert.equal(f.ui.state.tools.pane, 'accounts'); assert.equal(f.el('toolsDialog').open, true);
  assert.match(f.el('accountCurrent').textContent, /sample@example.invalid/);
  assert.match(f.el('accountSwitchLimit').textContent, /이 설치 환경에서는 계정 전환을 지원하지 않습니다/);
  const row = f.el('accountProfiles').children[0]; row.choose.click(); assert.equal(row.choose.attributes['aria-pressed'], 'true'); assert.equal(f.el('switchAccount').disabled, true);
  assert.ok(!f.calls.some(c => /accounts\/switch/.test(c.path)));
  const stored = [...f.storage.values.values()].join(''); for (const secret of ['sample@example.invalid', profileId, revision, '개인 <문자>']) assert.ok(!stored.includes(secret));
});
test('account operation header is sent on JSON actions and raw upload, without changing existing send payload', async () => {
  const f = await accountBrowser();
  f.el('accountLabel').value = '새 저장';
  f.accountHook((path, input) => path === '/api/accounts/save' ? { data: view({ operation: { id: JSON.parse(input.body).operationId, kind: 'save', state: 'completed' } }) } : null);
  await f.el('saveCurrentAccount').onclick();
  const request = f.calls.find(c => c.path === '/api/accounts/save'); assert.equal(request.options.headers['X-Codex-Account-Revision'], revision); assert.equal(request.options.headers['X-Codex-CSRF'], 'fixture-csrf');
  assert.deepEqual(Object.keys(JSON.parse(request.options.body)).sort(), ['label', 'operationId']);
  f.evaluate("attachments.add('fixture', [new File(['fixture'], 'sample.txt', {type:'text/plain'})])");
  assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].headers['X-Codex-Account-Revision'], revision);
});
test('external account change immediately gates normal/question/create/upload writes, clears usage/model values but preserves pairing and exact draft', async () => {
  const f = await accountBrowser(), draft = f.el('draft').value, csrf = f.ui.state.csrf;
  f.ui.state.usage.result = { fixtureCredit: 'old' }; f.ui.state.models.result = { fixtureModel: 'old' };
  f.result(view({ revision: nextRevision, current: { email: 'different@example.invalid' } })); await f.el('refreshAccounts').onclick();
  assert.equal(f.ui.state.accounts.stale, true); assert.equal(f.ui.state.accounts.revision, revision); assert.equal(f.ui.state.csrf, csrf);
  assert.equal(f.el('draft').value, draft); assert.equal(f.el('draft').disabled, false); assert.equal(f.el('send').disabled, true); assert.equal(f.el('attachFiles').disabled, true); assert.equal(f.el('createChat').disabled, true);
  assert.equal(f.ui.state.models.result, null); assert.equal(f.ui.state.usage.result, null);
  assert.equal(f.evaluate('canSend()'), false); f.evaluate("attachments.add('fixture', [new File(['x'], 'new.txt')])"); assert.equal(f.uploads.length, 0);
  assert.ok(!f.calls.some(c => ['/api/send', '/api/create', '/api/logout', '/api/pair'].includes(c.path)));
});
test('explicit current-account confirmation flushes existing draft, clears stale content, reselects nothing, never reloads/resends/re-pairs', async () => {
  const f = await accountBrowser(); f.ui.state.draftThread = 'fixture'; f.el('draft').value = '정확히 보존할 초안';
  f.result(view({ revision: nextRevision })); await f.el('refreshAccounts').onclick();
  await f.el('confirmAccount').onclick();
  assert.equal(f.ui.state.accounts.stale, false); assert.equal(f.ui.state.accounts.revision, nextRevision); assert.equal(f.ui.state.selected, null);
  assert.equal(f.ui.state.drafts.get('fixture'), '정확히 보존할 초안'); assert.equal(new Map(f.ui.durable.data.drafts).get('fixture'), '정확히 보존할 초안');
  assert.equal(f.el('draft').value, ''); assert.equal(f.navigation.location.reloads, undefined);
  assert.ok(!f.calls.some(c => ['/api/send', '/api/create', '/api/pair', '/api/logout'].includes(c.path)));
});
test('composition, pending request, volatile question/new-chat input and attachment prevent explicit account adoption without clearing content', async () => {
  const f = await accountBrowser(), draft = f.el('draft').value;
  f.result(view({ revision: nextRevision })); await f.el('refreshAccounts').onclick();
  const checks = [
    () => { f.ui.state.composing.add('draft'); return () => f.ui.state.composing.clear(); },
    () => { f.ui.state.pending = { threadId: 'fixture', requestId: randomUUID() }; return () => { f.ui.state.pending = null; }; },
    () => { f.el('newPrompt').value = '아직 저장 안 함'; return () => { f.el('newPrompt').value = ''; }; },
    () => { f.ui.state.questionNodes.set('q', { answer: '원래 답' }); return () => f.ui.state.questionNodes.clear(); },
    () => { f.evaluate("attachments.groups.set('other', [{file:{name:'sample.txt',size:1},status:'cancelled'}])"); return () => f.evaluate('attachments.groups.clear()'); }
  ];
  for (const setup of checks) { const clear = setup(); await f.el('confirmAccount').onclick(); assert.equal(f.ui.state.accounts.revision, revision); assert.equal(f.el('draft').value, draft); clear(); }
});
test('polling account list preserves selected card, DOM focus, input label and scroll; device code and operation state never persist locally', async () => {
  const f = await accountBrowser();
  const row = f.el('accountProfiles').children[0]; row.choose.click(); row.choose.focus(); f.el('accountLabel').value = '작성 중 이름'; f.el('accountProfiles').scrollTop = 120;
  await f.el('refreshAccounts').onclick();
  assert.equal(f.el('accountProfiles').children[0], row); assert.equal(f.document.activeElement, row.choose); assert.equal(f.el('accountLabel').value, '작성 중 이름'); assert.equal(f.el('accountProfiles').scrollTop, 120);
  const code = 'ABCD-1234'; f.result(view({ busy: true, operation: { id: randomUUID(), kind: 'login', state: 'waiting', device: { url: 'https://auth.openai.com/codex/device', code }, expiresAt: Date.now() + 10000 } }));
  await f.el('refreshAccounts').onclick(); assert.equal(f.el('accountDeviceCode').textContent, code); assert.equal(f.el('accountDeviceLink').href, 'https://auth.openai.com/codex/device');
  f.ui.persistDevice(true); assert.ok(![...f.storage.values.values()].join('').includes(code));
  f.ui.showPair(); assert.equal(f.el('accountDeviceCode').textContent, ''); assert.equal(f.ui.state.accounts.result, null); assert.equal(f.ui.state.accounts.revision, null);
});
test('late old usage response cannot repaint after account epoch change; failed/ambiguous account POST is never replayed', async () => {
  const f = await accountBrowser(), gate = deferred();
  f.accountHook(path => path === '/api/usage' ? gate.promise : null);
  const response = f.evaluate("api('/api/usage').catch(e => e.code)");
  f.result(view({ revision: nextRevision })); await f.el('refreshAccounts').onclick(); gate.resolve({ data: { fixtureOldCredit: 'not-to-render' }, headers: { 'X-Codex-Account-Revision': revision } });
  assert.equal(await response, 'STALE_RESPONSE'); assert.equal(f.ui.state.usage.result, null);
  f.ui.showPair();
});
test('login failure has concrete retry status, keeps pairing and allows explicit retry only; no account operation starts during IME composition', async () => {
  const f = await accountBrowser(); let count = 0;
  f.el('accountLabel').value = '다른 계정'; f.ui.state.composing.add('accountLabel'); await f.el('addAccount').onclick(); assert.equal(count, 0); f.ui.state.composing.clear();
  f.accountHook(path => { if (path === '/api/accounts/login') { count++; return { status: 503, data: { error: 'ACCOUNT_DEVICE_UNAVAILABLE' } }; } return null; });
  await f.el('addAccount').onclick(); assert.equal(count, 1); assert.match(f.el('accountStatus').textContent, /공식 기기 코드 로그인을 시작하지 못했습니다/); assert.ok(f.ui.state.csrf);
  await f.el('refreshAccounts').onclick(); assert.equal(count, 1); assert.ok(!f.calls.some(c => ['/api/send', '/api/create', '/api/logout'].includes(c.path)));
});
test('reader reset failure explains the persistent gate and cannot be cleared by explicit account confirmation or refresh', async () => {
  const f = await accountBrowser(), draft = f.el('draft').value, csrf = f.ui.state.csrf;
  f.result(view({ revision: nextRevision, supported: false, error: 'ACCOUNT_READONLY_STOP_FAILED' })); await f.el('refreshAccounts').onclick();
  assert.equal(f.el('confirmAccount').disabled, true); assert.equal(f.el('saveCurrentAccount').disabled, true); assert.equal(f.el('addAccount').disabled, true);
  assert.match(f.el('accountStatus').textContent, /읽기 연결 초기화/); assert.match(f.el('accountStatus').textContent, /재시작/);
  await f.el('confirmAccount').onclick(); assert.equal(f.ui.state.accounts.stale, true); assert.equal(f.ui.state.accounts.revision, revision);
  assert.equal(f.evaluate('accountLocked()'), true); assert.equal(f.el('draft').value, draft); assert.equal(f.ui.state.csrf, csrf);
  assert.ok(!f.calls.some(c => ['/api/send', '/api/create', '/api/logout'].includes(c.path)));
});
test('presence has only bounded booleans/page ID and follows existing polling instead of creating an account interval', async () => {
  const f = await accountBrowser(); await f.evaluate('accountPresence()');
  const requests = f.calls.filter(c => c.path === '/api/accounts/presence'); assert.ok(requests.length);
  for (const c of requests) assert.deepEqual(Object.keys(JSON.parse(c.options.body)).sort(), ['blocked', 'pageId', 'visible']);
  f.ui.state.composing.add('draft'); await f.evaluate('accountPresence()'); assert.equal(JSON.parse(f.calls.filter(c => c.path.endsWith('/presence')).at(-1).options.body).blocked, true);
  assert.ok(![...f.timers.values()].some(timer => timer.ms === 15000));
});
