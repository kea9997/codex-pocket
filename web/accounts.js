'use strict';
function newAccountState() { return { revision: null, pageId: uuid(), epoch: 0, stale: false, busy: false, result: null, flight: null, presenceFlight: null, failed: false, selected: null, message: '', rename: null, confirmation: null }; }
// Shared PC/phone picker. Tokens and cached credentials never enter this module or DeviceState.
const accountMessages = {
  ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE: '이 설치 환경에서는 계정 전환을 지원하지 않습니다. PC 로그인은 변경하지 않습니다.',
  ACCOUNT_CACHE_BUSY: '다른 프로그램이 인증 파일을 사용 중입니다. PC 작업을 마친 뒤 다시 시도해 주세요.',
  ACCOUNT_BUSY: '다른 계정 작업을 처리 중입니다. 완료 후 다시 확인해 주세요.',
  ACCOUNT_CHANGED: 'PC 로그인이 바뀌었습니다. 현재 계정을 확인한 뒤 다시 선택해 주세요.',
  ACCOUNT_STORAGE_UNSUPPORTED: '파일 기반 ChatGPT 로그인만 지원합니다. 사용자 지정 CODEX_HOME·키링·관리 정책·다른 공급자 설정은 변경하지 않습니다.',
  ACCOUNT_CACHE_UNSUPPORTED: '지원하는 ChatGPT 로그인 파일을 확인하지 못했습니다. PC의 로그인 방식과 정책을 확인해 주세요.',
  ACCOUNT_STORAGE_UNSAFE: '계정 저장 경로 또는 현재 사용자 전용 권한을 확인하지 못했습니다. PC에서 저장소를 점검해 주세요.',
  ACCOUNT_STORE_UNREADABLE: '저장한 계정을 복호화하지 못했습니다. 다른 Windows 사용자·손상된 저장소를 덮어쓰지 않았습니다.',
  ACCOUNT_ALREADY_SAVED: '같은 계정·작업 공간이 이미 저장되어 있습니다. 기존 항목을 사용해 주세요.',
  ACCOUNT_ALREADY_CURRENT: '이미 현재 공유 로그인인 계정입니다. 이전에 저장한 토큰으로 되돌리지 않았습니다.',
  ACCOUNT_PROFILE_LIMIT: '계정은 최대 8개입니다. 사용하지 않는 저장 항목을 먼저 제거해 주세요.',
  ACCOUNT_LABEL_INVALID: '계정 이름은 일반 문자로 1~40자 입력해 주세요.',
  ACCOUNT_TASKS_ACTIVE: 'Codex 작업 또는 사용자 확인 대기가 있습니다. PC에서 마친 뒤 다시 전환해 주세요.',
  ACCOUNT_TASKS_UNKNOWN: '모든 Codex 작업의 유휴 상태를 확인할 수 없습니다. PC에서 작업을 마치고 Codex 앱을 직접 닫은 뒤 다시 전환해 주세요.',
  ACCOUNT_DESKTOP_CLOSE_REQUIRED: 'PC Codex가 완전히 닫히지 않았습니다. 강제 종료하지 않았습니다. 직접 닫은 뒤 다시 시도해 주세요.',
  ACCOUNT_REQUESTS_UNRESOLVED: '기존 전송·생성 결과를 먼저 확인해 주세요. 불명 요청을 자동 재전송하거나 해제하지 않습니다.',
  ACCOUNT_ATTACHMENTS_PRESENT: 'PC에 보관 중인 미전송 첨부가 있습니다. 원래 화면에서 완료하거나 직접 제거해 주세요.',
  ACCOUNT_OTHER_PAGE_BUSY: '다른 PC·휴대폰 화면에 미저장 입력이나 확인할 작업이 있습니다. 해당 화면에서 정리하고 다시 확인해 주세요.',
  ACCOUNT_PAGE_NOT_READY: '이 화면의 입력·첨부·전송을 먼저 정리하고 다시 시도해 주세요.',
  ACCOUNT_TRANSFER_BUSY: '파일 저장·공유 전송을 먼저 완료하거나 취소해 주세요.',
  ACCOUNT_DEVICE_UNAVAILABLE: '공식 기기 코드 로그인을 시작하지 못했습니다. 설치본 또는 계정 정책에서 지원하는지 PC에서 확인해 주세요. 보안 설정은 변경하지 않습니다.',
  ACCOUNT_DEVICE_FAILED: '로그인이 완료되지 않았습니다. 현재 PC 로그인은 유지됩니다. 직접 다시 추가할 수 있습니다.',
  ACCOUNT_LOGIN_EXPIRED: '로그인 시간이 만료되었습니다. 현재 PC 로그인은 유지됩니다. 다시 추가해 주세요.',
  ACCOUNT_OPERATION_CANCELLED: '계정 추가를 취소했습니다. 현재 PC 로그인은 변경하지 않았습니다.',
  ACCOUNT_LOGIN_CLEANUP_REQUIRED: '이전 계정 추가의 임시 로그인 정리를 확인해야 합니다. 새 로그인을 시작하거나 임시 파일을 임의 삭제하지 말고 PC에서 점검해 주세요.',
  ACCOUNT_CACHE_CHANGED: '처리 중 PC 인증 파일이 바뀌었습니다. 새 로그인이나 갱신 토큰을 덮어쓰지 않았습니다. 현재 계정을 다시 확인해 주세요.',
  ACCOUNT_RECOVERY_REQUIRED: '계정 전환 확인이 끝나지 않아 전송을 보호하고 있습니다. PC 상태를 확인한 뒤 아래 복구를 직접 선택해 주세요.',
  ACCOUNT_APP_UNAVAILABLE: '정확한 현재 사용자용 Codex 앱 설치·프로세스를 확인하지 못했습니다. 다른 앱을 실행하거나 종료하지 않았습니다.',
  ACCOUNT_APP_UNCONFIRMED: 'Codex 앱 재시작을 확인하지 못했습니다. 선택한 계정이 적용되었다고 확정하지 않았습니다.',
  ACCOUNT_LOGIN_UNCONFIRMED: '재시작 뒤 공유 로그인 확인이 일치하지 않았습니다. PC에서 계정을 확인해 주세요.',
  ACCOUNT_READONLY_STOP_FAILED: '이전 계정의 읽기 연결 초기화를 확인하지 못해 계정 작업과 전송을 차단했습니다. PC에서 브리지 연결을 점검하고 재시작한 뒤 현재 계정을 다시 확인해 주세요.',
  ACCOUNT_RATE_LIMIT: '짧은 시간에 계정 작업이 많았습니다. 잠시 뒤 직접 다시 시도해 주세요.'
};
function accountText(code) { return accountMessages[code] || '계정 작업을 완료하지 못했습니다. 현재 계정과 처리 상태를 다시 확인해 주세요.'; }
function accountLocked() { const a = state.accounts; return Boolean(a.revision && (a.stale || a.busy || a.result?.recovery || a.result?.error === 'ACCOUNT_READONLY_STOP_FAILED')); }
function accountChanged() {
  const a = state.accounts; if (!a.revision || a.stale) return;
  a.stale = true; a.epoch++; stopReveal(); clearUsage(); state.models.result = null;
  state.capability = {}; state.connected = false; state.epoch++; composerState(); creationState(); renderAccounts();
}
function accountLossReason() {
  if (!state.csrf || state.booting || state.loggingOut || navigator.onLine === false || state.recovery.gated || state.recovery.suspended) return '연결 확인을 마친 뒤 다시 시도해 주세요.';
  if (state.composing.size) return '글자 입력을 마친 뒤 전환해 주세요.';
  if (state.sending || state.serverSending || state.pending || state.acknowledging || state.capability.uncertain || state.recoverRequest || state.creation.busy || state.creation.checking || !state.creation.checked || state.creation.message || ['reserved', 'pending', 'uncertain'].includes(state.creation.receipt?.state)) return '전송·새 대화 생성 결과를 먼저 확인해 주세요.';
  if ([...attachments.groups.values()].some(rows => rows.length)) return '첨부를 먼저 완료하거나 직접 제거해 주세요.';
  if (state.transferBusy) return '파일 저장·공유 전송을 먼저 완료하거나 취소해 주세요.';
  if ($('newPrompt').value || $('snippetLabel').value || $('snippetText').value || [...state.questionNodes.values()].some(ui => ui.answer)) return '새 대화·빠른 지시·질문에 작성 중인 입력을 먼저 저장하거나 정리해 주세요.';
  if (state.savedDevice === false) return '초안을 기기에 저장하지 못했습니다. 중요한 내용을 복사하고 저장 공간을 확인해 주세요.';
  return '';
}
function flushAccountDrafts() {
  syncEditor(); persistDevice(true);
  const saved = new Map(durable.data.drafts);
  return state.savedDevice && ![...state.drafts].some(([id, text]) => text && saved.get(id) !== text) && state.snippets.length === durable.data.snippets.length;
}
function validAccounts(value) {
  const id = s => typeof s === 'string' && /^[a-f0-9-]{36}$/.test(s), line = (s, max) => typeof s === 'string' && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
  return value && id(value.revision) && typeof value.busy === 'boolean' && typeof value.supported === 'boolean' && typeof value.recovery === 'boolean' &&
    (!value.current || line(value.current.email, 254)) && Array.isArray(value.profiles) && value.profiles.length <= 8 &&
    value.profiles.every(p => id(p.id) && line(p.label, 40) && p.label && line(p.email, 254)) && new Set(value.profiles.map(p => p.id)).size === value.profiles.length &&
    (!value.operation || id(value.operation.id) && ['working', 'waiting', 'completed', 'failed'].includes(value.operation.state) &&
      (!value.operation.device || value.operation.device.url === 'https://auth.openai.com/codex/device' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value.operation.device.code)));
}
function receiveAccounts(result) {
  const a = state.accounts;
  if (!validAccounts(result)) throw { code: 'ACCOUNT_RESPONSE_INVALID' };
  if (a.result?.revision !== result.revision) $('accountPcIdle').checked = false;
  a.result = result; a.busy = result.busy;
  if (a.revision && a.revision !== result.revision) accountChanged();
  a.failed = false;
  if (!result.profiles.some(p => p.id === a.selected)) a.selected = null;
  renderAccounts(); composerState(); creationState();
}
async function refreshAccounts() {
  const a = state.accounts;
  if (!state.csrf || document.hidden || navigator.onLine === false || a.flight) return a.flight;
  const auth = state.authEpoch;
  a.flight = api('/api/accounts').then(result => { if (a === state.accounts && auth === state.authEpoch) receiveAccounts(result); }).catch(e => {
    if (a === state.accounts && auth === state.authEpoch) { a.failed = true; a.message = e.code === 'NETWORK' ? '계정 정보를 확인하지 못했습니다. 이전 정보로 전환하지 않습니다. 다시 확인해 주세요.' : accountText(e.code); renderAccounts(); }
  }).finally(() => { if (a === state.accounts) { a.flight = null; renderAccounts(); } });
  renderAccounts(); return a.flight;
}
function renderAccounts() {
  const a = state.accounts, r = a.result, op = r?.operation;
  if (a.confirmation && !accountConfirmationValid(a.confirmation)) cancelAccountConfirmation();
  setText($('listAccounts'), a.stale ? '계정 확인 필요' : a.busy ? '계정 처리 중' : '계정');
  $('accountCurrent').textContent = r?.current ? `PC 공유 로그인 · ${r.current.email}${r.current.plan ? ' · ' + r.current.plan : ''}` : 'PC 공유 로그인을 아직 확인하지 못했습니다.';
  $('accountVerification').textContent = r?.verification === 'shared-login-and-restarted-app' ? '공유 로그인과 Codex 앱 재시작을 확인했습니다. Desktop 내부 계정 직접 조회 API는 제공되지 않습니다.' : '공유 인증 파일 기준입니다. 실행 중인 Desktop 내부 계정까지 확인한 표시는 아닙니다.';
  const existing = new Map(Array.from($('accountProfiles').children).map(row => [row.profileId, row]));
  const rows = (r?.profiles || []).map(p => {
    let row = existing.get(p.id);
    if (!row) {
      row = node('div', undefined, 'account-row'); row.profileId = p.id;
      row.choose = node('button'); row.choose.type = 'button';
      row.choose.onclick = () => { if (a !== state.accounts) return; a.selected = p.id; a.rename = null; a.message = ''; $('accountPcIdle').checked = false; renderAccounts(); };
      row.rename = node('button', '이름 수정'); row.rename.type = 'button';
      row.rename.onclick = () => {
        const current = a.result?.profiles.find(v => v.id === p.id); if (!current || a !== state.accounts) return;
        a.rename = p.id; $('accountLabel').value = current.label; $('accountLabel').closest('details').open = true; renderAccounts();
        $('accountLabel').focus({ preventScroll: true }); $('accountLabel').scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
      };
      row.removeButton = node('button', '저장 항목 제거'); row.removeButton.type = 'button';
      row.removeButton.onclick = () => accountAction('remove', { profileId: p.id });
      row.actions = node('div', undefined, 'tool-actions'); row.actions.append(row.rename, row.removeButton); row.append(row.choose, row.actions);
    }
    row.actions.hidden = a.selected !== p.id;
    setText(row.choose, `${p.label}${p.current ? ' · 현재' : ''}\n${p.email}`);
    row.choose.setAttribute('aria-pressed', String(a.selected === p.id)); row.choose.disabled = row.rename.disabled = row.removeButton.disabled = Boolean(!r?.supported || a.busy || a.stale || a.failed || r?.recovery);
    return row;
  });
  reconcile($('accountProfiles'), rows); $('accountEmpty').hidden = rows.length > 0;
  const selected = r?.profiles.find(p => p.id === a.selected);
  $('accountSelected').textContent = selected ? `선택 · ${selected.label}${selected.current ? ' · 현재 로그인과 같습니다' : ' · 아직 적용 전'}` : '전환할 저장 계정을 선택해 주세요.';
  const reason = accountLossReason();
  $('switchAccount').disabled = !selected || !r?.supported || r.switchSupported !== true || a.busy || a.stale || a.failed || r?.recovery || Boolean(reason) || !$('accountPcIdle').checked;
  $('accountSwitchLimit').textContent = r?.switchSupported === true ? '' : accountText('ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE');
  const blocked = !r?.supported || a.busy || a.stale || a.failed || r?.recovery;
  $('saveCurrentAccount').disabled = $('addAccount').disabled = Boolean(blocked);
  $('renameAccount').hidden = !a.rename; $('renameAccount').disabled = Boolean(blocked);
  $('accountLabel').disabled = Boolean(a.busy); $('cancelAccountLogin').hidden = op?.kind !== 'login' || !a.busy;
  $('refreshAccounts').disabled = Boolean(a.flight); $('confirmAccount').hidden = !a.stale;
  $('confirmAccount').disabled = Boolean(a.busy || a.failed || !r || r.recovery || r.error === 'ACCOUNT_READONLY_STOP_FAILED' || reason);
  $('accountRecovery').hidden = !r?.recovery;
  for (const id of ['rollbackAccount', 'keepCurrentAccount']) $(id).disabled = Boolean(a.busy || reason || a.failed || r?.switchSupported !== true || !$('accountPcIdle').checked);
  $('accountStatus').textContent = a.flight ? '계정 상태를 확인하고 있습니다…' : a.message || (r?.error === 'ACCOUNT_READONLY_STOP_FAILED' ? accountText(r.error) : a.stale ? '다른 화면에서 PC 로그인이 바뀌었습니다. 현재 계정을 확인할 때까지 보내지 않습니다.' : op?.state === 'waiting' ? '공식 로그인 페이지에서 코드를 입력해 주세요. 완료해도 자동 전환하지 않습니다.' : a.busy ? '계정 작업 처리 중 · 전송은 잠시 보호됩니다.' : r?.error || op?.state === 'failed' ? accountText(r?.error || op.error) : op?.state === 'completed' ? op.kind === 'login' ? '계정을 저장했습니다. 전환하려면 저장 항목을 선택해 주세요.' : op.kind === 'switch' || op.kind === 'recover' ? '계정 확인을 마쳤습니다. 현재 계정을 확인하고 대화를 다시 선택해 주세요.' : '저장 항목을 반영했습니다.' : reason || '');
  const device = op?.state === 'waiting' && op.device;
  $('accountDevice').hidden = !device;
  $('accountDeviceCode').textContent = device ? device.code : '';
  if (device) $('accountDeviceLink').href = device.url; else $('accountDeviceLink').removeAttribute('href');
  if (device && a.focusedDevice !== op.id) {
    a.focusedDevice = op.id; $('accountDevice').focus({ preventScroll: true });
    $('accountDevice').scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  }
}
async function accountPresence() {
  const a = state.accounts;
  if (!state.csrf || !a.revision || navigator.onLine === false || a.presenceFlight) return a.presenceFlight;
  let blocked = Boolean(accountLossReason());
  if (!blocked && !flushAccountDrafts()) blocked = true;
  const auth = state.authEpoch;
  a.presenceFlight = api('/api/accounts/presence', { pageId: a.pageId, blocked, visible: !document.hidden }).then(result => {
    if (auth !== state.authEpoch || a !== state.accounts) return;
    if (result.revision !== a.revision) accountChanged();
    a.busy = Boolean(result.busy); if (result.recovery && !a.result?.recovery) accountChanged();
    composerState(); creationState();
  }).catch(() => {}).finally(() => { a.presenceFlight = null; });
  return a.presenceFlight;
}
function closeAccountPresence() {
  const a = state.accounts;
  if (!state.csrf || !a.revision) return;
  // Same-origin authenticated keepalive; never cookies/CSRF in a URL or an unauthenticated beacon.
  fetch('/api/accounts/presence', { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Codex-CSRF': state.csrf, 'X-Codex-Account-Revision': a.revision },
    body: JSON.stringify({ pageId: a.pageId, blocked: Boolean(accountLossReason()), visible: false, closed: true }) }).catch(() => {});
}
function accountConfirmationInputs() {
  // RAM-only intent snapshot. Editing even a safely saved draft requires a new explicit confirmation.
  return JSON.stringify([state.selected, state.draftThread, [...state.drafts], state.snippets,
    ...['draft', 'expandedDraft', 'accountLabel', 'newPrompt', 'snippetLabel', 'snippetText', 'newProject', 'sendModel', 'sendThinking', 'createModel', 'createThinking'].map(id => $(id).value), $('accountPcIdle').checked]);
}
function accountConfirmationTarget(kind, fields) {
  const r = state.accounts.result;
  const row = r?.profiles.find(p => p.id === fields.profileId);
  if (kind === 'switch' || kind === 'remove') return row ? [row.id, row.label, row.email, Boolean(row.current)] : null;
  if (fields.mode === 'rollback') return ['previous', '전환 직전 PC 로그인', '암호화해 보관한 이전 로그인 · 복원 후 계정을 확인합니다.'];
  const current = r?.current, saved = r?.profiles.find(p => p.id === current?.profileId);
  return ['current', saved?.label || '현재 PC 로그인', current?.email || '현재 로그인 파일을 검증한 뒤 유지합니다.'];
}
function accountConfirmationValid(c) {
  const a = state.accounts, r = a.result, restart = c.kind !== 'remove';
  return a === c.account && a.confirmation === c && state.authEpoch === c.auth && state.csrf === c.csrf &&
    !state.loggingOut && !document.hidden && navigator.onLine !== false && !navigation.pending && navigation.intent === c.intent &&
    $('accountConfirmDialog').open && state.tools.layer?.id === 'accountConfirmDialog' && !state.tools.layer.closing &&
    a.revision === c.localRevision && a.epoch === c.epoch && r?.revision === c.revision && a.pageId === c.pageId &&
    r.supported && !r.busy && !a.busy && !a.failed && (!a.stale || c.kind === 'recover') &&
    Boolean(r.recovery) === (c.kind === 'recover') && (!restart || r.switchSupported === true && $('accountPcIdle').checked) &&
    a.selected === c.selected && (c.kind === 'recover' || c.fields.profileId === a.selected) &&
    JSON.stringify(accountConfirmationTarget(c.kind, c.fields)) === c.target && JSON.stringify(r.current) === c.current &&
    accountConfirmationInputs() === c.inputs && !accountLossReason();
}
function cancelAccountConfirmation(restore = true) {
  const a = state.accounts, c = a.confirmation;
  if (!c) return;
  a.confirmation = null; c.resolve(false);
  if (restore && state.csrf && !navigation.pending && state.tools.layer?.id === 'accountConfirmDialog' && !state.tools.layer.closing) {
    openToolLayer('toolsDialog'); updateTools();
    if (!document.hidden && c.focus?.isConnected && !c.focus.disabled) c.focus.focus({ preventScroll: true });
  } else if ($('accountConfirmDialog').open) $('accountConfirmDialog').close();
  for (const id of ['accountConfirmLabel', 'accountConfirmEmail', 'accountConfirmEffect', 'accountConfirmStatus']) $(id).textContent = '';
}
async function requestAccountConfirmation(kind, fields) {
  const a = state.accounts, target = accountConfirmationTarget(kind, fields);
  if (!target || kind === 'recover' && !['rollback', 'keep-current'].includes(fields.mode)) return null;
  const c = { account: a, kind, fields: { ...fields }, auth: state.authEpoch, csrf: state.csrf, revision: a.result.revision,
    localRevision: a.revision, epoch: a.epoch, pageId: a.pageId, selected: a.selected, intent: navigation.intent,
    target: JSON.stringify(target), current: JSON.stringify(a.result.current), inputs: accountConfirmationInputs(), focus: document.activeElement };
  const decision = new Promise(resolve => { c.resolve = resolve; }); a.confirmation = c;
  const rollback = kind === 'recover' && fields.mode === 'rollback';
  $('accountConfirmTitle').textContent = kind === 'switch' ? '계정 전환 확인' : kind === 'remove' ? '저장 항목 제거 확인' : rollback ? '이전 로그인 복원 확인' : '현재 로그인 유지 확인';
  $('accountConfirmLabel').textContent = target[1]; $('accountConfirmEmail').textContent = target[2];
  $('accountConfirmEffect').textContent = kind === 'remove' ? '이 PC에 저장한 목록에서만 제거합니다. PC 로그인과 OpenAI 세션은 로그아웃하지 않습니다.' :
    kind === 'switch' ? '이 계정으로 전환하며 PC Codex를 정상 종료한 뒤 다시 엽니다. 모든 PC 작업·확인 대기를 마쳤는지 확인해 주세요. 휴대폰 연결은 유지합니다.' :
    rollback ? '보관한 이전 로그인을 복원하고 PC Codex를 다시 엽니다. 다른 로그인·동시 갱신 파일은 덮어쓰지 않습니다. 휴대폰 연결은 유지합니다.' :
    '현재 PC 로그인 파일과 앱 연결을 검증한 뒤 복구 보호를 해제합니다. 이전 로그인으로 교체하지 않습니다. 휴대폰 연결은 유지합니다.';
  $('approveAccountConfirmation').textContent = kind === 'switch' ? '이 계정으로 전환' : kind === 'remove' ? '저장 항목 제거' : rollback ? '이전 로그인 복원' : '현재 로그인 검증';
  $('approveAccountConfirmation').disabled = false; $('accountConfirmStatus').textContent = '';
  openToolLayer('accountConfirmDialog');
  if (!accountConfirmationValid(c)) { cancelAccountConfirmation(); return null; }
  $('cancelAccountConfirmation').focus({ preventScroll: true });
  return await decision ? c : null;
}
async function accountAction(kind, fields = {}) {
  const a = state.accounts;
  if (!state.csrf || a.confirmation || a.busy || a.stale && kind !== 'recover' || a.failed && kind !== 'recover' || state.composing.size) return;
  if (['switch', 'recover', 'remove'].includes(kind)) {
    const restart = kind !== 'remove';
    if (restart && a.result?.switchSupported !== true) { a.message = accountText('ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE'); renderAccounts(); return; }
    const reason = accountLossReason();
    if (reason || !flushAccountDrafts()) { a.message = reason || '모든 초안을 기기에 저장하지 못해 전환하지 않았습니다. 중요한 초안을 복사해 주세요.'; renderAccounts(); return; }
    if (restart && !$('accountPcIdle').checked) { a.message = 'PC의 모든 Codex 작업과 확인 대기를 마쳤는지 직접 확인해 주세요.'; renderAccounts(); return; }
    const confirmation = await requestAccountConfirmation(kind, fields);
    if (!confirmation) return;
    await accountPresence();
    if (!accountConfirmationValid(confirmation) || !flushAccountDrafts() || !accountConfirmationValid(confirmation)) { if (a === state.accounts && a.confirmation === confirmation) cancelAccountConfirmation(); return; }
    fields = { ...confirmation.fields, confirmed: true, ...(restart ? { pageId: a.pageId, pcTasksComplete: true } : {}) };
    cancelAccountConfirmation();
  }
  if (['save', 'login', 'rename'].includes(kind)) {
    const label = $('accountLabel').value.trim();
    if (!label || label.length > 40 || /[\x00-\x1f\x7f]/.test(label)) { a.message = accountText('ACCOUNT_LABEL_INVALID'); renderAccounts(); return; }
    fields = { ...fields, label };
  }
  const auth = state.authEpoch;
  a.busy = true; a.message = ''; renderAccounts(); composerState(); creationState();
  try {
    const result = await api('/api/accounts/' + kind, { operationId: uuid(), ...fields }, kind === 'recover' ? { accountRevision: a.result.revision } : undefined);
    if (a !== state.accounts || auth !== state.authEpoch) return;
    receiveAccounts(result);
    if (['save', 'login', 'rename'].includes(kind)) { $('accountLabel').value = ''; a.rename = null; }
  } catch (e) {
    if (a !== state.accounts || auth !== state.authEpoch) return;
    a.message = accountText(e.code); a.failed = true;
    // An ambiguous POST is never replayed. GET status is the only recovery action.
  } finally { if (a === state.accounts && auth === state.authEpoch) { await refreshAccounts(); renderAccounts(); composerState(); creationState(); } }
}
async function confirmAccount() {
  const a = state.accounts;
  if (!a.stale || a.busy || a.failed || accountLossReason() || !flushAccountDrafts()) return;
  await refreshAccounts();
  if (a !== state.accounts || a.failed || a.busy || !a.result || a.result.recovery || a.result.error === 'ACCOUNT_READONLY_STOP_FAILED' || state.composing.size) return;
  a.revision = a.result.revision; a.stale = false; a.epoch++; a.message = ''; cancelReads();
  stopReveal(); pauseVideos(true); clearTools(); closeImage(); clearQuestions(); state.videos.clear(); state.questionReceipts.clear(); state.searchEpoch++;
  state.turns.clear(); state.historyNodes.clear(); state.threadNodes.clear();
  state.selected = null; state.draftThread = null; $('draft').value = ''; $('messages').replaceChildren(); $('threads').replaceChildren();
  state.rows = []; state.activityRows = []; state.activity.clear(); state.notifications.clear(); state.notice = null; state.rendered = null; state.renderedPreview = null;
  state.listCursor = null; state.historyCursor = null; state.historyGap = null; state.refresh = null; state.models.result = null; clearUsage();
  $('chatTitle').textContent = '대화를 다시 선택하세요'; $('chatMeta').textContent = ''; document.body.dataset.chat = 'false';
  persistDevice(true); composerState(); renderAccounts();
  await loadList(); await refreshActivity(); refreshUsage();
}
function initAccounts() {
  $('listAccounts').onclick = () => openTools('accounts'); $('toolAccounts').onclick = () => openTools('accounts');
  $('refreshAccounts').onclick = refreshAccounts; $('confirmAccount').onclick = confirmAccount;
  for (const id of ['closeAccountConfirmation', 'cancelAccountConfirmation']) $(id).onclick = () => cancelAccountConfirmation();
  $('approveAccountConfirmation').onclick = () => {
    const c = state.accounts.confirmation;
    if (!c || c.approved) return;
    if (!accountConfirmationValid(c)) { cancelAccountConfirmation(); return; }
    c.approved = true; $('approveAccountConfirmation').disabled = true;
    $('accountConfirmStatus').textContent = '입력과 PC 연결 상태를 다시 확인하고 있습니다…'; c.resolve(true);
  };
  $('accountConfirmDialog').addEventListener('cancel', e => { e.preventDefault(); cancelAccountConfirmation(); });
  $('accountConfirmDialog').addEventListener('close', () => { if (!$('accountConfirmDialog').open) cancelAccountConfirmation(false); });
  for (const name of ['input', 'change']) document.addEventListener(name, () => cancelAccountConfirmation());
  $('accountPcIdle').onchange = renderAccounts;
  $('saveCurrentAccount').onclick = () => accountAction('save'); $('addAccount').onclick = () => accountAction('login');
  $('renameAccount').onclick = () => accountAction('rename', { profileId: state.accounts.rename });
  $('switchAccount').onclick = () => accountAction('switch', { profileId: state.accounts.selected });
  $('rollbackAccount').onclick = () => accountAction('recover', { mode: 'rollback' }); $('keepCurrentAccount').onclick = () => accountAction('recover', { mode: 'keep-current' });
  $('cancelAccountLogin').onclick = async () => {
    const a = state.accounts, id = a.result?.operation?.id, auth = state.authEpoch;
    if (!id || !state.csrf) return;
    try { const r = await api('/api/accounts/cancel', { operationId: id }); if (a === state.accounts && auth === state.authEpoch) receiveAccounts(r); }
    catch (e) { if (a === state.accounts) { a.message = accountText(e.code); renderAccounts(); } }
  };
  renderAccounts();
}
