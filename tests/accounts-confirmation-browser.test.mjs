import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { browser } from './browser-fixture.mjs';
import { waitFor } from './helpers.mjs';
import { deferred } from './accounts-fixture.mjs';

const mutations = f => f.calls.filter(c => /^\/api\/accounts\/(switch|recover|remove)$/.test(c.path));
async function setup(kind = 'switch') {
  const revision = randomUUID(), current = randomUUID(), target = randomUUID(); let hook;
  let result = { revision, supported: true, switchSupported: true, busy: false, recovery: kind.startsWith('recover'), error: null,
    current: { email: 'current@example.invalid', profileId: current }, profiles: [
      { id: current, label: '현재', email: 'current@example.invalid', current: true },
      { id: target, label: '작업 <계정>', email: 'target@example.invalid', current: false }
    ] };
  const f = await browser({ initialHash: '#accounts', asyncHistory: true, selected: !kind.startsWith('recover'), accountRecoveryBoot: kind.startsWith('recover'), requestHook: async (path, input) => {
    const override = hook && await hook(path, input); if (override) return override;
    if (path === '/api/session') return { data: { csrf: 'fixture-csrf', storageScope: 'a'.repeat(64), accountRevision: revision } };
    if (path === '/api/accounts') return { data: result };
    if (path === '/api/accounts/presence') return { data: { revision: result.revision, busy: result.busy, recovery: result.recovery } };
    if (/^\/api\/accounts\/(switch|recover|remove)$/.test(path)) {
      const body = JSON.parse(input.body);
      result = { ...result, recovery: false, operation: { id: body.operationId, kind: path.split('/').at(-1), state: 'completed' } };
      return { data: result };
    }
    return null;
  } });
  await waitFor(() => !f.ui.state.booting && f.ui.state.creation.checked && !f.ui.state.accounts.flight && !f.ui.state.accounts.presenceFlight);
  // Any remaining native confirm in these account flows is an interaction failure, not an automatic Yes.
  f.evaluate('confirm = () => { throw new Error("Native confirmation must not run"); }');
  f.ui.state.draftThread = 'fixture';
  if (kind.startsWith('recover')) { f.el('draft').value = '복구 중에도 보존할 초안'; f.ui.state.drafts.set('fixture', f.el('draft').value); }
  return { ...f, target, revision, result: () => result, change: fields => { result = { ...result, ...fields }; }, accountHook: value => { hook = value; } };
}
function start(f, kind = 'switch') {
  if (!kind.startsWith('recover')) f.el('accountProfiles').children[1].choose.click();
  if (kind !== 'remove' && !f.el('accountPcIdle').checked) f.el('accountPcIdle').click();
  const origin = kind === 'remove' ? f.el('accountProfiles').children[1].removeButton : f.el(kind === 'switch' ? 'switchAccount' : kind === 'recover-rollback' ? 'rollbackAccount' : 'keepCurrentAccount');
  origin.focus(); const action = origin.click();
  assert.equal(f.el('accountConfirmDialog').open, true); assert.equal(mutations(f).length, 0);
  assert.equal(f.document.activeElement, f.el('cancelAccountConfirmation'));
  return { action, origin };
}
for (const kind of ['switch', 'remove', 'recover-rollback', 'recover-keep']) test(`${kind}: in-page target/consequence and explicit Confirm are required; Cancel preserves drafts and a new click is required`, async () => {
  const f = await setup(kind), draft = f.el('draft').value, first = start(f, kind);
  assert.match(f.el('accountConfirmEffect').textContent, kind === 'remove' ? /로그아웃하지 않습니다/ : /휴대폰 연결은 유지/);
  if (!kind.startsWith('recover')) {
    assert.equal(f.el('accountConfirmLabel').textContent, '작업 <계정>'); assert.equal(f.el('accountConfirmEmail').textContent, 'target@example.invalid');
  } else assert.match(f.el('accountConfirmEmail').textContent, kind === 'recover-rollback' ? /복원 후 계정을 확인/ : /current@example.invalid/);
  f.el('cancelAccountConfirmation').click(); await first.action;
  assert.equal(f.el('accountConfirmDialog').open, false); assert.equal(f.el('toolsDialog').open, true);
  assert.equal(f.document.activeElement, first.origin); assert.equal(f.el('draft').value, draft); assert.equal(mutations(f).length, 0);
  f.el('approveAccountConfirmation').click(); assert.equal(mutations(f).length, 0);
  const second = start(f, kind); f.el('approveAccountConfirmation').click(); f.el('approveAccountConfirmation').click(); await second.action;
  assert.equal(mutations(f).length, 1); const body = JSON.parse(mutations(f)[0].options.body);
  assert.equal(body.confirmed, true); assert.equal(mutations(f)[0].options.headers['X-Codex-Account-Revision'], f.revision);
  if (!kind.startsWith('recover')) assert.equal(body.profileId, f.target);
  if (kind !== 'remove') { assert.equal(body.pcTasksComplete, true); assert.equal(body.pageId, f.ui.state.accounts.pageId); }
  assert.equal(f.el('draft').value, draft); assert.equal(f.ui.state.accounts.confirmation, null);
});
for (const exit of ['close-button', 'escape', 'native-back', 'browser-back', 'dialog-close', 'pagehide', 'hidden', 'offline']) test(`account confirmation ${exit} cancels without operation, replay, draft loss or browser-root escape`, async () => {
  const f = await setup(), draft = f.el('draft').value, { action } = start(f);
  if (exit === 'close-button') f.el('closeAccountConfirmation').click();
  else if (exit === 'escape') { const e = { type: 'cancel' }; f.el('accountConfirmDialog').dispatchEvent(e); assert.equal(e.defaultPrevented, true); }
  else if (exit === 'native-back') { f.advance(400); assert.equal(f.window.codexPhoneBack(), 'handled'); assert.equal(f.window.codexPhoneBack(), 'busy'); }
  else if (exit === 'browser-back') f.navigation.history.back();
  else if (exit === 'dialog-close') f.el('accountConfirmDialog').close();
  else if (exit === 'pagehide') { const pending = f.navigation.pending; f.windowEvents.get('pagehide')(); assert.equal(f.navigation.pending, pending); }
  else if (exit === 'hidden') { f.document.hidden = true; f.events.get('visibilitychange')(); }
  else { f.offline(true); f.windowEvents.get('offline')(); }
  if (f.navigation.pending) f.navigation.flush();
  await action; f.el('approveAccountConfirmation').click();
  assert.equal(f.el('accountConfirmDialog').open, false); assert.equal(f.ui.state.accounts.confirmation, null);
  assert.equal(mutations(f).length, 0); assert.equal(f.navigation.rootExits, 0); assert.equal(f.el('draft').value, draft);
  if (['browser-back', 'native-back'].includes(exit)) { f.navigation.history.forward(); f.navigation.flush(); assert.equal(f.el('accountConfirmDialog').open, false); assert.equal(mutations(f).length, 0); }
});
for (const changed of ['session', 'revision', 'target', 'profile-label', 'busy', 'pc-idle', 'input']) test(`changing ${changed} abandons the visible confirmation; old Confirm cannot authorize a POST`, async () => {
  const f = await setup(), { action } = start(f);
  if (changed === 'session') f.ui.showPair('연결 만료');
  else if (changed === 'revision') { f.change({ revision: randomUUID() }); await f.el('refreshAccounts').click(); }
  else if (changed === 'target') f.el('accountProfiles').children[0].choose.click();
  else if (changed === 'profile-label') { f.change({ profiles: f.result().profiles.map(p => p.id === f.target ? { ...p, label: '변경된 이름' } : p) }); await f.el('refreshAccounts').click(); }
  else if (changed === 'busy') { f.change({ busy: true }); await f.el('refreshAccounts').click(); }
  else if (changed === 'pc-idle') f.el('accountPcIdle').click();
  else { f.el('draft').value = '확인 중 바꾼 초안'; f.events.get('input')({ target: f.el('draft') }); }
  await action; f.el('approveAccountConfirmation').click(); assert.equal(mutations(f).length, 0); assert.equal(f.ui.state.accounts.confirmation, null);
  if (changed === 'input') assert.equal(f.el('draft').value, '확인 중 바꾼 초안');
});
for (const changed of ['draft', 'pending', 'creation', 'attachment', 'composition', 'pc-idle', 'revision', 'target', 'cancel', 'back', 'session']) test(`final confirmation revalidates ${changed} after delayed presence and never submits stale intent`, async () => {
  const f = await setup(), gate = deferred(), entered = deferred(), { action } = start(f);
  f.accountHook(path => { if (path === '/api/accounts/presence') { entered.resolve(); return gate.promise; } return null; });
  f.el('approveAccountConfirmation').click(); await entered.promise;
  assert.equal(f.el('approveAccountConfirmation').disabled, true); assert.equal(mutations(f).length, 0);
  if (changed === 'draft') f.el('draft').value = '최종 확인 대기 중 새 초안';
  else if (changed === 'pending') f.ui.state.pending = { requestId: randomUUID(), threadId: 'fixture' };
  else if (changed === 'creation') f.ui.state.creation.receipt = { state: 'uncertain', requestId: randomUUID() };
  else if (changed === 'attachment') f.evaluate("attachments.groups.set('fixture', [{status:'staged',file:{name:'synthetic.txt',size:1}}])");
  else if (changed === 'composition') f.ui.state.composing.add('draft');
  else if (changed === 'pc-idle') f.el('accountPcIdle').checked = false;
  else if (changed === 'revision') { f.change({ revision: randomUUID() }); await f.el('refreshAccounts').click(); }
  else if (changed === 'target') f.el('accountProfiles').children[0].choose.click();
  else if (changed === 'cancel') f.el('cancelAccountConfirmation').click();
  else if (changed === 'back') { f.advance(400); assert.equal(f.window.codexPhoneBack(), 'handled'); f.navigation.flush(); }
  else f.ui.showPair('다른 연결');
  gate.resolve({ data: { revision: f.revision, busy: false, recovery: false } }); await action;
  assert.equal(mutations(f).length, 0); assert.equal(f.ui.state.accounts.confirmation, null);
  if (changed === 'draft') assert.equal(f.el('draft').value, '최종 확인 대기 중 새 초안');
  if (changed === 'pending') assert.ok(f.ui.state.pending);
  if (changed === 'attachment') assert.equal(f.evaluate("attachments.groups.get('fixture').length"), 1);
});
test('unchanged polling keeps confirmation and Cancel focus; a failed account refresh cancels instead of trusting old metadata', async () => {
  const f = await setup(), { action } = start(f);
  await f.el('refreshAccounts').click(); assert.equal(f.el('accountConfirmDialog').open, true); assert.equal(f.document.activeElement, f.el('cancelAccountConfirmation'));
  assert.ok(![...f.storage.values.values()].join('').includes('target@example.invalid'));
  f.accountHook(path => path === '/api/accounts' ? { status: 503, data: { error: 'ACCOUNT_OPERATION_FAILED' } } : null);
  await f.el('refreshAccounts').click(); await action; f.el('approveAccountConfirmation').click(); assert.equal(mutations(f).length, 0);
});
