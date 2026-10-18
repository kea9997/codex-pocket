'use strict';
const $ = id => document.getElementById(id);
const state = { csrf: null, selected: null, rows: [], listCursor: null, historyCursor: null, historyGap: null, historyMessage: '',
  turns: new Map(), connected: false, capability: {}, status: 'unknown', pending: null,
  sending: false, serverSending: false, epoch: 0, searchEpoch: 0, drafts: new Map(), refresh: null, timer: null,
  authEpoch: 0, activity: new Map(), activityRows: [], activityTimer: null, activityFlight: null,
  activityAvailable: false, activityFilter: 'all', notifications: new Map(), threadNodes: new Map(),
  historyNodes: new Map(), videos: new Set(), questionNodes: new Map(), questionResult: null, questionReceipts: new Map(),
  favorites: [], positions: new Map(), restoring: false, booting: false, nativeVersion: 0, nativeMonitor: false };
state.tools = { pane: 'quick', query: '', matches: [], match: -1, resultFilter: 'all', results: [], bridgeAt: null, diagnostic: null, diagnosticFlight: null };
const toolPanes = [['quick', 'quickPane', 'toolQuick'], ['search', 'messageSearchPane', 'toolSearch'], ['results', 'resultsPane', 'toolResults'], ['diagnostics', 'diagnosticsPane', 'toolDiagnostics'], ['usage', 'usagePane', 'toolUsage'], ['updates', 'updatesPane', 'toolUpdates'], ['accounts', 'accountsPane', 'toolAccounts']];
state.reveal = { enabled: true, version: 0, read: null, active: null, top: 0 };
state.usage = { result: null, flight: null, timer: null, nextAt: 0, failed: false, suspended: false };
state.models = { result: null, flight: null, preferences: new Map() };
state.creation = { receipt: null, busy: false, checking: false, checked: false, missing: false, message: '' };
state.editor = null; state.composing = new Set(); state.snippets = []; state.snippetEdit = null;
state.latestAnswer = { key: null, pending: false };
state.updates = { result: null, flight: null, nextAt: 0, failed: false };
state.accounts = newAccountState();
const accountEntry = location.hash === '#accounts';
const navigation = { scope: uuid(), revision: 0, intent: 0, pending: null, quietUntil: 0 };
function navigationEntry(view) { return { codexPhone: navigation.scope, authEpoch: state.authEpoch, view }; }
function ownEntry(view) { return history.state?.codexPhone === navigation.scope && history.state.authEpoch === state.authEpoch && history.state.view === view; }
function listEntry() { history.replaceState(navigationEntry('list'), '', location.pathname + location.search); navigation.revision++; }
// A restored fragment is not a Back stack. Every document starts with its own real list baseline.
listEntry();
function finishTraversal() {
  const pending = navigation.pending; navigation.pending = null; pending?.resolve();
}
function backEntry(view) {
  if (!ownEntry(view)) { listEntry(); finishToolLayer(); return; }
  const pending = {}; pending.promise = new Promise(resolve => { pending.resolve = resolve; });
  navigation.pending = pending; history.back();
}
function leaveConversation() {
  stopReveal(); persistDevice(true); pauseVideos(true); clearTimeout(state.timer);
  document.body.dataset.chat = 'false'; state.restoring = false; state.epoch++; navigation.revision++;
}
function closeListMenu(restore = false) {
  if (!$('listMenu').open) return false;
  $('listMenu').open = false; navigation.revision++;
  if (restore && state.csrf && !document.hidden) $('listMenuToggle').focus({ preventScroll: true });
  return true;
}
$('listMenu').addEventListener('toggle', () => { navigation.revision++; });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && closeListMenu(true)) e.preventDefault(); });
document.addEventListener('click', e => { if ($('listMenu').open && !$('listMenu').contains(e.target)) closeListMenu(); });
function backRoot() {
  return !$('listMenu').open && !document.hidden && !state.booting && !state.loggingOut && !navigation.pending && performance.now() >= navigation.quietUntil &&
    Boolean(state.csrf) && !$('appView').hidden && document.body.dataset.chat !== 'true' && ownEntry('list') &&
    !state.tools.layer && !['accountConfirmDialog', 'editorDialog', 'imageDialog', 'copyDialog', 'toolsDialog', 'newChatDialog'].some(id => $(id).open);
}
function semanticBack() {
  if (document.hidden || state.loggingOut) return 'blocked';
  if (navigation.pending) { navigation.intent++; navigation.revision++; return 'busy'; }
  if (performance.now() < navigation.quietUntil) return 'busy';
  if (closeListMenu(true)) { navigation.intent++; navigation.quietUntil = performance.now() + 350; return 'handled'; }
  const layer = ['accountConfirmDialog', 'editorDialog', 'imageDialog', 'copyDialog', 'toolsDialog', 'newChatDialog'].find(id => $(id).open) || state.tools.layer?.id;
  if (layer || document.body.dataset.chat === 'true' && !$('appView').hidden) {
    navigation.intent++; navigation.revision++; navigation.quietUntil = performance.now() + 350;
    if (layer) { if (layer === 'imageDialog') closeImage(); else closeToolLayer(layer); }
    else { leaveConversation(); backEntry('chat'); }
    return 'handled';
  }
  return backRoot() ? `root:${state.authEpoch}:${navigation.revision}` : 'blocked';
}
// Fixed native Back contract only: no native capability, arguments, I/O or message dispatch.
window.codexPhoneBack = semanticBack;
window.codexPhoneConfirmBack = proof => backRoot() && proof === `root:${state.authEpoch}:${navigation.revision}`;
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
reducedMotion?.addEventListener('change', () => { stopReveal(); answerDisplayState(); });
function revealAllowed() {
  return state.reveal.enabled && !reducedMotion?.matches && typeof requestAnimationFrame === 'function' &&
    state.csrf && state.connected && viewingCurrent() && navigator.onLine !== false && atLatest() && !state.reveal.away && !state.restoring &&
    window.getSelection?.()?.isCollapsed !== false &&
    !state.errorCode && !$('accountConfirmDialog').open && !$('editorDialog').open && !$('toolsDialog').open && !$('copyDialog').open && !$('imageDialog').open && !$('newChatDialog').open;
}
function flushReveal(follow = false) {
  const active = state.reveal.active; if (!active) return;
  state.reveal.active = null; cancelAnimationFrame(active.frame);
  const area = $('history'), top = area.scrollTop;
  for (const leaf of active.leaves) if (leaf.node.data !== leaf.value) leaf.node.data = leaf.value;
  area.scrollTop = follow ? area.scrollHeight : top; state.reveal.top = area.scrollTop;
}
function stopReveal() { flushReveal(); state.reveal.version++; state.reveal.read = null; }
function revealLeaves(ui) {
  const leaves = []; let text = '', visited = 0, bounded = true;
  const walk = el => {
    if (!bounded || ++visited > 512) { bounded = false; return; }
    if (el.nodeType === 3) {
      const value = el.data; if (!value) return;
      leaves.push({ node: el, value, start: text.length }); text += value;
      if (text.length > 16384 || leaves.length > 256) bounded = false;
    } else if (el.tagName !== 'BUTTON' && el.className !== 'code-label') for (const child of el.childNodes) walk(child);
  };
  for (const part of ui.textParts) walk(part);
  return bounded ? { leaves, text } : null;
}
function revealFrame(now) {
  const active = state.reveal.active; if (!active) return;
  if (active.epoch !== state.epoch || active.version !== state.reveal.version || !revealAllowed() || !active.ui.root.isConnected) { flushReveal(); return; }
  const progress = Math.min(1, Math.max(0, (now - active.started) / (active.deadline - active.started)));
  const target = active.from + Math.ceil((active.text.length - active.from) * progress);
  let shown = active.from;
  for (const boundary of active.boundaries) { if (boundary > target) break; shown = boundary; }
  active.shown = shown;
  for (const leaf of active.leaves) {
    const value = leaf.value.slice(0, Math.max(0, shown - leaf.start));
    if (leaf.node.data !== value) leaf.node.data = value;
  }
  $('history').scrollTop = $('history').scrollHeight; state.reveal.top = $('history').scrollTop;
  if (progress === 1) flushReveal(true);
  else active.frame = requestAnimationFrame(revealFrame);
}
function revealMessage(ui, before, pending) {
  if (typeof Intl.Segmenter !== 'function') return;
  const next = revealLeaves(ui);
  if (!next || !next.text.startsWith(before) || next.text.length <= before.length || next.text.length - before.length > 4096) return;
  const now = performance.now(), from = pending?.shown ?? before.length;
  // One active message, bounded work and a fixed deadline even if several appends arrive together.
  const deadline = Math.min(now + Math.min(700, Math.max(160, (next.text.length - from) * 4)), pending?.limit ?? now + 900);
  if (deadline - now < 32) return;
  const boundaries = [0];
  for (const part of new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(next.text)) boundaries.push(part.index + part.segment.length);
  const start = boundaries.findLast(value => value <= from) ?? 0;
  state.reveal.active = { ...next, ui, boundaries, from: start, shown: start, started: now, deadline, limit: pending?.limit ?? now + 900, epoch: state.epoch, version: state.reveal.version };
  revealFrame(now);
}
function answerDisplayState() {
  $('answerSmooth').setAttribute('aria-pressed', String(state.reveal.enabled));
  $('answerInstant').setAttribute('aria-pressed', String(!state.reveal.enabled));
  $('answerDisplayNote').textContent = reducedMotion?.matches ? '기기의 동작 줄이기 설정에 따라 즉시 표시합니다.' : '주기적으로 받은 새 답변만 짧게 이어 표시합니다. 실제 토큰 스트리밍은 아닙니다.';
}
for (const [id, enabled] of [['answerSmooth', true], ['answerInstant', false]]) $(id).onclick = () => {
  if (!state.csrf) return;
  stopReveal(); state.reveal.enabled = enabled; answerDisplayState(); persistDevice(true);
};
let durable;
try { durable = new DeviceState(localStorage, ok => { $('storageStatus').hidden = ok; $('storageStatus').textContent = ok ? '' : '기기 저장 실패 · 현재 초안은 화면에 유지됩니다. 저장 공간과 앱 설정을 확인해 주세요.'; }); }
catch { durable = new DeviceState({ getItem() { throw 0; }, setItem() { throw 0; }, removeItem() {} }, () => { $('storageStatus').hidden = false; $('storageStatus').textContent = '기기 저장을 사용할 수 없습니다. 초안은 앱을 닫기 전에 복사해 주세요.'; }); }
let saveTimer;
function capturePosition() {
  if (!state.selected || state.restoring || !state.historyNodes.size) return;
  const area = $('history'), viewport = area.getBoundingClientRect(), top = viewport.top;
  const entries = new Map([...state.historyNodes].map(([key, ui]) => [ui.root, [key, ui]]));
  const match = Array.from($('messages').children).map(root => entries.get(root)).find(entry => {
    if (!entry) return false;
    const rect = entry[1].root.getBoundingClientRect();
    return rect.bottom > top && rect.top < viewport.bottom;
  });
  if (!match) return;
  const [key, ui] = match;
  state.positions.delete(state.selected); state.positions.set(state.selected, { id: state.selected, key, cursor: ui.pageCursor ?? null, offset: (ui.root.getBoundingClientRect?.().top ?? 0) - top, bottom: atLatest() });
  while (state.positions.size > 16) state.positions.delete(state.positions.keys().next().value);
}
function persistDevice(flush = false) {
  if (!state.csrf || !durable.scope) return;
  clearTimeout(saveTimer);
  const save = () => {
    if (!state.csrf || !durable.scope) return;
    if (state.selected && state.draftThread === state.selected) { state.drafts.delete(state.selected); state.drafts.set(state.selected, $('draft').value); }
    capturePosition();
    syncEditor();
    state.savedDevice = durable.save({ snippets: state.snippets, selected: state.selected, drafts: [...state.drafts], favorites: state.favorites, positions: [...state.positions.values()],
      reads: [...state.activity].map(([id, r]) => ({ id, ...r, seen: [...r.seen] })), pending: state.pending, smoothAnswers: state.reveal.enabled,
      modelChoices: [...state.models.preferences], creation: state.creation.receipt });
    editorState();
    if (!state.savedDevice) { $('composerFeedback').hidden = false; $('composerStatus').textContent = '기기 저장 실패 · 초안은 화면에 유지됩니다. 닫기 전에 복사해 주세요.'; }
  };
  if (flush) save(); else saveTimer = setTimeout(save, 350);
}
function restoreDevice(scope) {
  if (scope && durable.scope === scope) return;
  if (durable.scope && durable.scope !== scope) { state.drafts.clear(); state.positions.clear(); state.activity.clear(); state.favorites = []; state.selected = null; state.pending = null; }
  stopReveal();
  const saved = durable.bind(scope); state.snippets = saved.snippets; resetSnippetForm(); renderSnippets();
  state.reveal.enabled = saved.smoothAnswers; answerDisplayState();
  state.drafts = new Map(saved.drafts); state.favorites = saved.favorites; state.positions = new Map(saved.positions.map(r => [r.id, r]));
  for (const r of saved.reads) state.activity.set(r.id, { ...r, seen: new Set(r.seen) });
  state.selected = saved.selected || state.selected; state.pending = saved.pending || state.pending;
  state.models.preferences = new Map(saved.modelChoices); state.models.result = null;
  state.creation.receipt = saved.creation ? { ...saved.creation, state: 'uncertain', kind: 'create' } : null;
}
state.recovery = { flight: null, gated: false, failures: 0, suspended: false };
const getFlights = new Map();
const attachments = new AttachmentQueue({ csrf: () => state.csrf, epoch: () => state.authEpoch, revision: () => state.accounts.revision,
  writable: key => !accountLocked() && attachments.active(key),
  active: key => Boolean(state.csrf && !state.loggingOut && (key === 'new' ? !state.creation.busy && !['reserved', 'pending', 'uncertain'].includes(state.creation.receipt?.state) : !state.sending && state.pending?.threadId !== key)),
  changed: (key, message) => { $(key === 'new' ? 'newAttachmentStatus' : 'attachmentStatus').issue = message || ''; renderAttachments(key); composerState(); creationState(); }, expired: () => showPair(errors.AUTH_REQUIRED) });
function renderAttachments(key, message) {
  const fresh = key === 'new'; if (!fresh && key !== state.selected) return;
  const list = $(fresh ? 'newAttachments' : 'attachments'), note = $(fresh ? 'newAttachmentStatus' : 'attachmentStatus');
  const rows = attachments.rows(key), locked = fresh ? state.creation.busy || ['reserved', 'pending', 'uncertain'].includes(state.creation.receipt?.state) : state.sending || state.pending?.threadId === key;
  const current = new Set(rows.map(r => r.ui));
  for (const child of Array.from(list.children)) if (!current.has(child)) child.remove();
  for (const row of rows) {
    if (!row.ui) {
      const root = node('div', undefined, 'attachment-row'), label = node('span'), status = node('small'), action = node('button'), remove = node('button', '제거'); action.type = remove.type = 'button';
      const info = node('div'); info.append(label, status); root.append(info, action, remove); Object.assign(row, { ui: root, label, statusNode: status, action, remove });
      remove.onclick = async () => {
        const authEpoch = state.authEpoch, intent = navigation.intent, focused = document.activeElement === remove;
        await attachments.remove(key, row, api);
        if (focused && authEpoch === state.authEpoch && intent === navigation.intent && !remove.isConnected && (fresh ? $('newChatDialog').open : state.selected === key) && (document.activeElement === remove || document.activeElement === document.body)) $(fresh ? 'attachNewFiles' : 'attachFiles').focus({ preventScroll: true });
      };
      action.onclick = () => row.xhr || row.status === 'waiting' ? attachments.cancel(row) : attachments.upload(key, row);
    }
    setText(row.label, `${row.file.name} · ${(row.file.size / 1024).toFixed(1)}KiB`);
    const expired = row.upload?.expiresAt <= Date.now(), cancellable = row.xhr || row.status === 'waiting';
    setText(row.statusNode, row.status === 'uploading' ? `PC 전송 중 ${row.progress}%` : expired ? '보관 만료 · 다시 업로드하거나 제거 후 선택해 주세요.' : row.message || '대기');
    row.action.hidden = Boolean(row.upload && !expired || row.status === 'removing'); row.action.disabled = Boolean(locked || navigator.onLine === false);
    setText(row.action, cancellable ? '취소' : '다시 업로드'); row.action.setAttribute('aria-label', `${row.file.name} ${cancellable ? '업로드 취소' : '다시 업로드'}`); row.remove.setAttribute('aria-label', `${row.file.name} 첨부 제거`); row.remove.disabled = Boolean(locked || row.status === 'removing');
    if (row.ui.parentNode !== list && row.ui.parent !== list) list.append(row.ui);
  }
  note.textContent = message || note.issue || (rows.length ? 'PC로 전송한 파일 참조를 요청에 함께 보냅니다. 미전송 24시간 보관 · 앱 재시작 시 다시 선택해 주세요.' : ''); note.hidden = !note.textContent;
}
function supportsAttachmentPicker() {
  const agent = navigator.userAgent || '', version = /CodexPhoneApp\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(agent);
  if (!/CodexPhone(?:App)?\//.test(agent)) return true;
  return Boolean(version && (Number(version[1]) > 0 || Number(version[2]) >= 3));
}
for (const [button, picker, key] of [['attachFiles', 'attachmentPicker', null], ['attachNewFiles', 'newAttachmentPicker', 'new']]) {
  if (!supportsAttachmentPicker()) { setText($(button), '첨부 · 업데이트 필요'); $(button).title = '파일 첨부는 Codex 원격 v0.3.0 이상 앱에서 사용할 수 있습니다.'; $(button).setAttribute('aria-label', $(button).title); }
  $(button).onclick = () => { const target = key || state.selected; if (!target) return; if (!supportsAttachmentPicker()) { renderAttachments(target, '파일 첨부는 Codex 원격 v0.3.0 이상 앱으로 업데이트한 뒤 사용할 수 있습니다.'); return; } $(picker).pickKey = target; $(picker).pickEpoch = state.authEpoch; $(picker).pickIntent = navigation.intent; $(picker).value = ''; $(picker).click(); };
  $(picker).onchange = () => { const input = $(picker); if (input.pickEpoch === state.authEpoch && input.pickIntent === navigation.intent && (key === 'new' ? $('newChatDialog').open : input.pickKey === state.selected)) attachments.add(input.pickKey, input.files); input.value = ''; };
}
function sendChoicesLocked() {
  return !state.csrf || !state.selected || !state.connected || state.sending || Boolean(state.pending) || state.serverSending || state.acknowledging || accountLocked() || state.recovery.gated || state.recovery.suspended || navigator.onLine === false;
}
function sendChoicesState() {
  const locked = sendChoicesLocked();
  $('sendModel').disabled = Boolean(locked || state.models.flight);
  $('sendThinking').disabled = Boolean(locked || state.models.flight || !$('sendModel').value || !optionRows('send').find(r => r.id === $('sendModel').value)?.efforts.length);
  $('refreshOptions').disabled = Boolean(locked || state.models.flight);
}
const errors = {
  INVALID_QUESTION: '질문 식별 정보를 확인할 수 없습니다. 질문 기록을 다시 확인해 주세요.',
  QUESTION_SOURCE_CHANGED: '같은 질문의 미응답 기록을 현재 소스에서 확인하지 못했습니다. 답변은 보내지 않았습니다. 질문 기록을 다시 확인해 주세요.',
  QUESTION_MESSAGE_DELIVERED: '이 질문의 답변 메시지는 이미 전달했습니다. PC 질문 폼 완료 여부는 PC에서 확인해 주세요.',
  QUESTION_MESSAGE_UNCONFIRMED: '이 질문의 이전 답변 전달 여부가 미확인입니다. PC 기록에서 확인해 주세요. 다시 보내지 않았습니다.',
  UPLOAD_NOT_READY: '첨부 전송을 완료하거나 제거해 주세요. 자동으로 보내지 않습니다.',
  UPLOAD_EXPIRED: '첨부 보관이 만료되었습니다. 직접 다시 업로드하거나 제거 후 다시 골라 주세요.',
  UPLOAD_CHANGED: 'PC 첨부 파일이 변경되었습니다. 제거 후 다시 골라 주세요.',
  UPLOAD_NOT_FOUND: '첨부를 확인할 수 없습니다. 제거 후 다시 골라 주세요.',
  INVALID_MODEL_CHOICE: '모델을 먼저 선택하고 지원되는 추론 값을 선택해 주세요.',
  MODEL_CHOICE_UNAVAILABLE: '선택한 모델·추론 조합을 PC에서 확인할 수 없습니다. 선택지를 다시 확인하거나 PC 설정 유지로 지워 주세요. 자동 대체하지 않았습니다.',
  OPTIONS_UNAVAILABLE: 'PC 선택지를 확인할 수 없습니다. 기존 대화는 PC 설정 유지로 보낼 수 있습니다.',
  PROJECT_UNAVAILABLE: '현재 등록된 로컬 프로젝트가 아닙니다. 프로젝트 선택지를 다시 확인해 주세요.',
  CREATE_IN_PROGRESS: '새 대화의 생성 결과를 확인 중입니다. 다시 만들지 마세요.',
  PREVIOUS_CREATE_UNCERTAIN: '이전 새 대화 생성 결과가 불명확합니다. PC 확인 후 생성 보호만 해제해 주세요.',
  CREATE_UNCERTAIN: '새 대화 생성 결과를 확인하지 못했습니다. 자동으로 다시 만들지 않습니다. PC 대화 목록을 확인해 주세요.',
  REQUEST_ID_CONFLICT: '요청 ID가 다른 내용이나 설정에 사용되었습니다. 재전송하지 말고 PC에서 확인해 주세요.',
  AUTH_REQUIRED: '기기 연결이 만료되었습니다. 새 코드로 다시 연결해 주세요.',
  PAIRING_INVALID: '코드가 올바르지 않거나 만료되었습니다. PC에서 새 코드를 확인해 주세요.',
  PAIRING_RATE_LIMIT: '연결 시도가 너무 많습니다. 10분 후 다시 시도해 주세요.',
  DESKTOP_NOT_AVAILABLE: 'PC의 Codex 앱을 열어 주세요. 앱을 닫지 않고 같은 대화에 연결합니다.',
  DESKTOP_DISCONNECTED: 'PC의 Codex 연결이 끊어졌습니다. 잠시 뒤 다시 확인해 주세요.',
  DESKTOP_PIPE_AMBIGUOUS: '여러 Codex 연결이 발견되었습니다. PC에서 연결 상태를 점검해 주세요.',
  DESKTOP_TIMEOUT: 'PC 응답 시간이 초과되었습니다. 전송 중이었다면 중복 전송하지 마세요.',
  DESKTOP_REQUEST_FAILED: 'PC에서 요청을 처리하지 못했습니다. 해당 대화 상태를 확인해 주세요.',
  DESKTOP_TOOL_UNSUPPORTED: '설치된 Codex에서 이 기능을 제공하지 않습니다. PC에서 확인해 주세요.',
  DESKTOP_TOOL_FAILED: 'PC 도구가 기록 조회를 거절했습니다. Codex에서 해당 대화가 열리는지 확인한 뒤 다시 확인해 주세요.',
  HISTORY_SIZE_LIMIT: '이 대화의 한 턴이 PC 도구의 크기 한도를 초과했습니다. 출력 생략으로도 읽지 못했습니다. PC Codex에서 해당 기록을 확인해 주세요. 자동 반복 조회는 멈췄으며 새 대화를 만들거나 요청을 재전송하지 않습니다.',
  SEND_IN_PROGRESS: '이 대화에 다른 전송을 확인 중입니다. 잠시 뒤 확인해 주세요.',
  SEND_UNCERTAIN: '전송 결과를 확인하지 못했습니다. 중복 전송하지 말고 PC 기록을 확인해 주세요.',
  PREVIOUS_SEND_UNCERTAIN: '이전 전송의 처리 여부가 불명확합니다. PC 기록 확인 전에는 새 요청을 보내지 않습니다.',
  THREAD_ID_MISMATCH: '선택한 대화와 응답 ID가 달라 중단했습니다. 새 대화를 만들지 않았습니다.',
  REQUEST_JOURNAL_FULL: '안전한 전송 기록 한도에 도달했습니다. PC에서 기록을 점검해 주세요.',
  NETWORK: 'PC에 연결할 수 없습니다. Tailscale과 PC 전원을 확인한 뒤 다시 시도해 주세요.'
};
function errorText(e) { return errors[e.code] || '요청을 완료하지 못했습니다. PC 연결과 대화 상태를 확인해 주세요.'; }
function node(tag, value, className) { const el = document.createElement(tag); if (value !== undefined) el.textContent = value; if (className) el.className = className; return el; }
function cancelReads() { for (const flight of getFlights.values()) flight.cancel(); getFlights.clear(); }
function api(path, input, { accountRevision = state.accounts.revision } = {}) {
  const authEpoch = state.authEpoch, account = state.accounts, accountEpoch = account.epoch, read = input === undefined, key = `${authEpoch}:${accountEpoch}:${path}`;
  const accountRead = read && !['/api/session', '/api/release', '/api/accounts', '/api/create/state'].includes(path) && !path.startsWith('/api/requests/');
  if (read && getFlights.has(key)) return getFlights.get(key).promise;
  const controller = new AbortController(); let timer, cancelled = false, rejectWait;
  const flight = { cancel: () => { cancelled = true; controller.abort(); rejectWait?.({ code: 'STALE_RESPONSE' }); } };
  const deadline = new Promise((_, reject) => { rejectWait = reject; timer = setTimeout(() => { controller.abort(); reject({ code: 'NETWORK' }); }, read ? 10000 : 35000); });
  const operation = (async () => {
    const res = await fetch(path, { method: read ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { ...(accountRevision ? { 'X-Codex-Account-Revision': accountRevision } : {}), ...(!read ? { 'Content-Type': 'application/json', ...(state.csrf ? { 'X-Codex-CSRF': state.csrf } : {}) } : {}) },
      body: read ? undefined : JSON.stringify(input), signal: controller.signal });
    return { res, data: await res.json() };
  })();
  flight.promise = Promise.race([operation, deadline]).then(({ res, data }) => {
    if (authEpoch !== state.authEpoch || cancelled) throw { code: 'STALE_RESPONSE' };
    const revision = res.headers?.get?.('X-Codex-Account-Revision');
    if (account.revision && revision && revision !== account.revision) accountChanged();
    if (data.error === 'ACCOUNT_CHANGED') accountChanged();
    if (accountRead && account.revision && (accountEpoch !== account.epoch || accountLocked())) throw { code: 'STALE_RESPONSE' };
    state.tools.bridgeAt = Date.now(); state.tools.bridgeFailed = false;
    if (!res.ok) { if (res.status === 401 && path !== '/api/pair') showPair(errors.AUTH_REQUIRED); throw { code: data.error, status: res.status }; }
    return data;
  }).catch(e => {
    if (authEpoch !== state.authEpoch || cancelled) throw { code: 'STALE_RESPONSE' };
    if (e.code && e.code !== 'NETWORK') throw e;
    if (path !== '/api/usage') stopReveal(); state.tools.bridgeFailed = true; if ($('toolsDialog').open) renderDiagnostics();
    throw { code: 'NETWORK' };
  }).finally(() => { clearTimeout(timer); if (getFlights.get(key) === flight) getFlights.delete(key); });
  if (read) { if (getFlights.size >= 24) { const [oldKey, old] = getFlights.entries().next().value; getFlights.delete(oldKey); old.cancel(); } getFlights.set(key, flight); }
  return flight.promise;
}
function showPair(message = '', discard = true) {
  if (discard) { state.editor = null; $('expandedDraft').value = ''; state.snippets = []; resetSnippetForm(); renderSnippets(); }
  cancelAccountConfirmation(false); state.accounts = newAccountState(); $('accountLabel').value = ''; renderAccounts();
  state.composing.clear(); state.latestAnswer = { key: null, pending: false }; renderLatestAnswer();
  state.updates = { result: null, flight: null, nextAt: 0, failed: false }; renderUpdates();
  cancelReads(); attachments.clear(); state.recovery = { flight: null, gated: false, failures: 0, suspended: false };
  $('attachments').replaceChildren(); $('newAttachments').replaceChildren(); $('attachmentStatus').hidden = $('newAttachmentStatus').hidden = true;
  stopReveal(); navigation.intent++; navigation.revision++; navigation.scope = uuid();
  navigation.quietUntil = performance.now() + 350;
  clearModelUI(discard);
  if (discard) { state.reveal.enabled = true; answerDisplayState(); }
  if (discard) { durable.clear(); clearTimeout(saveTimer); state.favorites = []; state.positions.clear(); state.pending = null; savePending(); }
  else persistDevice(true);
  state.restoring = false; state.booting = false;
  clearUsage(); clearTools(); closeImage(); pauseVideos(true); state.historyNodes.clear(); state.videos.clear(); clearQuestions();
  clearTimeout(state.timer); clearTimeout(state.activityTimer); state.connected = false; state.csrf = null;
  state.epoch++; state.authEpoch++; state.searchEpoch++; state.sending = false; state.acknowledging = false;
  state.tools.diagnostic = null; state.tools.diagnosticFailed = false; state.tools.diagnosticFlight = null; state.tools.bridgeAt = null; state.tools.bridgeFailed = false;
  if (discard) state.activity.clear(); state.activityRows = []; state.notifications.clear(); state.threadNodes.clear();
  state.activityAvailable = false; state.activityFilter = 'all'; state.activityFlight = null;
  if (discard) { state.drafts.clear(); state.selected = null; state.draftThread = null; }
  state.turns.clear(); state.questionReceipts.clear(); state.rows = []; state.renderedPreview = null;
  state.rendered = null; state.notice = null; state.refresh = null; state.listCursor = null; state.historyCursor = null;
  state.listRetry = null; state.listBusy = null; state.historyGap = null; state.historyMessage = '';
  state.draftThread = null;
  $('threads').replaceChildren(); $('messages').replaceChildren(); $('draft').value = ''; $('search').value = '';
  $('chatTitle').textContent = '대화를 선택하세요'; $('chatMeta').textContent = ''; clearError();
  $('noticeTitle').textContent = ''; $('noticeSnippet').textContent = '';
  $('filterWorking').textContent = '작업 중 0'; $('filterUnread').textContent = '새 응답 0';
  $('activityNotice').hidden = true; $('activityStatus').textContent = ''; document.body.dataset.chat = 'false';
  $('appView').hidden = true; $('pairView').hidden = false; $('pairForm').hidden = false;
  $('pairStatus').textContent = message; $('pairRetry').hidden = true;
  renderModelSelect('send'); listEntry();
}
async function boot() {
  const authEpoch = state.authEpoch; state.booting = true; navigation.revision++;
  $('pairRetry').hidden = true; $('pairStatus').textContent = 'PC 연결을 확인하고 있습니다…';
  try {
    const s = await api('/api/session');
    if (authEpoch !== state.authEpoch) return;
    if (durable.scope && s.storageScope !== durable.scope) { showPair('', true); return boot(); }
    state.csrf = s.csrf; restoreDevice(s.storageScope);
    if (s.accountRevision) {
      if (state.accounts.revision && state.accounts.revision !== s.accountRevision) accountChanged();
      else state.accounts.revision = s.accountRevision;
      await refreshAccounts();
    }
    $('pairView').hidden = true; $('appView').hidden = false;
    if (accountLocked()) {
      await checkCreation(); await checkPending().catch(showError);
      if (authEpoch === state.authEpoch && state.csrf) { openTools('accounts'); scheduleActivity(); }
      return;
    }
    await loadList();
    if (authEpoch !== state.authEpoch || !state.csrf) return;
    refreshActivity().finally(scheduleActivity);
    state.usage.suspended = false; refreshUsage(); refreshRelease(); checkCreation().catch(() => {});
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('codex-phone-pending') || 'null'); }
    catch { /* Storage is optional; authentication stays in the HttpOnly cookie. */ }
    const pending = saved?.storageScope === durable.scope && durable.scope ? durable.bounded({ version: 2, scope: durable.scope, pending: saved }).pending : null;
    if (pending) {
      state.pending = pending; await openThread(pending.threadId); await checkPending().catch(showError);
    } else if (state.pending?.threadId) { await openThread(state.pending.threadId); await checkPending().catch(showError); }
    else if (state.openIntent || state.selected) { const id = state.openIntent || state.selected; state.openIntent = null; await openThread(id); }
    if (state.openIntent && state.csrf) { const id = state.openIntent; state.openIntent = null; await openThread(id); }
  } catch (e) {
    if (e.code === 'STALE_RESPONSE') return;
    showPair(e.code === 'AUTH_REQUIRED' ? '' : errorText(e), e.code === 'AUTH_REQUIRED');
    if (e.code !== 'AUTH_REQUIRED') $('pairRetry').hidden = false;
  } finally {
    if (authEpoch === state.authEpoch) {
      state.booting = false;
      if (state.csrf && state.accounts.revision) { accountPresence(); if (accountEntry) openTools('accounts'); }
      if (state.openIntent && state.csrf) { const id = state.openIntent; state.openIntent = null; openThread(id); }
    }
  }
}
$('pairForm').addEventListener('submit', async e => {
  e.preventDefault(); $('pairButton').disabled = true; $('pairStatus').textContent = '기기를 연결하고 있습니다…';
  try { await api('/api/pair', { code: $('pairCode').value.trim() }); $('pairCode').value = ''; await boot(); }
  catch (err) { $('pairStatus').textContent = errorText(err); }
  finally { $('pairButton').disabled = false; }
});
$('pairRetry').onclick = boot;
$('logout').onclick = async () => {
  if (!confirm('이 기기의 PC 연결을 해제할까요? 진행 중인 PC 작업은 중지되지 않습니다.')) return;
  state.loggingOut = true; navigation.revision++;
  try {
    await api('/api/logout', {}); state.drafts.clear(); state.turns.clear(); state.pending = null; savePending();
    state.selected = null; state.rows = []; $('threads').replaceChildren(); $('messages').replaceChildren();
    $('draft').value = ''; showPair('연결을 해제했습니다. 다시 연결하려면 새 일회용 코드가 필요합니다.');
  } catch (e) { showError(e); }
  finally { state.loggingOut = false; navigation.revision++; }
};
const connectionErrors = new Set(['NETWORK', 'DESKTOP_NOT_AVAILABLE', 'DESKTOP_DISCONNECTED', 'DESKTOP_TIMEOUT', 'DESKTOP_REQUEST_FAILED', 'CODEX_DISCONNECTED', 'CODEX_TIMEOUT']);
function showError(e) {
  if (e.code === 'STALE_RESPONSE' || !state.csrf) return;
  state.errorCode = e.code;
  stopReveal();
  if (connectionErrors.has(e.code)) pauseVideos();
  $('chatError').hidden = false; $('chatError').replaceChildren(node('span', errorText(e)));
  const retry = node('button', '다시 확인'); retry.type = 'button';
  retry.onclick = () => { if (sendOptionsError()) retrySendOptions(); else if (state.selected) refreshCurrent().catch(showError).finally(schedulePoll); else loadList(); };
  $('chatError').append(retry); composerState();
}
function clearError() { state.errorCode = null; $('chatError').hidden = true; $('chatError').replaceChildren(); }
// Actual native updatedAt only; aligned with server/work-order.mjs, never preview/seen clocks.
function workTime(value) {
  if (typeof value === 'string') {
    if (/^\d{1,16}(?:\.\d{1,6})?$/.test(value)) value = Number(value);
    else {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
      const [year, month, day] = value.slice(0, 10).split('-').map(Number);
      if (day > new Date(Date.UTC(year, month, 0)).getUTCDate() || Number(value.slice(11, 13)) > 23) return null;
      const ms = Date.parse(value);
      return Number.isFinite(ms) && ms > 0 && ms <= 253402300799999 ? ms : null;
    }
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const ms = value < 1e11 ? value * 1000 : value;
  return Number.isFinite(ms) && ms <= 253402300799999 ? ms : null;
}
function newestUpdate(a, b) {
  const left = workTime(a), right = workTime(b);
  return right !== null && (left === null || right > left) ? b : left !== null ? a : null;
}
function compareWork(a, b) {
  const left = workTime(a.updatedAt), right = workTime(b.updatedAt);
  if (left !== right) return left === null ? 1 : right === null ? -1 : right > left ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function date(value) { const ms = workTime(value); return ms === null ? '' : new Date(ms).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }); }
const statusLabels = { active: '작업 중', waiting: '사용자 확인 대기', idle: '대기 중', unavailable: '상태 확인 불가', unknown: '상태 확인 불가' };
function setText(el, value) { if (el.textContent !== value) el.textContent = value; }
function activityEntry(id) {
  if (!state.activity.has(id)) state.activity.set(id, { baseline: false, version: null, seenAt: -1, seen: new Set(), unread: false, desktopDismissed: false });
  return state.activity.get(id);
}
function isUnread(entry) { return Boolean(entry?.unread || (entry?.desktopUnread && !entry.desktopDismissed)); }
function viewingCurrent() { return !document.hidden && !$('appView').hidden && document.body.dataset.chat === 'true'; }
function atLatest() { const el = $('history'); return el.scrollHeight - el.scrollTop - el.clientHeight < 160; }
function renderList() {
  const scroll = $('sidebar').scrollTop, list = $('threads'), focused = document.activeElement;
  const focusedRow = [...state.threadNodes.values()].find(ui => [ui.root, ui.button, ui.star].includes(focused));
  const working = state.activityRows.filter(r => ['active', 'waiting'].includes(r.status));
  const unread = state.activityRows.filter(r => isUnread(state.activity.get(r.id)));
  setText($('filterWorking'), `작업 중 ${working.length}`); setText($('filterUnread'), `새 응답 ${unread.length}`);
  for (const [id, filter] of [['filterAll', 'all'], ['filterWorking', 'working'], ['filterUnread', 'unread']]) $(''+id).setAttribute('aria-pressed', String(state.activityFilter === filter));
  const favorites = new Map(state.favorites.map((r, n) => [r.id, n]));
  setText($('filterFavorites'), `즐겨찾기 ${favorites.size}`); $('filterFavorites').setAttribute('aria-pressed', String(state.activityFilter === 'favorites'));
  // A display projection only: live off-page rows never alter stored pages or native cursors.
  const stored = new Map();
  for (const row of [...state.favorites, ...state.rows, ...state.activityRows]) {
    const previous = stored.get(row.id);
    stored.set(row.id, { ...previous, ...row, updatedAt: newestUpdate(previous?.updatedAt, row.updatedAt) });
  }
  const source = state.activityFilter === 'all' ? [...stored.values()] : state.activityFilter === 'favorites' ? state.favorites.map(r => stored.get(r.id)) : state.activityFilter === 'working' ? working.map(r => stored.get(r.id)) : unread.map(r => stored.get(r.id));
  const search = $('search').value.trim().toLocaleLowerCase();
  const rows = source.map(row => {
    const known = state.activity.get(row.id)?.listing;
    return { ...row, title: known?.title || row.title, updatedAt: newestUpdate(row.updatedAt, known?.updatedAt) };
  }).filter(r => !search || r.title.toLocaleLowerCase().includes(search)).sort(compareWork);
  const ids = new Set(rows.map(r => r.id));
  for (const [id, ui] of state.threadNodes) if (!ids.has(id)) { ui.root.remove(); state.threadNodes.delete(id); }
  let position = 0;
  for (const row of rows) {
    let ui = state.threadNodes.get(row.id);
    if (!ui) {
      const button = node('button', undefined, 'thread-row'); button.type = 'button';
      ui = { button, title: node('strong'), status: node('span', '', 'thread-status'), unread: node('span', '', 'unread-mark'), preview: node('span', '', 'thread-preview'), meta: node('small') };
      const line = node('span', undefined, 'thread-state'); line.append(ui.status, ui.unread);
      button.append(ui.title, line, ui.preview, ui.meta); button.onclick = () => openThread(row.id);
      ui.root = node('div', undefined, 'thread-entry'); ui.star = node('button', '☆', 'thread-star'); ui.star.type = 'button';
      ui.star.onclick = () => {
        const index = state.favorites.findIndex(r => r.id === row.id);
        if (index >= 0) state.favorites.splice(index, 1);
        else if (state.favorites.length < 32) state.favorites.push({ id: row.id, title: ui.title.textContent });
        else { $('listStatus').textContent = '즐겨찾기는 기기에 최대 32개까지 저장합니다.'; return; }
        renderList(); persistDevice(true);
      };
      ui.root.append(button, ui.star); state.threadNodes.set(row.id, ui);
    }
    ui.star.setAttribute('aria-label', `${row.title} · 즐겨찾기 ${favorites.has(row.id) ? '해제' : '추가'}`);
    ui.star.setAttribute('aria-pressed', String(favorites.has(row.id))); setText(ui.star, favorites.has(row.id) ? '★' : '☆');
    const entry = state.activity.get(row.id), live = state.activityRows.find(r => r.id === row.id);
    const status = live?.status ?? 'unavailable', stale = !state.activityAvailable || live?.stale;
    ui.button.setAttribute('aria-current', String(row.id === state.selected));
    ui.button.dataset.status = stale ? 'unknown' : status;
    setText(ui.title, row.title);
    const completed = status === 'idle' && entry?.completedTurn && entry.completedTurn === live?.preview?.turnId;
    setText(ui.status, `${completed ? '작업 종료 · ' : ''}${statusLabels[status] || statusLabels.unknown}${stale && live ? ' · 확인 지연' : ''}`);
    ui.unread.hidden = !isUnread(entry); setText(ui.unread, entry?.unread ? '새 응답' : 'PC 안 읽음');
    const viewed = entry?.viewed && entry.viewed.at >= (live?.previewCheckedAt ?? -1) ? entry.viewed : null;
    const preview = viewed ? viewed.preview : live?.preview;
    setText(ui.preview, preview ? `${stale || (live?.previewState === 'stale' && (!viewed || live.previewCheckedAt >= viewed.at)) ? '이전 확인 · ' : preview.phase === 'commentary' ? '진행 메시지 · ' : 'Codex · '}${preview.text}` : viewed || live?.previewState === 'ready' ? '최근 턴에 표시할 답변이 없습니다.' : live?.previewState === 'unavailable' ? '답변 미리보기 확인 불가' : '답변 미리보기 확인 대기');
    setText(ui.meta, [row.cwd, row.model || row.modelProvider, date(row.updatedAt) || '작업 시각 확인 불가'].filter(Boolean).join(' · '));
    if (list.children[position] !== ui.root) list.insertBefore(ui.root, list.children[position] || null);
    position++;
  }
  $('activityEmpty').hidden = rows.length !== 0 || state.activityFilter === 'all';
  setText($('activityEmpty'), state.activityFilter === 'favorites' ? '별표를 눌러 이 기기에 즐겨찾기를 추가하세요.' : state.activityFilter === 'working' ? '현재 확인된 작업 중 대화가 없습니다.' : '새 응답이 있는 대화가 없습니다.');
  $('moreThreads').hidden = state.activityFilter !== 'all' || !state.listCursor;
  // insertBefore may blur a moved subtree in a real browser; don't replace nodes or focus the chat.
  if (focusedRow && [...state.threadNodes.values()].includes(focusedRow) && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  $('sidebar').scrollTop = scroll;
}
function renderNotice() {
  const next = [...state.notifications.values()].at(-1);
  $('activityNotice').hidden = !next || !state.csrf;
  state.notice = next;
  if (!next) return;
  setText($('noticeTitle'), `${next.title} · 새 응답${state.notifications.size > 1 ? ` 외 ${state.notifications.size - 1}개` : ''}`);
  setText($('noticeSnippet'), next.text);
}
$('openActivityNotice').onclick = () => { if (state.notice) openThread(state.notice.id); };
$('dismissActivityNotice').onclick = () => { if (state.notice) state.notifications.delete(state.notice.id); renderNotice(); };
function receiveActivity(result) {
  state.activityAvailable = result.available;
  state.activityRows = result.data;
  for (const row of result.data) {
    const entry = activityEntry(row.id);
    entry.listing = { title: row.title, updatedAt: newestUpdate(entry.listing?.updatedAt, row.updatedAt) };
    if (!row.desktopUnread) entry.desktopDismissed = false;
    entry.desktopUnread = row.desktopUnread;
    if (row.previewState !== 'ready' || row.previewCheckedAt <= entry.seenAt || (entry.previewCheckedAt !== undefined && row.previewCheckedAt < entry.previewCheckedAt)) continue;
    if (['active', 'waiting'].includes(row.status)) {
      entry.completedTurn = null;
      if (row.preview?.turnStatus === 'inProgress') entry.workingTurn = row.preview.turnId;
    } else if (row.status === 'idle' && row.preview?.turnStatus === 'completed' && row.preview.turnId === entry.workingTurn) entry.completedTurn = row.preview.turnId;
    const version = row.preview?.version ?? null;
    if (entry.baseline && version && version !== entry.version && !entry.seen.has(version)) {
      entry.unread = true;
      if (!(row.id === state.selected && viewingCurrent())) {
        state.notifications.delete(row.id);
        state.notifications.set(row.id, { id: row.id, title: row.title, text: row.preview.text, version, at: row.previewCheckedAt });
        while (state.notifications.size > 8) state.notifications.delete(state.notifications.keys().next().value);
      }
    }
    entry.baseline = true; entry.version = version; entry.previewCheckedAt = row.previewCheckedAt;
  }
  const keep = new Set([...result.data.map(r => r.id), ...state.rows.map(r => r.id), ...state.favorites.map(r => r.id), state.selected]);
  for (const id of state.activity.keys()) if (!keep.has(id)) { state.activity.delete(id); state.notifications.delete(id); }
  setText($('activityStatus'), result.available ? '' : 'PC 활동 확인 지연 · 이전 표시를 유지합니다.');
  renderList(); renderNotice(); persistDevice();
}
function markViewed() {
  const rendered = state.renderedPreview;
  if (state.restoring || !rendered || !viewingCurrent() || !atLatest() || rendered.id !== state.selected) return;
  const entry = activityEntry(rendered.id), version = rendered.preview?.version ?? null;
  if (version) { entry.seen.add(version); while (entry.seen.size > 8) entry.seen.delete(entry.seen.values().next().value); }
  if (rendered.at >= entry.seenAt) entry.viewed = { preview: rendered.preview, at: rendered.at };
  entry.seenAt = Math.max(entry.seenAt, rendered.at);
  if (entry.previewCheckedAt === undefined || entry.previewCheckedAt <= rendered.at || entry.version === version) {
    entry.unread = false; entry.desktopDismissed = true; entry.baseline = true; entry.version = version;
    entry.previewCheckedAt = rendered.at;
  }
  const notice = state.notifications.get(rendered.id);
  if (notice && (notice.version === version || notice.at <= rendered.at)) state.notifications.delete(rendered.id);
  renderList(); renderNotice(); persistDevice();
}
$('history').addEventListener('scroll', () => {
  const area = $('history'), upward = area.scrollTop < state.reveal.top - 1;
  if (upward) state.reveal.away = true;
  else if (area.scrollHeight - area.scrollTop - area.clientHeight <= 2) state.reveal.away = false;
  if (upward || !atLatest()) stopReveal();
  state.reveal.top = $('history').scrollTop;
  if (atLatest() && !state.restoring) state.latestAnswer.pending = false;
  renderLatestAnswer(); markViewed(); persistDevice();
});
for (const event of ['pointerdown', 'keydown', 'copy']) $('history').addEventListener(event, stopReveal);
$('history').addEventListener('wheel', e => { if (e.deltaY < 0) { state.reveal.away = true; stopReveal(); } }, { passive: true });
function refreshActivity() {
  if (document.hidden || !state.csrf) return Promise.resolve();
  const authEpoch = state.authEpoch;
  if (state.activityFlight?.authEpoch === authEpoch) return state.activityFlight.promise;
  const promise = (async () => {
    try {
      const result = await api('/api/activity');
      if (authEpoch !== state.authEpoch || !state.csrf || document.hidden) return;
      receiveActivity(result);
      if (state.listRetry && !state.listBusy && state.listRetry.search === $('search').value.trim()) await loadList(state.listRetry.more);
    } catch (e) {
      if (authEpoch !== state.authEpoch || !state.csrf || e.code === 'STALE_RESPONSE') return;
      state.activityAvailable = false;
      setText($('activityStatus'), 'PC 활동에 연결할 수 없습니다. 자동으로 다시 확인합니다.'); renderList();
    }
  })();
  state.activityFlight = { authEpoch, promise };
  promise.finally(() => { if (state.activityFlight?.promise === promise) state.activityFlight = null; });
  return promise;
}
async function foregroundReceipts() {
  if (state.pending && !state.sending) await checkPending();
  const c = state.creation;
  if (c.receipt && ['reserved', 'pending', 'uncertain'].includes(c.receipt.state) && !c.busy && Date.now() >= (c.nextAt || 0)) {
    c.attempt = Math.min(5, (c.attempt || 0) + 1); c.nextAt = Date.now() + Math.min(32000, 2000 * 2 ** c.attempt);
    await checkCreation(true);
  }
}
function scheduleActivity() {
  clearTimeout(state.activityTimer);
  if (document.hidden || !state.csrf || navigator.onLine === false || state.recovery.suspended) return;
  state.activityTimer = setTimeout(async () => {
    try {
      if (state.accounts.revision) { await accountPresence(); if (state.accounts.busy || state.accounts.stale || state.tools.pane === 'accounts' && $('toolsDialog').open) await refreshAccounts(); }
      if (accountLocked()) return;
      if (state.recovery.gated) await recoverVisible(); else { await foregroundReceipts(); await refreshActivity(); refreshRelease(); }
    }
    catch (e) { if (e.code !== 'STALE_RESPONSE') showError(e); }
    finally { scheduleActivity(); }
  }, state.recovery.failures ? Math.min(32000, 4000 * 2 ** Math.min(state.recovery.failures, 3)) : state.activityAvailable ? 4000 : 8000);
}
for (const [id, filter] of [['filterAll', 'all'], ['filterWorking', 'working'], ['filterUnread', 'unread'], ['filterFavorites', 'favorites']]) $(id).onclick = () => { state.activityFilter = filter; renderList(); };
async function loadList(more = false) {
  const epoch = ++state.searchEpoch, search = $('search').value.trim();
  state.listBusy = epoch;
  $('listStatus').textContent = '대화를 불러오고 있습니다…'; $('moreThreads').disabled = true;
  try {
    const q = new URLSearchParams(); if (more && state.listCursor) q.set('cursor', state.listCursor);
    if (search) q.set('search', search);
    const result = await api(`/api/threads?${q}`); if (epoch !== state.searchEpoch) return;
    const rows = more ? [...state.rows, ...result.data] : result.data;
    const merged = new Map();
    for (const row of rows) { const previous = merged.get(row.id); merged.set(row.id, { ...previous, ...row, updatedAt: newestUpdate(previous?.updatedAt, row.updatedAt) }); }
    state.rows = [...merged.values()]; state.listCursor = result.nextCursor; state.listRetry = null;
    renderList();
    $('listScope').textContent = [result.searchScope, '불러온 대화·현재 활동만 최근 작업순 · 활동 제목은 기기에서 검색'].filter(Boolean).join(' · ');
    $('listStatus').textContent = [state.rows.length ? '' : '저장 대화 조회 결과가 없습니다.',
      result.warning ? result.scope === 'recent-desktop' ? result.warning : 'PC 실시간 제목·상태 병합을 하지 못했습니다.' : ''].filter(Boolean).join(' · ');
  } catch (e) {
    if (epoch === state.searchEpoch && state.csrf) { state.listRetry = { more, search }; $('listStatus').textContent = errorText(e); }
  } finally {
    if (epoch === state.searchEpoch) { state.listBusy = null; $('moreThreads').disabled = false; }
  }
}
let searchTimer;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadList(), 300); };
$('refreshList').onclick = () => { loadList(); refreshActivity().finally(scheduleActivity); }; $('moreThreads').onclick = () => loadList(true);
$('back').onclick = semanticBack;
window.addEventListener('popstate', () => {
  closeListMenu(); stopReveal(); navigation.revision++; navigation.quietUntil = performance.now() + 350;
  const layer = finishToolLayer();
  if (ownEntry('layer')) {
    const base = history.state.base === 'chat' && state.csrf ? 'chat' : 'list';
    history.replaceState(navigationEntry(base), '', base === 'chat' ? '#conversation' : location.pathname + location.search);
  }
  const chat = Boolean(state.csrf && !$('appView').hidden && state.selected && ownEntry('chat'));
  if (!chat && document.body.dataset.chat === 'true') leaveConversation();
  document.body.dataset.chat = chat ? 'true' : 'false';
  if (!chat) { clearTimeout(state.timer); pauseVideos(true); }
  if (!chat && !ownEntry('list')) listEntry();
  if (chat && !layer) schedulePoll();
  finishTraversal();
  // Back/layer dismissal reuses loaded state. Only an explicit open or normal polling reads the network.
});
async function openThread(id) {
  closeListMenu(); stopReveal(); state.reveal.away = false;
  const authEpoch = state.authEpoch, intent = ++navigation.intent, imageClosing = closeImage();
  const closing = clearTools() || imageClosing || navigation.pending?.promise;
  if (closing) await closing;
  if (authEpoch !== state.authEpoch || intent !== navigation.intent || !state.csrf || state.loggingOut) return;
  persistDevice(true);
  const position = state.positions.get(id); state.restoring = true;
  clearTools(); closeImage(); pauseVideos(true); state.historyNodes.clear(); state.videos.clear(); clearQuestions();
  $('moreHistory').disabled = false;
  if (state.selected && state.draftThread === state.selected) state.drafts.set(state.selected, $('draft').value);
  clearTimeout(state.timer); state.connected = false; state.selected = id;
  const epoch = ++state.epoch;
  state.latestAnswer = { key: null, pending: false }; renderLatestAnswer();
  state.turns.clear(); state.rendered = null; state.renderedPreview = null; state.historyCursor = null; state.historyGap = null; state.historyMessage = ''; state.capability = {}; state.recoverRequest = null; state.status = 'unknown'; clearError();
  $('messages').replaceChildren(); $('moreHistory').hidden = true; $('historyStatus').textContent = '대화 기록을 불러오고 있습니다…';
  $('chatTitle').textContent = state.rows.find(r => r.id === id)?.title || '대화'; $('chatMeta').textContent = '';
  $('draft').value = state.drafts.get(id) || ''; state.draftThread = id;
  document.body.dataset.chat = 'true'; navigation.revision++;
  if (!ownEntry('chat')) {
    if (!ownEntry('list')) listEntry();
    history.pushState(navigationEntry('chat'), '', '#conversation');
  }
  renderList(); composerState(); loadOptions();
  try { await refreshCurrent(epoch); await restorePosition(position, id, epoch); }
  catch (e) { if (epoch === state.epoch) { $('historyStatus').textContent = ''; showError(e); } }
  finally { if (epoch === state.epoch) { state.restoring = false; if (!position || position.bottom) markViewed(); persistDevice(); schedulePoll(); } }
}
function historyStatus(message = state.historyMessage) {
  state.historyMessage = message;
  const gap = state.historyGap;
  const note = !gap ? '' : gap.exhausted ? '복원한 기록의 연결을 확인하지 못했습니다. 일부 중간 기록은 PC에서 확인해 주세요.' : '복원한 위치와 최신 기록 사이에 아직 불러오지 않은 기록이 있습니다. 이전 기록 불러오기로 순서대로 채워 주세요.';
  $('historyStatus').textContent = [message, note].filter(Boolean).join(' ');
  $('moreHistory').hidden = !state.historyCursor && !(gap?.tailCursor && !gap.recovering);
  setText($('moreHistory'), !state.historyCursor && gap?.tailCursor && !gap.recovering ? '복원한 위치의 더 이전 기록' : '이전 기록 불러오기');
}
async function restorePosition(position, id, epoch) {
  if (epoch !== state.epoch) return;
  const area = $('history');
  if (!position || position.bottom) { area.scrollTop = area.scrollHeight; return; }
  let cursor = position.cursor || state.historyCursor;
  for (let n = 0; !state.historyNodes.has(position.key) && cursor && n < 3; n++) {
    let page;
    try { page = await api(`/api/threads/${id}/history?cursor=${encodeURIComponent(cursor)}`); }
    catch (e) { if (epoch !== state.epoch || e.code === 'AUTH_REQUIRED' || e.code === 'STALE_RESPONSE') return; break; }
    if (epoch !== state.epoch) return;
    if (!Array.isArray(page.data)) break;
    const older = [...page.data].reverse().filter(t => !state.turns.has(t.id)).map(t => [t.id, { ...t, pageCursor: cursor }]);
    if (!state.historyGap && older.length && cursor !== state.historyCursor) state.historyGap = { ids: new Set(page.data.map(t => t.id)), recovering: false, exhausted: !state.historyCursor };
    if (state.historyGap) { state.historyGap.tailCursor = page.nextCursor; state.historyGap.tailAnchor = page.data.at(-1)?.id ?? state.historyGap.tailAnchor; }
    state.turns = new Map([...older, ...state.turns]); sortTurns(); renderHistory(false); cursor = page.nextCursor;
  }
  if (epoch !== state.epoch) return;
  const ui = state.historyNodes.get(position.key);
  if (ui) { area.scrollTop += (ui.root.getBoundingClientRect?.().top ?? 0) - (area.getBoundingClientRect?.().top ?? 0) - position.offset; historyStatus(); }
  else { area.scrollTop = area.scrollHeight; historyStatus('저장한 읽기 위치를 찾지 못해 최신 기록을 열었습니다. 이전 기록에서 다시 찾아 주세요.'); }
}
function schedulePoll() {
  clearTimeout(state.timer);
  if (!viewingCurrent() || !state.selected || !state.csrf || navigator.onLine === false || state.recovery.suspended || state.recovery.gated || state.errorCode === 'HISTORY_SIZE_LIMIT') return;
  const epoch = state.epoch;
  state.timer = setTimeout(async () => {
    try { if (viewingCurrent()) await refreshCurrent(epoch); }
    catch (e) { if (epoch === state.epoch) showError(e); }
    finally { if (epoch === state.epoch) schedulePoll(); }
  }, state.status === 'active' ? 2000 : 8000);
}
function refreshCurrent(epoch = state.epoch) {
  if (!state.selected || !state.csrf) return Promise.resolve();
  if (state.refresh?.epoch === epoch) return state.refresh.promise;
  const id = state.selected, version = state.reveal.version, started = performance.now(), read = state.reveal.read;
  const previous = [...state.turns.values()].at(-1);
  const fresh = revealAllowed() && read?.epoch === epoch && read.version === version && started - read.at < 12000;
  const promise = (async () => {
    try {
      const [meta, page] = await Promise.all([api(`/api/threads/${id}`), api(`/api/threads/${id}/history`)]);
      if (epoch !== state.epoch || !state.csrf) return;
      state.connected = true; state.capability = { ...meta.capability, uncertain: meta.uncertain };
      state.serverSending = meta.sending; state.status = page.status; state.recoverRequest = meta.uncertainRequest;
      if ((connectionErrors.has(state.errorCode) || ['HISTORY_SIZE_LIMIT', 'DESKTOP_TOOL_FAILED'].includes(state.errorCode)) && !state.pending) clearError();
      $('chatTitle').textContent = meta.thread.title;
      if (meta.thread.id === id) {
        const entry = activityEntry(id);
        entry.listing = { title: meta.thread.title, updatedAt: newestUpdate(entry.listing?.updatedAt, meta.thread.updatedAt) };
        renderList();
      }
      $('chatMeta').textContent = [meta.thread.cwd, meta.thread.model || meta.thread.modelProvider, date(meta.thread.updatedAt)].filter(Boolean).join(' · ');
      $('policyNotice').textContent = 'PC의 기존 대화로 이어집니다. 승인·중단은 PC에서 처리해 주세요.';
      if (!state.turns.size || (page.data[0] && !state.turns.has(page.data[0].id))) {
        state.historyCursor = page.nextCursor; state.historyAnchor = page.data.at(-1)?.id;
      }
      // A new latest turn starts its own actual cursor chain, so smaller pages cannot skip intervening turns.
      for (const t of [...page.data].reverse()) state.turns.set(t.id, { ...t, pageCursor: null });
      const live = fresh && version === state.reveal.version && performance.now() - started < 10000 &&
        Number.isFinite(page.previewCheckedAt) && page.previewCheckedAt > read.checkedAt && revealAllowed()
        ? { turnId: previous?.id, turnStatus: previous?.status } : null;
      sortTurns(); renderHistory(true, live, true);
      state.reveal.read = version === state.reveal.version && viewingCurrent() && navigator.onLine !== false
        ? { epoch, version, at: performance.now(), checkedAt: page.previewCheckedAt } : null;
      historyStatus(page.outputsOmitted ? '기록 크기를 줄이기 위해 도구 출력을 생략했습니다. 전체 출력은 PC에서 확인해 주세요.' : state.turns.size ? '' : '이 대화에는 아직 표시할 기록이 없습니다.');
      if (Number.isFinite(page.previewCheckedAt)) {
        state.renderedPreview = { id, preview: page.preview, at: page.previewCheckedAt }; markViewed();
      }
      composerState(); refreshQuestions(epoch);
    } catch (e) {
      if (epoch === state.epoch) { stopReveal(); state.connected = false; composerState(); }
      throw e;
    }
  })();
  state.refresh = { epoch, promise };
  promise.finally(() => { if (state.refresh?.promise === promise) state.refresh = null; }).catch(() => {});
  return promise;
}
$('moreHistory').onclick = async () => {
  stopReveal();
  const gap = state.historyGap;
  if (!state.historyCursor && gap?.tailCursor && !gap.recovering) {
    gap.recovering = true; gap.exhausted = true; state.historyCursor = gap.tailCursor; state.historyAnchor = gap.tailAnchor;
  }
  const id = state.selected, epoch = state.epoch, scroll = $('history').scrollHeight, cursor = state.historyCursor, anchor = state.historyAnchor;
  if (!cursor) return;
  $('moreHistory').disabled = true;
  try {
    const result = await api(`/api/threads/${id}/history?cursor=${encodeURIComponent(cursor)}`);
    if (epoch !== state.epoch) return;
    const incoming = [...result.data].reverse().map(t => state.turns.get(t.id) || { ...t, pageCursor: cursor });
    const ids = new Set(incoming.map(t => t.id));
    const remaining = [...state.turns.values()].filter(t => !ids.has(t.id));
    const position = remaining.findIndex(t => t.id === anchor);
    remaining.splice(position < 0 ? 0 : position, 0, ...incoming);
    state.turns = new Map(remaining.map(t => [t.id, t]));
    if (state.historyGap && !state.historyGap.recovering && result.data.some(t => state.historyGap.ids.has(t.id))) state.historyGap = null;
    if (state.historyCursor === cursor) {
      state.historyCursor = result.nextCursor; state.historyAnchor = result.data.at(-1)?.id ?? anchor;
      if (!result.nextCursor && state.historyGap) state.historyGap.exhausted = true;
    }
    sortTurns(); renderHistory(false);
    $('history').scrollTop += $('history').scrollHeight - scroll; historyStatus();
  } catch (e) { if (epoch === state.epoch) showError(e); }
  finally { if (epoch === state.epoch) $('moreHistory').disabled = false; }
};
function sortTurns() {
  const time = t => typeof t.startedAt === 'number' ? t.startedAt : Date.parse(t.startedAt);
  const turns = [...state.turns.values()];
  // Keep cursor insertion order when the desktop provides no comparable timestamps.
  if (turns.every(t => t.startedAt != null && Number.isFinite(time(t)))) turns.sort((a, b) => time(a) - time(b));
  state.turns = new Map(turns.map(t => [t.id, t]));
}
const imageView = { generation: 0, source: null, ready: false, width: 0, height: 0, fitWidth: 0, fitHeight: 0, scale: 1, x: 0, y: 0, pointers: new Map(), gesture: null, tap: null, touchUntil: 0, opener: null, observer: null };
function imageGestures() {
  const ids = [...imageView.pointers.keys()];
  imageView.pointers.clear(); imageView.gesture = null; imageView.tap = null;
  for (const id of ids) { try { $('imageStage').releasePointerCapture(id); } catch {} }
}
function paintImage() {
  const v = imageView, ready = v.ready && v.width > 0 && v.height > 0;
  const boundX = Math.max(0, (v.fitWidth * v.scale - v.width) / 2), boundY = Math.max(0, (v.fitHeight * v.scale - v.height) / 2);
  v.x = Math.max(-boundX, Math.min(boundX, v.x)); v.y = Math.max(-boundY, Math.min(boundY, v.y));
  const image = $('largeImage');
  image.style.width = `${v.fitWidth}px`; image.style.height = `${v.fitHeight}px`;
  image.style.transform = `translate(${(v.width - v.fitWidth * v.scale) / 2 + v.x}px, ${(v.height - v.fitHeight * v.scale) / 2 + v.y}px) scale(${v.scale})`;
  setText($('imageZoom'), `${Math.round(v.scale * 100)}%`);
  $('imageZoomIn').disabled = !ready || v.scale >= 6;
  $('imageZoomOut').disabled = !ready || v.scale <= 1;
  $('imageFit').disabled = !ready || v.scale === 1;
  $('imageStage').dataset.zoomed = String(ready && v.scale > 1);
}
function clearImage(restoreFocus = false) {
  const v = imageView, opener = v.opener;
  imageGestures(); v.observer?.disconnect();
  Object.assign(v, { generation: v.generation + 1, source: null, ready: false, width: 0, height: 0, fitWidth: 0, fitHeight: 0, scale: 1, x: 0, y: 0, touchUntil: 0, opener: null, observer: null });
  const image = $('largeImage'); image.onload = null; image.onerror = null; image.hidden = true; image.removeAttribute('src'); image.alt = '';
  $('imageCaption').textContent = ''; $('imageCaption').title = '';
  $('imageViewerStatus').textContent = ''; $('imageViewerStatus').hidden = true; paintImage();
  if (restoreFocus && state.csrf && !document.hidden && opener?.isConnected) opener.focus({ preventScroll: true });
}
function resizeImage() {
  const v = imageView, image = $('largeImage');
  if (!v.ready || !v.source || !$('imageDialog').open) return;
  const { width, height } = $('imageStage').getBoundingClientRect();
  if (![width, height, image.naturalWidth, image.naturalHeight].every(n => Number.isFinite(n) && n > 0)) return;
  if (width === v.width && height === v.height) return;
  imageGestures();
  const fit = Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
  Object.assign(v, { width, height, fitWidth: image.naturalWidth * fit, fitHeight: image.naturalHeight * fit, scale: 1, x: 0, y: 0 });
  paintImage();
}
function zoomImage(scale, anchor = { x: 0, y: 0 }) {
  const v = imageView;
  if (!v.ready || !v.source || !v.width || !v.height || !$('imageDialog').open || !Number.isFinite(scale)) return;
  scale = Math.max(1, Math.min(6, scale));
  const ratio = scale / v.scale;
  v.x = anchor.x - (anchor.x - v.x) * ratio; v.y = anchor.y - (anchor.y - v.y) * ratio; v.scale = scale;
  paintImage();
}
function imagePoint(e) {
  const rect = $('imageStage').getBoundingClientRect();
  return { x: e.clientX - rect.left - imageView.width / 2, y: e.clientY - rect.top - imageView.height / 2 };
}
function imageGesture() {
  const v = imageView, points = [...v.pointers.values()];
  if (!points.length) { v.gesture = null; return; }
  const a = points[0], b = points[1];
  if (b) { v.tap = null; points.forEach(p => { p.moved = true; }); }
  v.gesture = { scale: v.scale, x: v.x, y: v.y, mid: b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: a.x, y: a.y }, distance: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 };
}
function imagePointerDown(e) {
  const v = imageView;
  if (!v.ready || !v.source || !v.width || !$('imageDialog').open || (e.button != null && e.button !== 0) || v.pointers.size >= 2 || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
  e.preventDefault();
  const point = imagePoint(e);
  v.pointers.set(e.pointerId, { ...point, startX: point.x, startY: point.y, at: performance.now(), type: e.pointerType, moved: false });
  try { $('imageStage').setPointerCapture(e.pointerId); } catch {}
  imageGesture();
}
function imagePointerMove(e) {
  const v = imageView, point = v.pointers.get(e.pointerId), gesture = v.gesture;
  if (!point || !gesture || !Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
  e.preventDefault(); Object.assign(point, imagePoint(e));
  if (Math.hypot(point.x - point.startX, point.y - point.startY) > 6) { point.moved = true; v.tap = null; }
  const [a, b] = [...v.pointers.values()];
  const mid = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
  const scale = b && gesture.distance > 1 ? Math.max(1, Math.min(6, gesture.scale * Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance)) : gesture.scale;
  const ratio = scale / gesture.scale;
  v.x = mid.x - (gesture.mid.x - gesture.x) * ratio; v.y = mid.y - (gesture.mid.y - gesture.y) * ratio; v.scale = scale;
  paintImage();
}
function imagePointerUp(e) {
  const v = imageView, point = v.pointers.get(e.pointerId);
  if (!point) return;
  e.preventDefault();
  if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
    Object.assign(point, imagePoint(e));
    if (Math.hypot(point.x - point.startX, point.y - point.startY) > 6) point.moved = true;
  }
  v.pointers.delete(e.pointerId);
  try { $('imageStage').releasePointerCapture(e.pointerId); } catch {}
  const now = performance.now();
  if (point.type === 'touch') {
    v.touchUntil = now + 500;
    if (!point.moved && !v.pointers.size && now - point.at <= 300) {
      if (v.tap && now - v.tap.at <= 300 && Math.hypot(point.x - v.tap.x, point.y - v.tap.y) <= 24) {
        zoomImage(v.scale > 1 ? 1 : 2.5, point); v.tap = null;
      } else v.tap = { at: now, x: point.x, y: point.y };
    } else v.tap = null;
  }
  imageGesture();
}
async function openImage(media, alt, opener) {
  if (!state.csrf || !validMedia(media) || media.kind === 'video') return;
  const authEpoch = state.authEpoch, epoch = state.epoch, intent = ++navigation.intent;
  const pending = navigation.pending?.promise || (state.tools.layer?.closing ? state.tools.layer.promise : null);
  if (pending) await pending;
  if (!state.csrf || authEpoch !== state.authEpoch || epoch !== state.epoch || intent !== navigation.intent || document.hidden || navigation.pending) return;
  clearImage();
  const v = imageView, generation = v.generation, image = $('largeImage');
  v.source = media.url; v.opener = opener;
  image.alt = alt; $('imageCaption').textContent = alt; $('imageCaption').title = alt;
  $('imageViewerStatus').textContent = '이미지를 불러오고 있습니다…'; $('imageViewerStatus').hidden = false;
  image.onload = () => {
    if (generation !== v.generation || v.source !== media.url || !$('imageDialog').open) return;
    if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) { image.onerror(); return; }
    v.ready = true; image.hidden = false; $('imageViewerStatus').hidden = true; resizeImage(); paintImage();
  };
  image.onerror = () => {
    if (generation !== v.generation) return;
    clearImage(); $('imageCaption').textContent = '대화 이미지'; $('imageViewerStatus').textContent = '이미지를 불러오지 못했습니다. 창을 닫고 이미지 다시 확인을 눌러 주세요.'; $('imageViewerStatus').hidden = false;
  };
  openToolLayer('imageDialog'); image.src = media.url;
  if (typeof ResizeObserver === 'function') { v.observer = new ResizeObserver(() => { if (generation === v.generation) resizeImage(); }); v.observer.observe($('imageStage')); }
  $('closeImage').focus({ preventScroll: true });
}
function closeImage() {
  const closing = closeToolLayer('imageDialog'); clearImage(true); return closing;
}
$('closeImage').onclick = closeImage;
$('imageDialog').addEventListener('cancel', e => { e.preventDefault(); closeImage(); });
$('imageDialog').addEventListener('close', () => { if (!$('imageDialog').open) clearImage(true); });
$('imageZoomIn').onclick = () => { imageGestures(); zoomImage(imageView.scale * 1.5); };
$('imageZoomOut').onclick = () => { imageGestures(); zoomImage(imageView.scale / 1.5); };
$('imageFit').onclick = () => { imageGestures(); zoomImage(1); };
const imageStage = $('imageStage');
imageStage.addEventListener('pointerdown', imagePointerDown);
imageStage.addEventListener('pointermove', imagePointerMove);
imageStage.addEventListener('pointerup', imagePointerUp);
for (const event of ['pointercancel', 'lostpointercapture']) imageStage.addEventListener(event, e => { if (imageView.pointers.has(e.pointerId)) imageGestures(); });
imageStage.addEventListener('dblclick', e => { e.preventDefault(); if (performance.now() >= imageView.touchUntil && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) { imageGestures(); zoomImage(imageView.scale > 1 ? 1 : 2.5, imagePoint(e)); } });
imageStage.addEventListener('dragstart', e => e.preventDefault());
imageStage.addEventListener('keydown', e => {
  if (!imageView.ready) return;
  if (e.key === '+' || e.key === '=') $('imageZoomIn').onclick();
  else if (e.key === '-') $('imageZoomOut').onclick();
  else if (e.key === 'Home') $('imageFit').onclick();
  else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    imageGestures(); imageView.x += e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0;
    imageView.y += e.key === 'ArrowUp' ? 40 : e.key === 'ArrowDown' ? -40 : 0; paintImage();
  } else return;
  e.preventDefault();
});
paintImage();
function validMedia(media) { return media?.state === 'ready' && /^\/api\/media\/[A-Za-z0-9_-]{43}$/.test(media.url); }
const mediaErrors = {
  MEDIA_TYPE_UNSUPPORTED: '지원하지 않는 형식입니다. PNG·JPEG·WebP·GIF와 MP4만 표시합니다. 그 밖의 동영상은 PC에서 확인해 주세요.',
  MEDIA_SOURCE_UNSUPPORTED: '이 첨부의 로컬 이미지 경로를 제공받지 못했습니다. PC에서 확인해 주세요.',
  MEDIA_PATH_BLOCKED: '보호된 경로나 연결된 파일의 이미지는 표시하지 않습니다. PC에서 확인해 주세요.',
  MEDIA_TOO_LARGE: '16MiB 이하의 이미지만 표시합니다. 원본은 PC에서 확인해 주세요.',
  MEDIA_LIMIT: '한 번에 표시할 이미지 수를 초과했습니다. PC에서 확인해 주세요.'
};
async function retryImage(t, button, status, epoch, figure) {
  if (epoch !== state.epoch || !state.csrf) return;
  button.disabled = true; status.textContent = '미디어가 포함된 기록을 다시 확인하고 있습니다…';
  const id = state.selected, cursor = t.pageCursor;
  try {
    const page = await api(`/api/threads/${id}/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (epoch !== state.epoch || !state.csrf) return;
    let found = false;
    for (const value of page.data) {
      const current = state.turns.get(value.id);
      if (current && current.pageCursor === cursor) { state.turns.set(value.id, { ...value, pageCursor: cursor }); if (value.id === t.id) found = true; }
    }
    if (!found) { status.textContent = '기록 위치가 변경되었습니다. 이전 기록 불러오기로 해당 이미지를 다시 찾아 주세요.'; return; }
    const scroll = $('history').scrollTop;
    for (const ui of state.historyNodes.values()) for (const [key, value] of ui.media ?? []) if (value === figure) {
      releaseFigure(value); ui.media.delete(key); ui.signature = null;
    }
    for (const ui of state.historyNodes.values()) for (const [key, value] of ui.files ?? []) if (value === figure) { ui.files.delete(key); ui.signature = null; }
    closeImage(); state.rendered = null; renderHistory(false); $('history').scrollTop = scroll;
  } catch (e) {
    if (epoch === state.epoch && state.csrf) status.textContent = errorText(e);
  } finally { if (epoch === state.epoch) button.disabled = false; }
}
function imageFigure(media, t) {
  if (media?.kind === 'video') return videoFigure(media, t);
  const epoch = state.epoch, figure = node('figure', undefined, 'conversation-image'); figure.turn = t;
  const status = node('figcaption', undefined, 'image-status'); status.setAttribute('role', 'status');
  const actions = node('div', undefined, 'image-actions'), retry = node('button', '이미지 다시 확인'); retry.type = 'button';
  retry.onclick = () => retryImage(figure.turn, retry, status, epoch, figure); actions.append(retry);
  if (validMedia(media)) {
    const img = node('img'); img.alt = media.alt || '대화 이미지'; img.loading = 'lazy'; img.decoding = 'async';
    const large = node('button', '크게 보기'); large.type = 'button'; large.disabled = true; actions.append(large);
    status.textContent = '이미지를 불러오고 있습니다…';
    img.onload = () => { if (epoch !== state.epoch) return; img.hidden = false; large.disabled = false; status.textContent = img.alt; };
    img.onerror = () => { if (epoch !== state.epoch) return; img.hidden = true; large.disabled = true; status.textContent = '이미지를 불러오지 못했습니다. 파일이 이동·변경되었거나 주소가 만료되었을 수 있습니다. 다시 확인해 주세요.'; };
    large.onclick = () => {
      if (epoch !== state.epoch || !state.csrf || large.disabled) return;
      stopReveal(); openImage(media, img.alt, large);
    };
    img.src = media.url; figure.append(img);
  } else status.textContent = mediaErrors[media?.error] || '이미지 파일을 찾거나 읽을 수 없습니다. 다시 확인하거나 PC에서 원본을 확인해 주세요.';
  figure.append(status, actions); return figure;
}
function pauseVideos(release = false) {
  for (const video of state.videos) {
    video.pause();
    if (release) { video.removeAttribute('src'); video.load(); video.released = true; }
  }
}
function releaseFigure(figure) {
  if (!figure.video) return;
  const video = figure.video; video.pause(); video.removeAttribute('src'); video.load(); state.videos.delete(video);
}
function videoFigure(media, t) {
  const epoch = state.epoch, figure = node('figure', undefined, 'conversation-image conversation-video'); figure.turn = t;
  const status = node('figcaption', undefined, 'image-status'); status.setAttribute('role', 'status');
  const retry = node('button', '동영상 다시 확인'); retry.type = 'button';
  retry.onclick = () => retryImage(figure.turn, retry, status, epoch, figure);
  if (validMedia(media)) {
    const video = node('video'); figure.video = video; state.videos.add(video);
    video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.setAttribute('playsinline', '');
    video.setAttribute('aria-label', media.alt || '대화 동영상'); video.autoplay = false;
    status.textContent = '재생 버튼을 눌러 동영상을 확인해 주세요.';
    video.onloadedmetadata = () => { if (epoch === state.epoch) status.textContent = media.alt || '대화 동영상'; };
    video.onerror = () => {
      if (epoch !== state.epoch || video.released) return;
      video.pause(); status.textContent = video.error?.code === 3 || video.error?.code === 4
        ? '이 MP4를 재생할 수 없습니다. 손상된 파일이거나 기기에서 지원하지 않는 영상·음성 코덱일 수 있습니다. PC에서 확인해 주세요.'
        : '동영상을 읽지 못했습니다. 연결·파일 변경·주소 만료를 확인한 뒤 동영상 다시 확인을 눌러 주세요.';
    };
    video.mediaUrl = media.url; video.src = media.url; figure.append(video);
  } else status.textContent = media?.error === 'MEDIA_TOO_LARGE' ? '2GiB 이하 MP4만 재생합니다. 원본은 PC에서 확인해 주세요.' : mediaErrors[media?.error] || '동영상 파일을 찾거나 읽을 수 없습니다. 다시 확인하거나 PC에서 원본을 확인해 주세요.';
  const actions = node('div', undefined, 'image-actions'); actions.append(retry); figure.append(status, actions); return figure;
}
function reconcile(parent, children) {
  const wanted = new Set(children);
  for (const child of [...parent.children]) if (!wanted.has(child)) child.remove();
  children.forEach((child, index) => { if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null); });
}
function messageBody(ui, i, t) {
  const children = [], textParts = [], assets = [], keep = new Set(), occurrences = new Map(); let offset = 0;
  const image = media => {
    const identity = media?.kind === 'video' && validMedia(media) ? `video:${media.url}` : JSON.stringify(media);
    const n = occurrences.get(identity) || 0; occurrences.set(identity, n + 1); const key = `${identity}/${n}`; keep.add(key);
    if (!ui.media.has(key)) ui.media.set(key, imageFigure(media, t));
    const figure = ui.media.get(key); figure.turn = t; children.push(figure);
    assets.push({ kind: media?.kind === 'video' ? 'video' : 'image', label: media?.alt || '대화 이미지', identity: media?.url || key, ready: validMedia(media) });
  };
  const text = value => { const part = node('div'); if (['userMessage', 'requestNotice'].includes(i.type)) part.append(node('p', value)); else markdown(part, value); children.push(part); textParts.push(part); };
  if (i.type === 'imageView') image(i.media);
  else if (i.type === 'userMessage') { text(i.text || ''); for (const media of i.images ?? []) image(media); }
  else {
    for (const media of i.images ?? []) {
      if (!Number.isInteger(media.start) || !Number.isInteger(media.end) || media.start < offset || media.end > (i.text || '').length || media.end <= media.start) continue;
      text(i.text.slice(offset, media.start)); image(media.media); offset = media.end;
    }
    text((i.text || '').slice(offset));
  }
  ui.files ??= new Map(); const fileKeys = new Set();
  for (const ref of (i.files ?? []).slice(0, 64)) {
    const file = ref.file, key = JSON.stringify(file); fileKeys.add(key);
    if (!ui.files.has(key)) ui.files.set(key, fileActions(file, t));
    const box = ui.files.get(key); box.turn = t; children.push(box);
    assets.push({ kind: 'file', label: file?.name || file?.alt || '결과 파일', identity: file?.url || key, ready: file?.state === 'ready' && /^\/api\/files\/[A-Za-z0-9_-]{43}$/.test(file.url) });
  }
  ui.textParts = textParts;
  if (ui.copy && textParts.some(part => part.structuredMarkdown)) {
    if (!ui.rawCopy) { ui.rawCopy = node('button', '원문 복사', 'message-copy'); ui.rawCopy.type = 'button'; ui.copy.parentNode.append(ui.rawCopy); }
    const epoch = state.epoch, raw = i.text || '';
    ui.rawCopy.onclick = () => { if (epoch === state.epoch && state.csrf) return copy(raw, ui.rawCopy); };
    ui.rawCopy.hidden = false;
  } else if (ui.rawCopy) ui.rawCopy.hidden = true;
  ui.visibleText = ['userMessage', 'requestNotice'].includes(i.type) ? i.text || '' : textParts.map(visibleText).join('').trimEnd(); ui.assets = assets;
  for (const key of ui.files.keys()) if (!fileKeys.has(key)) ui.files.delete(key);
  for (const [key, figure] of ui.media) if (!keep.has(key)) { releaseFigure(figure); ui.media.delete(key); }
  // Retained media stay in their connected parent, rather than moving through a fragment.
  reconcile(ui.body, children);
}
function fileActions(file, t) {
  const box = node('div', undefined, 'result-file'); box.turn = t;
  const status = node('p', file?.name || file?.alt || '결과 파일', 'image-status'); box.append(status);
  const match = file?.state === 'ready' && /^\/api\/files\/([A-Za-z0-9_-]{43})$/.exec(file.url);
  if (!match) { status.textContent += ' · 이 파일을 저장할 수 없습니다. PC에서 원본을 확인해 주세요.'; return box; }
  const actions = node('div', undefined, 'image-actions');
  for (const op of ['save', 'share']) {
    const link = node('a', op === 'save' ? '저장' : '공유'); link.className = 'file-action'; link.href = file.url;
    link.setAttribute('download', file.name || 'result');
    link.onclick = e => {
      if (state.nativeVersion >= 2) { link.href = `/native/files/${op}/${match[1]}`; link.removeAttribute('download'); }
      else if (op === 'share' || /CodexPhone\//.test(navigator.userAgent || '')) { e.preventDefault(); status.textContent = '저장·공유는 Codex 원격 v0.2 앱에서 지원합니다. 브라우저에서는 저장 링크를 사용할 수 있습니다.'; }
      else link.href = file.url;
    };
    actions.append(link);
  }
  const retry = node('button', '파일 다시 확인'); retry.type = 'button'; retry.onclick = () => retryImage(box.turn, retry, status, state.epoch, box); actions.append(retry);
  box.append(actions); return box;
}
function appendInline(parent, value) {
  const parts = value.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) parent.append(node('strong', part.slice(2, -2)));
    else if (part.startsWith('`') && part.endsWith('`')) parent.append(node('code', part.slice(1, -1)));
    else {
      const match = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
      if (match) { const a = node('a', match[1]); a.href = match[2]; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
      else parent.append(document.createTextNode(part));
    }
  }
}
async function copy(value, button) {
  stopReveal();
  const epoch = state.epoch, authEpoch = state.authEpoch;
  const current = () => epoch === state.epoch && authEpoch === state.authEpoch && state.csrf;
  button.copyLabel ??= button.getAttribute?.('aria-label') || '메시지 복사'; button.setAttribute('aria-live', 'polite');
  const feedback = text => { button.textContent = text; button.setAttribute('aria-label', text === '복사' ? button.copyLabel : text); };
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); copied = true; } catch { /* HTTP may deny Clipboard API. */ }
    }
    if (!current()) return;
    if (!copied) {
      const active = document.activeElement, area = node('textarea'); area.value = value; area.className = 'sr-only'; document.body.append(area);
      let ok = false;
      try { area.focus(); area.select(); ok = typeof document.execCommand === 'function' && document.execCommand('copy'); }
      finally { area.remove(); active?.focus(); }
      if (!ok) throw new Error();
    }
    feedback('복사됨'); setTimeout(() => { if (current()) feedback('복사'); }, 1400);
  } catch {
    if (!current()) return;
    feedback('직접 복사 필요'); $('manualCopy').value = value;
    openToolLayer('copyDialog'); $('selectCopy').focus();
  }
}
function markdown(target, value) {
  if (value.length > 131072) { const p = node('p', value); target.append(p); return; }
  const lines = value.split('\n'); if (lines.length > 4096) { target.append(node('p', value)); return; }
  let plain = [], i = 0;
  const flush = () => { markdownBlocks(target, plain.join('\n')); plain = []; };
  while (i < lines.length) {
    const fence = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/.exec(lines[i]);
    if (!fence) { plain.push(lines[i++]); continue; }
    flush(); const start = ++i, mark = fence[1][0], minimum = fence[1].length;
    while (i < lines.length) {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(lines[i]);
      if (close && close[1][0] === mark && close[1].length >= minimum) break;
      i++;
    }
    const text = lines.slice(start, i).join('\n') + (i > start && i < lines.length ? '\n' : '');
    const label = node('div', undefined, 'code-label'); label.append(node('span', fence[2].trim() || '코드'));
    const button = node('button', '복사'); button.type = 'button'; button.onclick = () => copy(text, button); label.append(button);
    const pre = node('pre'); pre.append(node('code', text)); target.append(label, pre); if (i < lines.length) i++;
  }
  flush();
}
const executionLabels = { commandExecution: '명령 실행', fileChange: '파일 변경', mcpToolCall: '도구 실행', webSearch: '검색', review: '검토', contextCompaction: '문맥 정리', sleep: '대기' };
function executionGroup(t, items, keep) {
  const key = JSON.stringify([t.id, 'execution-group']); keep.add(key);
  let ui = state.historyNodes.get(key);
  if (!ui) {
    const root = node('details', undefined, 'execution-group'), summary = node('summary'), body = node('div', undefined, 'execution-body');
    root.append(summary, body); ui = { root, summary, body, rows: new Map(), media: new Map() }; state.historyNodes.set(key, ui);
  }
  ui.pageCursor = t.pageCursor ?? null;
  const failures = items.filter(i => ['failed', 'error', 'declined'].includes(i.status) || (Number.isInteger(i.exitCode) && i.exitCode !== 0)).length;
  setText(ui.summary, `작업 내역 ${items.length}개${failures ? ` · 실패 ${failures}개` : ''}`); ui.root.dataset.failed = String(Boolean(failures));
  const children = [], ids = new Set();
  items.slice(0, 100).forEach((i, index) => {
    const id = JSON.stringify([i.id ?? index, i.type]); ids.add(id); let row = ui.rows.get(id);
    if (!row) { const root = node('div', undefined, 'execution-item'), label = node('p'), detail = node('pre'); root.append(label, detail); row = { root, label, detail }; ui.rows.set(id, row); }
    const failed = ['failed', 'error', 'declined'].includes(i.status) || (Number.isInteger(i.exitCode) && i.exitCode !== 0);
    setText(row.label, `${executionLabels[i.type] || '기타 작업'}${failed ? ' · 실패' : ''}`);
    const value = executionLabels[i.type] ? [i.text, i.detail].filter(v => typeof v === 'string').map(v => v.slice(0, 1500)).join('\n') : '';
    setText(row.detail, value); row.detail.hidden = !value; children.push(row.root);
  });
  for (const [id, row] of ui.rows) if (!ids.has(id)) { row.root.remove(); ui.rows.delete(id); }
  if (items.length > 100) { ui.note ??= node('p', '처음 100개 작업의 제한된 상세만 표시합니다. 전체 내역은 PC에서 확인해 주세요.'); children.push(ui.note); }
  reconcile(ui.body, children); return ui.root;
}
function renderHistory(follow = true, live = null, received = false) {
  if (!live || !revealAllowed()) flushReveal();
  if (viewingCurrent()) for (const video of state.videos) if (video.released) { video.released = false; video.src = video.mediaUrl; }
  const signature = JSON.stringify([...state.turns.values()].map(t => ({ ...t, items: (t.items ?? []).filter(i => i.type !== 'reasoning') })));
  if (signature === state.rendered) return; // Keep expanded outputs and copy focus on unchanged polls.
  state.rendered = signature;
  const area = $('history'), nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 160;
  const empty = !$('messages').childElementCount, children = [], keep = new Set();
  const latest = [...state.turns.values()].at(-1), lastAssistant = latest?.items?.filter(i => i.type === 'agentMessage').at(-1);
  let incoming = null, changedAnswer = false, answerKey = null;
  const hadHistory = state.historyNodes.size > 0;
  for (const t of state.turns.values()) {
    const visible = (t.items ?? []).filter(i => i.type !== 'reasoning');
    const executions = visible.filter(i => !['userMessage', 'requestNotice', 'agentMessage', 'plan', 'imageView'].includes(i.type));
    let grouped = false, previousAssistant = false;
    visible.forEach((i, index) => {
      if (!['userMessage', 'requestNotice', 'agentMessage', 'plan', 'imageView'].includes(i.type)) {
        if (!grouped) { children.push(executionGroup(t, executions, keep)); grouped = true; }
        return;
      }
      const key = JSON.stringify([t.id, i.id ?? index, i.type]); keep.add(key);
      if (i.type === 'agentMessage' && i.text) answerKey = key;
      let ui = state.historyNodes.get(key);
      if (!ui) {
        const message = ['userMessage', 'requestNotice', 'agentMessage', 'plan', 'imageView'].includes(i.type);
        const root = node(message ? 'article' : 'details', undefined, message ? `message ${i.type}` : 'tool-message');
        const body = node('div', undefined, 'body');
        const role = i.type === 'imageView' ? null : node('div', i.type === 'userMessage' ? '나' : i.type === 'requestNotice' ? '요청 전달 기록 · 원문 확인 불가' : i.type === 'plan' ? 'Codex · 계획' : 'Codex', 'role');
        const head = node('div', undefined, 'message-head');
        if (role) head.append(role);
        ui = { root, body, role, media: new Map(), message, kind: i.type };
        if (['userMessage', 'agentMessage', 'plan'].includes(i.type)) {
          const button = node('button', '복사', 'message-copy'); button.type = 'button'; button.setAttribute('aria-label', `${i.type === 'userMessage' ? '내' : 'Codex'} 메시지 복사`);
          const epoch = state.epoch;
          button.onclick = () => { if (epoch === state.epoch && state.csrf && ui.visibleText) return copy(ui.visibleText, button); };
          ui.copy = button; head.append(button);
        }
        if (role) root.append(head); root.append(body);
        state.historyNodes.set(key, ui);
      }
      if (state.reveal.active?.ui === ui && (t !== latest || i !== lastAssistant)) flushReveal();
      if (ui.role) ui.role.hidden = i.type === 'agentMessage' && previousAssistant;
      if (i.type !== 'imageView') previousAssistant = i.type === 'agentMessage';
      const itemSignature = JSON.stringify(i);
      if (ui.signature !== itemSignature) {
        const raw = i.text || '', old = ui.rawText;
        if (received && hadHistory && !state.restoring && i.type === 'agentMessage' && raw && raw !== old && t === latest) changedAnswer = true;
        const eligible = live && t === latest && i === lastAssistant && !t.error && raw.length <= 16384 &&
          (t.status === 'inProgress' || t.status === 'completed') &&
          (old === undefined ? t.status === 'inProgress' || live.turnId === t.id && live.turnStatus === 'inProgress'
            : t.status === 'inProgress' && ui.turnStatus === t.status && raw !== old && raw.startsWith(old));
        const pending = state.reveal.active?.ui === ui ? state.reveal.active : null;
        const before = eligible && old !== undefined ? pending?.text ?? revealLeaves(ui)?.text : '';
        if (pending) flushReveal();
        messageBody(ui, i, t); ui.signature = itemSignature; ui.rawText = raw;
        if (eligible && before !== undefined) incoming = { ui, before, pending };
      }
      ui.turnStatus = t.status;
      if (state.reveal.active?.ui === ui && (t.status !== 'inProgress' || t.error)) flushReveal();
      ui.pageCursor = t.pageCursor ?? null;
      for (const figure of ui.media.values()) figure.turn = t;
      children.push(ui.root);
    });
    if (t.status !== 'completed' || t.error) {
      const key = JSON.stringify([t.id, 'turn-status']); keep.add(key);
      if (!state.historyNodes.has(key)) state.historyNodes.set(key, { root: node('p', undefined, 'turn-status'), media: new Map() });
      const ui = state.historyNodes.get(key); ui.pageCursor = t.pageCursor ?? null; setText(ui.root, t.error ? '이 턴에서 오류가 발생했습니다. 작업 내역과 PC 상태를 확인해 주세요.' : t.status === 'inProgress' ? 'Codex가 작업 중입니다…' : t.status === 'interrupted' ? '작업이 중지되었습니다.' : '작업이 완료되지 않았습니다. PC에서 확인해 주세요.'); children.push(ui.root);
    }
  }
  for (const [key, ui] of state.historyNodes) if (!keep.has(key)) { if (state.reveal.active?.ui === ui) flushReveal(); for (const figure of ui.media.values()) releaseFigure(figure); ui.root.remove(); state.historyNodes.delete(key); }
  reconcile($('messages'), children);
  if (!state.restoring && !state.reveal.away && !$('editorDialog').open && !$('toolsDialog').open && !$('copyDialog').open && !$('imageDialog').open && follow && (empty || nearBottom)) area.scrollTop = area.scrollHeight;
  state.reveal.top = area.scrollTop;
  if (incoming) { flushReveal(); revealMessage(incoming.ui, incoming.before, incoming.pending); }
  state.latestAnswer.key = answerKey;
  if (changedAnswer && (!nearBottom || state.reveal.away)) state.latestAnswer.pending = true;
  if (!answerKey) state.latestAnswer.pending = false;
  renderLatestAnswer();
  if ($('toolsDialog').open) updateTools();
}
function visibleText(el) {
  if (typeof el === 'string') return el;
  if (el.tagName === 'BUTTON') return '';
  const children = Array.from(el.childNodes || []);
  const text = children.length ? children.map(visibleText).join('') : el.textContent || '';
  return text + (['P', 'H2', 'H3', 'PRE'].includes(el.tagName) ? '\n\n' : ['LI', 'TR'].includes(el.tagName) ? '\n' : ['TD', 'TH'].includes(el.tagName) ? '\t' : '');
}
function openToolLayer(id) {
  closeListMenu();
  stopReveal();
  const tools = state.tools;
  if (id !== 'editorDialog' && tools.layer?.id === 'editorDialog' && state.composing.has('expandedDraft')) {
    const auth = state.authEpoch, epoch = state.epoch, intent = navigation.intent;
    closeToolLayer('editorDialog')?.then(() => { if (state.csrf && auth === state.authEpoch && epoch === state.epoch && intent === navigation.intent) openToolLayer(id); });
    return;
  }
  if (navigation.pending) {
    const authEpoch = state.authEpoch, epoch = state.epoch, intent = navigation.intent;
    navigation.pending.promise.then(() => { if (authEpoch === state.authEpoch && epoch === state.epoch && intent === navigation.intent && state.csrf) openToolLayer(id); });
    return;
  }
  navigation.revision++;
  if (!tools.layer) {
    const layer = { id, closing: false }; layer.promise = new Promise(resolve => { layer.resolve = resolve; }); tools.layer = layer;
    history.pushState({ ...navigationEntry('layer'), base: ownEntry('chat') ? 'chat' : 'list' }, '', location.hash || '#tools');
  } else if (tools.layer.id !== id) {
    const old = tools.layer.id;
    if (old === 'editorDialog') { syncEditor(); state.editor = null; $('expandedDraft').value = ''; }
    if ($(old).open) $(old).close();
    if (old === 'imageDialog') clearImage();
    tools.layer.id = id;
  }
  if (!$(id).open) $(id).showModal();
}
function finishToolLayer() {
  const layer = state.tools.layer; if (!layer) return false;
  state.tools.layer = null;
  if (layer.id === 'editorDialog') finishEditor();
  if ($(layer.id).open) $(layer.id).close();
  if (layer.id === 'copyDialog') $('manualCopy').value = '';
  if (layer.id === 'imageDialog') clearImage(true);
  if (layer.id === 'newChatDialog' && state.csrf && !document.hidden) $('newChat').focus({ preventScroll: true });
  navigation.revision++; layer.resolve(); return true;
}
function closeToolLayer(id) {
  const layer = state.tools.layer;
  if (id === 'editorDialog' && state.editor) {
    if (state.composing.has('expandedDraft')) { state.editor.closeRequested = true; $('editorStatus').textContent = '글자 입력을 마치면 초안으로 돌아갑니다.'; return layer?.promise; }
    syncEditor();
  }
  if (!layer || layer.id !== id) { if ($(id).open) $(id).close(); return null; }
  if (!layer.closing) {
    layer.closing = true; navigation.revision++;
    if ($(id).open) $(id).close();
    backEntry('layer');
  }
  return layer.promise;
}
function closeTools() { return closeToolLayer('toolsDialog'); }
function closeCopy() { const closing = closeToolLayer('copyDialog'); $('manualCopy').value = ''; return closing; }
function clearTools() {
  closeListMenu();
  const accountClosing = closeToolLayer('accountConfirmDialog'), editorClosing = closeToolLayer('editorDialog');
  const closing = accountClosing || editorClosing || closeTools() || closeCopy() || closeNewChat(); closeCopy(); closeNewChat();
  Object.assign(state.tools, { query: '', matches: [], match: -1, resultFilter: 'all', results: [], searchSignature: null, resultsSignature: null });
  $('messageSearch').value = ''; $('messageSearchResults').replaceChildren(); $('gatheredResults').replaceChildren();
  $('messageSearchStatus').textContent = ''; $('resultsStatus').textContent = ''; $('quickFeedback').textContent = '';
  $('diagnosticFacts').replaceChildren(); $('diagnosticStatus').textContent = '';
  return closing;
}
function openTools(pane = state.selected ? 'quick' : 'diagnostics') {
  if (!state.csrf) return;
  if (state.tools.layer?.closing) {
    const epoch = state.epoch, authEpoch = state.authEpoch, intent = navigation.intent;
    state.tools.layer.promise.then(() => { if (epoch === state.epoch && authEpoch === state.authEpoch && intent === navigation.intent) openTools(pane); }); return;
  }
  const fromNav = toolPanes.some(([, , id]) => document.activeElement === $(id));
  state.tools.pane = state.selected || ['usage', 'updates', 'accounts'].includes(pane) ? pane : 'diagnostics';
  openToolLayer('toolsDialog');
  updateTools();
  if (state.tools.pane === 'diagnostics') diagnose();
  if (state.tools.pane === 'usage') refreshUsage();
  if (state.tools.pane === 'updates') refreshRelease();
  if (state.tools.pane === 'accounts') refreshAccounts();
  state.tools.navWidth = $('toolsNav').clientWidth;
  const active = $(toolPanes.find(([name]) => name === state.tools.pane)[2]);
  active.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  (state.tools.pane === 'search' ? $('messageSearch') : fromNav ? active : $('closeTools')).focus({ preventScroll: true });
}
function resizeToolsNav() {
  if (!$('toolsDialog').open || document.hidden) return;
  const nav = $('toolsNav'), width = nav.clientWidth;
  if (!(width > 0) || width === state.tools.navWidth) return;
  state.tools.navWidth = width;
  const active = $(toolPanes.find(([name]) => name === state.tools.pane)[2]);
  const left = nav.getBoundingClientRect().left, item = active.getBoundingClientRect();
  // Only pan the nav: scrollIntoView would also move vertical scroll containers.
  if (item.left < left) nav.scrollLeft += item.left - left;
  else if (item.right > left + width) nav.scrollLeft += item.right - left - width;
}
function updateTools() {
  for (const [pane, section, button] of toolPanes) {
    $(section).hidden = state.tools.pane !== pane;
    $(button).setAttribute('aria-pressed', String(state.tools.pane === pane));
    if (state.tools.pane === pane) setText($('toolsTitle'), $(button).textContent);
    $(button).disabled = !['diagnostics', 'usage', 'updates', 'accounts'].includes(pane) && !state.selected;
  }
  quickState(); answerDisplayState();
  if (state.tools.pane === 'search') searchMessages();
  if (state.tools.pane === 'results') gatherResults();
  if (state.tools.pane === 'diagnostics') renderDiagnostics();
  if (state.tools.pane === 'usage') renderUsage();
  if (state.tools.pane === 'updates') renderUpdates();
  if (state.tools.pane === 'accounts') renderAccounts();
}
function quickState() {
  const locked = !state.csrf || !state.selected || $('draft').disabled || state.sending || state.serverSending || state.acknowledging || Boolean(state.pending) || state.capability.uncertain;
  for (const id of ['quickContinue', 'quickStatus', 'quickError']) $(id).disabled = locked;
  for (const row of $('snippetList').children) if (row.apply) row.apply.disabled = locked;
}
for (const [id, text] of [['quickContinue', '계속 진행해줘'], ['quickStatus', '현재 작업 상황을 알려줘'], ['quickError', '오류 원인부터 확인하고 해결해줘']]) $(id).onclick = () => {
  quickState(); if ($(id).disabled) return;
  applyQuickInstruction(text);
};
function loadedEntries() {
  const roots = new Map([...state.historyNodes].map(entry => [entry[1].root, entry]));
  return Array.from($('messages').children).map(root => roots.get(root)).filter(Boolean);
}
function messageEntries() { return loadedEntries().filter(([, ui]) => ['userMessage', 'agentMessage', 'plan', 'requestNotice'].includes(ui.kind) && ui.visibleText); }
function searchMessages() {
  const tools = state.tools, query = tools.query.toLocaleLowerCase(), oldKey = tools.matches[tools.match]?.key;
  const matches = [];
  if (query) for (const [key, ui] of messageEntries()) {
    const position = ui.visibleText.toLocaleLowerCase().indexOf(query);
    if (position >= 0) matches.push({ key, label: `${ui.kind === 'userMessage' ? '나' : ui.kind === 'requestNotice' ? '원문 생략 안내' : 'Codex'} · ${ui.visibleText.slice(Math.max(0, position - 30), position + query.length + 90)}` });
    if (matches.length === 200) break;
  }
  tools.matches = matches; tools.match = matches.length ? Math.max(0, matches.findIndex(m => m.key === oldKey)) : -1;
  setText($('messageSearchStatus'), !query ? '검색어를 입력해 주세요.' : !matches.length ? '불러온 메시지에 일치하는 내용이 없습니다.' : `${tools.match + 1} / ${matches.length}${matches.length === 200 ? ' · 최대 표시 수 도달' : ''}개 메시지 · 선택하면 대화로 이동합니다.`);
  $('searchNext').disabled = $('searchPrevious').disabled = !matches.length;
  const signature = JSON.stringify(matches);
  if (tools.searchSignature !== signature) {
    tools.searchSignature = signature;
    const existing = new Map(Array.from($('messageSearchResults').children).map(button => [button.toolKey, button]));
    const epoch = state.epoch;
    reconcile($('messageSearchResults'), matches.map(m => {
      const button = existing.get(m.key) || node('button'); button.type = 'button'; button.toolKey = m.key; setText(button, m.label);
      button.onclick = () => { if (epoch !== state.epoch || !state.csrf) return; tools.match = tools.matches.findIndex(value => value.key === m.key); jumpToMessage(m.key); }; return button;
    }));
  }
}
function jumpToMessage(key) {
  const ui = state.historyNodes.get(key); if (!ui) return;
  closeTools();
  for (const value of state.historyNodes.values()) delete value.root.dataset.toolTarget;
  ui.root.dataset.toolTarget = 'true'; ui.root.setAttribute('tabindex', '-1');
  const area = $('history'); area.scrollTop += ui.root.getBoundingClientRect().top - area.getBoundingClientRect().top;
  ui.root.focus({ preventScroll: true }); persistDevice();
}
$('messageSearch').oninput = () => { state.tools.query = $('messageSearch').value.slice(0, 200); state.tools.match = -1; searchMessages(); };
$('searchClear').onclick = () => { state.tools.query = ''; $('messageSearch').value = ''; searchMessages(); $('messageSearch').focus(); };
for (const [id, direction] of [['searchPrevious', -1], ['searchNext', 1]]) $(id).onclick = () => {
  const tools = state.tools; if (!tools.matches.length) return;
  tools.match = (tools.match + direction + tools.matches.length) % tools.matches.length;
  jumpToMessage(tools.matches[tools.match].key);
};
function gatherResults() {
  const tools = state.tools, results = [], seen = new Set();
  for (const [key, ui] of loadedEntries()) for (const asset of ui.assets || []) {
    const identity = `${asset.kind}/${asset.identity}`; if (seen.has(identity) || results.length >= 128) continue;
    seen.add(identity); results.push({ ...asset, key });
  }
  tools.results = results;
  for (const [id, filter] of [['resultsAll', 'all'], ['resultsImages', 'image'], ['resultsVideos', 'video'], ['resultsFiles', 'file']]) $(id).setAttribute('aria-pressed', String(tools.resultFilter === filter));
  const shown = results.filter(r => tools.resultFilter === 'all' || r.kind === tools.resultFilter);
  setText($('resultsStatus'), shown.length ? `${shown.length}개${results.length === 128 ? ' · 최대 표시 수 도달' : ''} · 불러온 결과만 표시` : '불러온 기록에 해당 결과가 없습니다. 이전 기록을 불러온 뒤 다시 확인해 주세요.');
  const signature = JSON.stringify([tools.resultFilter, shown]);
  if (tools.resultsSignature === signature) return;
  tools.resultsSignature = signature;
  const existing = new Map(Array.from($('gatheredResults').children).map(button => [button.toolKey, button]));
  const epoch = state.epoch;
  reconcile($('gatheredResults'), shown.map(result => {
    const identity = `${result.kind}/${result.identity}`, button = existing.get(identity) || node('button'); button.toolKey = identity;
    setText(button, `${result.kind === 'video' ? '동영상' : result.kind === 'file' ? '파일' : '사진'} · ${result.label}${result.ready ? '' : ' · 원본 확인 필요'} · 대화에서 보기`);
    button.type = 'button'; button.onclick = () => { if (epoch === state.epoch && state.csrf) jumpToMessage(result.key); }; return button;
  }));
}
for (const [id, filter] of [['resultsAll', 'all'], ['resultsImages', 'image'], ['resultsVideos', 'video'], ['resultsFiles', 'file']]) $(id).onclick = () => { state.tools.resultFilter = filter; gatherResults(); };
function clearUsage() {
  clearTimeout(state.usage.timer); stopUsageClock();
  state.usage = { result: null, flight: null, timer: null, nextAt: 0, failed: false, suspended: false };
  $('usageSummary').textContent = '잔여량 · 확인 전';
  $('usageSummary').removeAttribute('aria-label'); $('usageSummary').title = ''; $('usageSummary').dataset.warning = 'false';
  $('usageTokens').textContent = ''; $('usageTokenChecked').textContent = '';
  $('usageBuckets').replaceChildren(); $('usageResets').textContent = ''; $('usageStatus').textContent = ''; $('usageChecked').textContent = '';
  $('usageStatus').hidden = true; $('usageStatus').dataset.warning = 'false'; $('refreshUsage').title = '';
}
function usageVisible() { return state.csrf && !accountLocked() && !document.hidden && navigator.onLine !== false && !state.usage.suspended; }
function usageDuration(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return '기간 확인 불가';
  if (mins === 10080) return '주간 · 7일';
  if (mins % 1440 === 0) return `${mins / 1440}일`;
  if (mins % 60 === 0) return `${mins / 60}시간`;
  return mins > 60 ? `${Math.floor(mins / 60)}시간 ${mins % 60}분` : `${mins}분`;
}
function usageTime(at) {
  return Number.isFinite(at) ? new Date(at).toLocaleString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : '확인 불가';
}
function usagePercent(value) { return Number.isFinite(value) ? `${Number(value.toFixed(1))}%` : '확인 불가'; }
function usageBalance(credit) {
  const value = credit?.balance;
  return typeof value === 'string' && value.length <= 31 && /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?(?![\s\S])/.test(value) ? value : null;
}
function usageZeroCredit(credit) {
  const balance = usageBalance(credit);
  return balance !== null && !/[1-9]/.test(balance);
}
function usageCreditVisible(credit) { return credit?.unlimited === true || !usageZeroCredit(credit); }
function usageFx() {
  const fx = state.usage.result?.fx, now = Date.now(), day = Math.floor(now / 86400000) * 86400000;
  if (!fx || fx.source !== 'frankfurter' || fx.base !== 'USD' || fx.quote !== 'KRW' || !['ready', 'stale'].includes(fx.state) ||
      typeof fx.rate !== 'string' || !/^(?:[1-9][0-9]{0,4}|100000)(?:\.[0-9]{1,8})?$/.test(fx.rate) || Number(fx.rate) > 100000 ||
      typeof fx.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fx.date) || !Number.isFinite(fx.checkedAt) || fx.checkedAt > now + 300000 || now >= fx.checkedAt + 7 * 86400000) return null;
  const at = Date.parse(fx.date + 'T00:00:00Z');
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== fx.date || at > day || at < day - 7 * 86400000) return null;
  return { rate: fx.rate, date: fx.date, stale: fx.stale === true || fx.state === 'stale' || navigator.onLine === false || now >= fx.checkedAt + 86400000 || at < day - 3 * 86400000 };
}
function usageWon(balance, rate, compact = false) {
  // Public reference: 2,500 credits = 100 USD, not a USD-denominated balance or a contract price.
  const decimal = value => { const [whole, fraction = ''] = value.split('.'); return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)]; };
  const [credits, creditScale] = decimal(balance), [fx, fxScale] = decimal(rate);
  const value = credits * 4n * fx, scale = creditScale * 100n * fxScale;
  if (value > 0n && value < scale) return '≈1원 미만';
  const [unit, label] = compact && value >= scale * 1000000000000n ? [1000000000000n, '조'] : compact && value >= scale * 100000000n ? [100000000n, '억'] : compact && value >= scale * 1000000n ? [10000n, '만'] : [1n, ''];
  const digits = unit === 1n ? 1n : 100n, denominator = scale * unit, rounded = (value * digits + denominator / 2n) / denominator;
  const fraction = digits === 1n ? '' : String(rounded % digits).padStart(2, '0').replace(/0+$/, '');
  return `≈${(rounded / digits).toLocaleString('ko-KR')}${fraction ? '.' + fraction : ''}${label}원`;
}
function usageCredit(credit, compact = false, codex = true) {
  if (credit?.unlimited === true) return '무제한';
  const balance = usageBalance(credit);
  if (balance === null) return '확인 불가';
  if (!codex) return `${balance} (단위 미확인)`;
  const fx = usageFx();
  return fx ? `${usageWon(balance, fx.rate, compact)}${fx.stale ? ` · 환율 오래됨${compact ? '' : ` (${fx.date})`}` : ''}` : '원화 환산 확인 불가';
}
function usageCountdown(at, now = Date.now()) {
  if (!Number.isSafeInteger(at) || at <= 0) return '초기화 미상';
  if (at * 1000 <= now) return '지남·재확인';
  const minutes = Math.ceil((at * 1000 - now) / 60000), days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return [days ? `${days}일` : '', hours ? `${hours}시간` : '', mins ? `${mins}분` : ''].filter(Boolean).join(' ') + ' 후';
}
function usageTokens(detail = false) {
  const t = state.usage.result?.tokenActivity;
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  const old = Boolean(t?.stale || t?.checkedAt != null && Date.now() >= t.checkedAt + 60000 || state.usage.failed || navigator.onLine === false);
  const status = t?.state === 'unsupported' ? '미지원' : t?.state === 'unavailable' || state.usage.failed ? '조회 실패' : '';
  const recent = t?.daily?.[0];
  const value = valid(t?.lifetimeTokens) ? `누적 ${t.lifetimeTokens.toLocaleString('ko-KR')}` : recent && valid(recent.tokens) ? `${recent.startDate} · ${recent.tokens.toLocaleString('ko-KR')}` : '확인 불가';
  const dated = detail && valid(t?.lifetimeTokens) && recent && valid(recent.tokens) ? `${recent.startDate} · ${recent.tokens.toLocaleString('ko-KR')}` : '';
  return ['토큰 활동', value, dated, status, old ? '오래됨' : ''].filter(Boolean).join(' · ');
}
function stopUsageClock() { clearTimeout(state.usage.clock); state.usage.clock = null; }
function scheduleUsageClock() {
  stopUsageClock();
  if (!usageVisible() || !state.usage.result) return;
  const u = state.usage, now = Date.now();
  const resets = (u.result.buckets || []).flatMap(b => [b.primary?.resetsAt, b.secondary?.resetsAt]).filter(at => Number.isSafeInteger(at) && at * 1000 > now).map(at => at * 1000 - now);
  const delay = Math.min(60000 - now % 60000, ...resets);
  u.clock = setTimeout(() => { u.clock = null; if (u === state.usage && usageVisible()) renderUsage(true); }, delay);
}
function renderUsage(tick = false) {
  const u = state.usage, r = u.result, now = Date.now(), buckets = r?.buckets ?? [];
  const offline = navigator.onLine === false;
  const expired = buckets.some(b => [b.primary, b.secondary].some(w => w?.resetsAt != null && w.resetsAt * 1000 <= now));
  const stale = Boolean(r && (r.stale || u.failed || offline || expired || r.checkedAt != null && now >= r.checkedAt + 60000));
  const summaryBucket = buckets.find(b => b.id === 'codex') || buckets.find(b => b.credits?.unlimited === true || usageBalance(b.credits) !== null || [b.primary, b.secondary].some(w => Number.isFinite(w?.remainingPercent) && Number.isFinite(w?.windowDurationMins)));
  const windows = [summaryBucket?.primary, summaryBucket?.secondary].filter(Boolean);
  const summary = windows.map(w => `${w.windowDurationMins === 10080 ? '주간' : usageDuration(w.windowDurationMins)} ${usagePercent(w.remainingPercent)} (${usageCountdown(w.resetsAt, now)})`).join(' · ');
  const warning = Boolean(offline || u.failed || r?.state === 'unavailable' || r?.state === 'unsupported' || stale);
  const warnings = [offline ? '오프라인' : u.failed || r?.state === 'unavailable' ? '조회 실패' : r?.state === 'unsupported' ? '미지원' : '', stale ? '오래됨' : ''].filter(Boolean);
  const summaryText = [...warnings, summary || (u.flight ? '확인 중…' : '한도 확인 불가')].filter(Boolean).join(' · ') + '\n' + usageTokens();
  const accessible = ['PC Codex 계정 잔여량', ...warnings, ...(windows.length ? windows.map(w => `${usageDuration(w.windowDurationMins)} ${usagePercent(w.remainingPercent)} 남음 · 초기화 ${usageCountdown(w.resetsAt, now)}`) : [u.flight ? '한도 확인 중…' : '한도 확인 불가']), usageCreditVisible(summaryBucket?.credits) ? `크레딧 잔액 ${usageCredit(summaryBucket?.credits, false, summaryBucket?.id === 'codex')}` : '', buckets.length > 1 ? `+${buckets.length - 1}개 한도` : '', '상세 보기'].filter(Boolean).join(' · ');
  setText($('usageSummary'), summaryText);
  const full = accessible + ' · ' + usageTokens();
  $('usageSummary').setAttribute('aria-label', full); $('usageSummary').title = full;
  const fx = usageFx(), fxWarning = summaryBucket?.id === 'codex' && summaryBucket.credits?.unlimited !== true && usageBalance(summaryBucket.credits) !== null && !usageZeroCredit(summaryBucket.credits) && (!fx || fx.stale);
  $('usageSummary').dataset.warning = String(warning || fxWarning || r?.tokenActivity?.stale || ['unsupported', 'unavailable'].includes(r?.tokenActivity?.state));
  scheduleUsageClock();
  setText($('usageTokens'), usageTokens(true));
  if (tick) return; // Local clock never rebuilds detail rows or updates live status regions.
  setText($('usageTokenChecked'), `계정 활동 마지막 성공 확인: ${usageTime(r?.tokenActivity?.checkedAt)}`);
  const status = offline ? '오프라인 · 이전 정보는 오래된 관찰값입니다. 온라인에서 다시 확인해 주세요.' : u.failed || r?.state === 'unavailable' ? '조회 실패 · 이전 정보가 있다면 오래된 관찰값입니다. 잠시 뒤 다시 확인해 주세요.' : r?.state === 'unsupported' ? '이 PC Codex에서는 사용 한도 조회를 제공하지 않습니다. PC에서 확인해 주세요.' : expired ? '초기화 예정 시각이 지난 관찰값입니다. 잔여량을 추정하지 않으며 다시 조회해야 합니다.' : stale ? '오래된 관찰값 · 다시 확인이 필요합니다.' : u.flight ? '사용 한도를 확인하고 있습니다…' : r?.state === 'ready' ? '' : '남은 한도를 확인할 수 없습니다. 0% 또는 100%라는 뜻이 아닙니다.';
  setText($('usageStatus'), status + (warning && u.flight ? ' 확인하고 있습니다…' : ''));
  $('usageStatus').hidden = !status; $('usageStatus').dataset.warning = String(warning);
  setText($('usageChecked'), `마지막 성공 확인: ${usageTime(r?.checkedAt)}`);
  $('refreshUsage').title = `최소 60초 간격 · 캐시 사용${u.nextAt > now ? ` · 다음 조회 가능: ${usageTime(u.nextAt)}` : ''}`;
  $('refreshUsage').disabled = Boolean(u.flight) || !usageVisible();
  const resetAvailableCount = r?.resetAvailableCount;
  setText($('usageResets'), `초기화권 ${Number.isSafeInteger(resetAvailableCount) && resetAvailableCount >= 0 && resetAvailableCount <= 1000000 ? `${resetAvailableCount.toLocaleString('ko-KR')}회` : '확인 불가'} · 크레딧 잔액과 별도`);
  const shown = buckets.slice(0, 8).filter(b => b.primary || b.secondary || usageCreditVisible(b.credits));
  const signature = JSON.stringify([shown.map(b => [b.id, b.label, b.primary, b.secondary]), stale, expired]);
  if (u.signature !== signature) {
    u.signature = signature;
    $('usageBuckets').replaceChildren(...shown.map(b => {
      const section = node('section', undefined, 'usage-bucket'); section.append(node('h3', b.label));
      for (const [label, w] of [['기본 구간', b.primary], ['추가 구간', b.secondary]]) {
        const row = node('div', undefined, 'usage-window');
        if (!w) { row.append(node('p', `${label} · 제공 정보 없음`, 'tool-note')); section.append(row); continue; }
        const duration = usageDuration(w.windowDurationMins), percent = usagePercent(w.remainingPercent);
        row.append(node('p', `${label} · ${duration} · ${percent}${Number.isFinite(w.remainingPercent) ? ' 남음' : ''}`));
        if (Number.isFinite(w.remainingPercent)) {
          const meter = node('meter'); meter.min = 0; meter.max = 100; meter.value = w.remainingPercent;
          meter.setAttribute('aria-label', `${b.label} ${label} ${duration} 남은 한도 ${percent}${stale ? ' · 오래된 관찰값' : ''}`); row.append(meter);
        }
        row.append(node('p', `초기화 예정: ${usageTime(w.resetsAt == null ? null : w.resetsAt * 1000)}${w.resetsAt != null && w.resetsAt * 1000 <= now ? ' · 지난 시각, 재확인 필요' : ''}`, 'tool-note'));
        section.append(row);
      }
      return section;
    }));
  }
  shown.forEach((b, index) => {
    const fx = b.id === 'codex' ? usageFx() : null;
    const section = $('usageBuckets').children[index], signature = JSON.stringify([b.credits ?? null, fx]);
    if (section.creditSignature === signature) return;
    section.creditSignature = signature; section.credit?.remove(); section.credit = null;
    if (!usageCreditVisible(b.credits)) return;
    const credit = node('div', undefined, 'usage-window usage-credit');
    credit.append(node('p', `크레딧 잔액 · ${usageCredit(b.credits, false, b.id === 'codex')}`));
    const balance = usageBalance(b.credits);
    if (balance !== null && !usageZeroCredit(b.credits)) {
      const details = node('details', undefined, 'usage-criteria');
      details.append(node('summary', '원래 잔액·환산 근거'));
      details.append(node('p', `원래 잔액: ${balance}${b.id === 'codex' ? ' 크레딧' : ' · 단위 미확인'}`, 'tool-note'));
      if (b.id === 'codex' && b.credits?.unlimited !== true) {
        details.append(node('p', '공개 참고가: 1크레딧 = 0.04 USD · 실제 결제·환불 금액이 아닙니다.', 'tool-note'));
        details.append(node('p', fx ? `환율: 1 USD = ${fx.rate} KRW · 기준일 ${fx.date}${fx.stale ? ' · 오래된 환율' : ''} · Frankfurter` : '환율 확인 불가 · 이전 환율을 임의로 적용하지 않습니다.', 'tool-note'));
        if (!fx || fx.stale) credit.append(node('p', fx ? '오래된 환율 · 환산액은 이전 참고값입니다. 다시 확인해 주세요.' : '환율 확인 불가 · 원화 잔액을 추정하지 않습니다. 다시 확인해 주세요.', 'tool-note'));
      }
      credit.append(details);
    }
    if (b.credits && (b.credits.hasCredits === null || b.credits.unlimited === null)) credit.append(node('p', '일부 크레딧 정보 확인 불가 · 잔액을 추정하지 않습니다.', 'tool-note'));
    section.credit = credit; section.append(credit);
  });
}
function scheduleUsage() {
  const u = state.usage; clearTimeout(u.timer); u.timer = null;
  if (usageVisible()) u.timer = setTimeout(() => { u.timer = null; refreshUsage(); }, Math.max(60000, u.nextAt - Date.now()));
}
function refreshUsage() {
  const u = state.usage, authEpoch = state.authEpoch;
  if (!usageVisible()) { renderUsage(); return Promise.resolve(); }
  if (u.flight) return u.flight;
  if (Date.now() < u.nextAt) { renderUsage(); scheduleUsage(); return Promise.resolve(); }
  u.nextAt = Date.now() + 60000;
  u.flight = api('/api/usage').then(result => {
    if (authEpoch === state.authEpoch && state.csrf && u === state.usage) {
      u.result = result; u.failed = false;
      if (Number.isFinite(result.refreshAfter)) u.nextAt = Math.max(u.nextAt, Math.min(Date.now() + 120000, result.refreshAfter));
    }
  }).catch(() => { if (authEpoch === state.authEpoch && state.csrf && u === state.usage) u.failed = true; }).finally(() => {
    if (u === state.usage && authEpoch === state.authEpoch) { u.flight = null; renderUsage(); scheduleUsage(); }
  });
  renderUsage(); return u.flight;
}
$('usageSummary').onclick = () => openTools('usage');
$('refreshUsage').onclick = refreshUsage;
function renderDiagnostics() {
  const tools = state.tools, result = tools.diagnostic;
  const time = at => Number.isFinite(at) ? new Date(at).toLocaleTimeString('ko-KR') : '아직 확인하지 못함';
  setText($('diagnosticStatus'), tools.diagnosticFlight ? '연결을 확인하고 있습니다…' : tools.bridgeFailed ? '브리지에 연결하지 못했습니다. 원인은 확인되지 않았습니다.' : tools.diagnosticFailed ? '브리지는 응답했지만 진단을 완료하지 못했습니다. 잠시 뒤 다시 확인해 주세요.' : result ? '마지막 진단 결과입니다. 상태는 확인 이후 달라질 수 있습니다.' : '연결 다시 확인을 눌러 진단해 주세요.');
  const status = value => value === 'available' ? '조회 성공' : value === 'unsupported' ? '연결 미제공 · PC 확인 필요' : '조회 확인 불가 · PC 확인 필요';
  const facts = [['브리지 마지막 응답', time(tools.bridgeAt)], ['기기 인증', tools.bridgeFailed ? '현재 확인 불가' : result ? '진단 요청 인증됨' : '아직 진단하지 않음'],
    ['PC Codex', result ? status(result.desktop) : '아직 진단하지 않음'], ['PC 목록·기록 마지막 조회 성공', time(result?.desktopSuccessAt)],
    ['저장 기록 조회 연결', result ? status(result.readonly) : '아직 진단하지 않음'], ['저장 기록 연결 마지막 성공', time(result?.readonlySuccessAt)]];
  $('diagnosticFacts').replaceChildren(...facts.flatMap(([label, value]) => [node('dt', label), node('dd', value)]));
  $('retryDiagnostics').disabled = Boolean(tools.diagnosticFlight);
}
function diagnose() {
  const tools = state.tools, authEpoch = state.authEpoch;
  if (!state.csrf) return Promise.resolve();
  if (tools.diagnosticFlight?.authEpoch === authEpoch) return tools.diagnosticFlight.promise;
  const flight = { authEpoch }; tools.diagnosticFailed = false;
  flight.promise = api('/api/diagnostics').then(result => { if (authEpoch === state.authEpoch && state.csrf) tools.diagnostic = result; }).catch(() => {
    if (authEpoch === state.authEpoch && state.csrf) tools.diagnosticFailed = true;
  }).finally(() => {
    if (tools.diagnosticFlight === flight) { tools.diagnosticFlight = null; renderDiagnostics(); }
  });
  tools.diagnosticFlight = flight; renderDiagnostics(); return flight.promise;
}
$('chatTools').onclick = () => openTools(); $('listDiagnostics').onclick = () => openTools('diagnostics'); $('closeTools').onclick = closeTools;
for (const [id, pane] of [['toolQuick', 'quick'], ['toolSearch', 'search'], ['toolResults', 'results'], ['toolDiagnostics', 'diagnostics'], ['toolUsage', 'usage'], ['toolUpdates', 'updates']]) $(id).onclick = () => openTools(pane);
$('retryDiagnostics').onclick = diagnose;
$('toolsDialog').addEventListener('cancel', e => { e.preventDefault(); closeTools(); });
$('copyDialog').addEventListener('cancel', e => { e.preventDefault(); closeCopy(); });
$('closeCopy').onclick = closeCopy; $('copyDialog').addEventListener('close', () => { if (!$('copyDialog').open) $('manualCopy').value = ''; });
$('selectCopy').onclick = () => { $('manualCopy').focus(); $('manualCopy').select(); };
function optionRows(operation) { return state.models.result?.[operation]?.models || []; }
function modelSelection(operation) {
  const model = $(operation + 'Model').value, thinking = $(operation + 'Thinking').value;
  return model ? { model, ...(thinking ? { thinking } : {}) } : {};
}
function validSelection(operation, choice) {
  if (!choice?.model) return !choice?.thinking;
  const row = optionRows(operation).find(r => r.id === choice.model);
  return Boolean(row && (!choice.thinking || row.efforts.includes(choice.thinking)));
}
function fillSelect(el, rows, value, label) {
  const options = [Object.assign(node('option', label), { value: '' }), ...rows.map(r => Object.assign(node('option', r.label || r.id), { value: r.id }))];
  if (value && !rows.some(r => r.id === value)) options.push(Object.assign(node('option', `${value} · 확인 필요`), { value }));
  el.replaceChildren(...options); el.value = value || '';
}
function renderModelSelect(operation, initial) {
  const choice = initial || (operation === 'send' ? state.models.preferences.get(state.selected) || {} : modelSelection(operation)), cap = state.models.result?.[operation];
  const signature = JSON.stringify([choice, cap, Boolean(state.models.flight)]), model = $(operation + 'Model'), thinking = $(operation + 'Thinking');
  // Polls and draft input must not rebuild a focused native selector.
  if (model.choiceSignature !== signature || model.value !== (choice.model || '') || thinking.value !== (choice.thinking || '')) {
    fillSelect(model, optionRows(operation), choice.model, 'PC 설정 유지');
    const values = optionRows(operation).find(r => r.id === choice.model)?.efforts || [];
    fillSelect(thinking, values.map(id => ({ id })), choice.thinking, 'PC 설정 유지');
    thinking.disabled = !choice.model || !values.length; model.choiceSignature = signature;
  }
  const status = $(operation + 'OptionsStatus');
  status.textContent = state.models.flight ? 'PC 선택지를 확인하고 있습니다…' : !validSelection(operation, choice) ? errors.MODEL_CHOICE_UNAVAILABLE : !cap?.available ? operation === 'send' ? '선택지 확인 불가 · 기존 대화는 PC 설정 유지로 계속할 수 있습니다.' : 'PC의 새 대화 기능을 확인할 수 없습니다. 선택지를 다시 확인해 주세요.' : cap.state !== 'ready' ? '모델·추론 목록 미제공 · PC 설정 유지로 사용할 수 있습니다.' : '';
  if (operation === 'send' && !state.models.flight && sendOptionsError()) status.textContent = errorText({ code: state.errorCode });
  status.hidden = !status.textContent;
  if (operation === 'send') {
    for (const [el, label, value] of [[model, '모델', choice.model], [thinking, '추론', choice.thinking]]) {
      const full = value ? (el.children && [...el.children].find(o => o.value === value)?.textContent) || value : 'PC 설정 유지';
      el.title = `다음 메시지 ${label}: ${full}. 현재 PC 설정은 조회되지 않습니다. 직접 보내기를 누를 때만 전달합니다.`;
      el.setAttribute('aria-label', el.title); el.setAttribute('aria-invalid', String(!validSelection(operation, choice)));
    }
    $('sendOptionsFeedback').hidden = !state.csrf || !state.selected || !status.textContent;
    $('refreshOptions').hidden = Boolean(state.models.flight);
    sendChoicesState();
  }
}
async function loadOptions(force = false) {
  const m = state.models, authEpoch = state.authEpoch;
  if (!state.csrf) return;
  if (m.flight) return m.flight;
  if (!force && m.result && Date.now() < m.result.refreshAfter) return;
  m.flight = (async () => {
    try { const result = await api('/api/options'); if (m !== state.models || authEpoch !== state.authEpoch) return; m.result = result; }
    catch (e) { if (m !== state.models || authEpoch !== state.authEpoch) return; m.result = null; }
    finally {
      if (m === state.models && authEpoch === state.authEpoch) {
        m.flight = null; renderModelSelect('send'); renderModelSelect('create'); renderProjects(); creationState();
      }
    }
  })();
  renderModelSelect('send'); renderModelSelect('create'); renderProjects(); return m.flight;
}
function renderProjects() {
  const value = $('newProject').value;
  const projects = state.models.result?.projects;
  fillSelect($('newProject'), projects?.items || [], value, '프로젝트 없이');
  const status = $('projectOptionsStatus');
  status.textContent = state.models.flight ? '로컬 프로젝트 확인 중…' : value && !projects?.items.some(p => p.id === value) ? '선택한 로컬 프로젝트를 확인할 수 없습니다. 자동으로 다른 대상으로 바꾸지 않습니다.' : projects?.state === 'ready' ? '' : '로컬 프로젝트 목록 확인 불가 · 프로젝트 없이는 사용할 수 있습니다.';
  status.hidden = !status.textContent;
}
function changeModelChoice(operation, changedModel = false) {
  if (operation === 'send' && (sendChoicesLocked() || state.models.flight)) { renderModelSelect('send'); return; }
  if (changedModel) {
    const selection = modelSelection(operation), supported = optionRows(operation).find(r => r.id === selection.model)?.efforts || [];
    if (!supported.includes(selection.thinking)) $(operation + 'Thinking').value = '';
  }
  const choice = modelSelection(operation);
  if (operation === 'send') {
    if (validSelection(operation, choice)) {
      const m = state.models;
      m.preferences.delete(state.selected);
      if (choice.model) m.preferences.set(state.selected, choice);
      while (m.preferences.size > 32) m.preferences.delete(m.preferences.keys().next().value);
      persistDevice(true); if (sendOptionsError()) clearError();
    }
    composerState();
  } else { renderModelSelect(operation); creationState(); }
}
for (const operation of ['send', 'create']) {
  $(operation + 'Model').onchange = () => changeModelChoice(operation, true);
  $(operation + 'Thinking').onchange = () => changeModelChoice(operation);
}
function sendOptionsError() { return ['MODEL_CHOICE_UNAVAILABLE', 'INVALID_MODEL_CHOICE', 'OPTIONS_UNAVAILABLE'].includes(state.errorCode); }
async function retrySendOptions() {
  if (sendChoicesLocked() || state.models.flight) return;
  const epoch = state.epoch, authEpoch = state.authEpoch;
  await loadOptions(true);
  if (epoch !== state.epoch || authEpoch !== state.authEpoch) return;
  if (sendOptionsError() && state.models.result?.send?.available && validSelection('send', state.models.preferences.get(state.selected))) clearError();
  composerState();
}
$('refreshOptions').onclick = retrySendOptions;
$('refreshNewOptions').onclick = () => loadOptions(true);
function clearModelUI(discard = true) {
  closeNewChat();
  state.models = { result: null, flight: null, preferences: discard ? new Map() : state.models.preferences };
  state.creation = { receipt: discard ? null : state.creation.receipt, busy: false, checking: false, checked: false, missing: false, message: '' };
  $('newPrompt').value = ''; $('newProject').value = '';
  for (const operation of ['send', 'create']) renderModelSelect(operation, {});
  $('creationStatus').textContent = ''; renderProjects(); creationState();
}
function closeNewChat() { return closeToolLayer('newChatDialog'); }
async function openNewChat() {
  if (!state.csrf) return;
  const authEpoch = state.authEpoch, intent = ++navigation.intent;
  const pending = navigation.pending?.promise || (state.tools.layer?.closing ? state.tools.layer.promise : null);
  if (pending) await pending;
  if (!state.csrf || authEpoch !== state.authEpoch || intent !== navigation.intent || document.hidden) return;
  openToolLayer('newChatDialog'); renderModelSelect('create'); renderProjects(); creationState();
  loadOptions(); checkCreation().catch(() => {}); $('closeNewChat').focus({ preventScroll: true });
}
function creationState() {
  const c = state.creation, receipt = c.receipt, locked = receipt && ['reserved', 'pending', 'uncertain'].includes(receipt.state);
  const busy = c.busy || c.checking;
  renderAttachments('new'); $('attachNewFiles').disabled = accountLocked() || !state.csrf || Boolean(busy || locked);
  for (const id of ['newPrompt', 'newProject', 'createModel']) $(id).disabled = Boolean(busy || locked);
  $('createThinking').disabled = Boolean(busy || locked || !$('createModel').value || !optionRows('create').find(r => r.id === $('createModel').value)?.efforts.length);
  const project = $('newProject').value, validProject = !project || state.models.result?.projects?.state === 'ready' && state.models.result.projects.items.some(r => r.id === project);
  $('createChat').disabled = !state.csrf || accountLocked() || state.recovery.gated || state.recovery.suspended || navigator.onLine === false || !attachments.ready('new') || !c.checked || Boolean(busy || locked) || !state.models.result?.create?.available || !validProject || !validSelection('create', modelSelection('create')) || !$('newPrompt').value.trim();
  $('createChat').textContent = c.busy ? '생성 결과 확인 중…' : '새 대화 만들고 보내기';
  $('checkCreation').hidden = !locked && !(!c.checked && c.message); $('checkCreation').disabled = busy || !state.csrf;
  $('openCreated').hidden = receipt?.state !== 'delivered' || !receipt.threadId; $('openCreated').disabled = busy;
  $('creationRecovery').hidden = !['pending', 'uncertain'].includes(receipt?.state) || c.busy; $('acknowledgeCreation').disabled = busy;
  const labels = { reserved: '생성 결과 확인 중 · 다시 만들지 마세요.', pending: '대화 준비 응답을 받았습니다. 실제 대화 ID는 아직 없어 열 수 없습니다. PC 목록을 확인해 주세요.', uncertain: errors.CREATE_UNCERTAIN, delivered: '새 대화에 첫 요청을 전달했습니다. 작업 완료를 뜻하지 않습니다.', rejected: '생성 전에 거절되었습니다. 요청과 선택지를 확인해 주세요.', acknowledged: '생성 보호만 해제했습니다. 취소하거나 다시 만들지 않았습니다.' };
  const status = $('creationStatus');
  status.textContent = c.busy ? labels.reserved : c.checking ? '이전 생성 상태를 확인하고 있습니다…' : c.message || (receipt?.verification === 'candidate' && receipt.state !== 'delivered' ? '실제 ID 응답을 받았습니다. PC에서 같은 로컬 대화를 읽기 검증 중입니다. 재생성하지 않습니다.' : labels[receipt?.state]) || (navigator.onLine === false ? '오프라인 · 자동으로 보내지 않습니다.' : '');
  status.hidden = !status.textContent;
}
function completeCreation(c, automatic) {
  const r = c.receipt, pending = c.auto;
  if (r?.state !== 'delivered' || !r.threadId || !pending || pending.requestId !== r.requestId || c.completed === r.requestId) return;
  c.completed = r.requestId; attachments.consume('new', pending.files);
  const intended = $('newChatDialog').open && pending.intent === navigation.intent && $('newPrompt').value === pending.text && !document.hidden && navigator.onLine !== false && !state.recovery.suspended;
  if ($('newPrompt').value === pending.text) { $('newPrompt').value = ''; renderModelSelect('create', {}); }
  if (automatic && intended) openThread(r.threadId);
}
async function checkCreation(automatic = false) {
  const c = state.creation, authEpoch = state.authEpoch;
  if (!state.csrf || c.busy || c.checking) return;
  c.checking = true; creationState();
  try {
    const result = await api('/api/create/state');
    if (c !== state.creation || authEpoch !== state.authEpoch) return;
    if (result.request) {
      c.receipt = result.request; c.missing = false;
      if (c.receipt.verification === 'candidate' && !accountLocked()) {
        const receipt = await api(`/api/requests/${c.receipt.requestId}`);
        if (receipt.kind !== 'create' || receipt.requestId !== c.receipt.requestId || !['reserved', 'pending', 'uncertain', 'delivered', 'acknowledged', 'rejected'].includes(receipt.state)) throw { code: 'CREATE_RESULT_UNCONFIRMED' };
        c.receipt = receipt;
      }
    }
    else if (c.receipt && ['reserved', 'pending', 'uncertain'].includes(c.receipt.state)) {
      try { c.receipt = await api(`/api/requests/${c.receipt.requestId}`); c.missing = false; }
      catch (e) { if (e.code !== 'REQUEST_NOT_FOUND') throw e; c.missing = true; c.receipt.state = 'uncertain'; }
    }
    if (c !== state.creation || authEpoch !== state.authEpoch) return;
    c.checked = true; c.message = ''; completeCreation(c, automatic === true); persistDevice(true);
  } catch (e) { if (c === state.creation && authEpoch === state.authEpoch) c.message = errorText(e); }
  finally {
    if (c === state.creation && authEpoch === state.authEpoch) {
      c.checking = false; creationState();
      if ($('newChatDialog').open && document.activeElement === $('checkCreation') && $('checkCreation').hidden) {
        (!$('openCreated').hidden ? $('openCreated') : !$('newPrompt').disabled ? $('newPrompt') : $('closeNewChat')).focus({ preventScroll: true });
      }
    }
  }
}
$('newChat').onclick = openNewChat;
$('closeNewChat').onclick = closeNewChat;
$('newChatDialog').addEventListener('cancel', e => { e.preventDefault(); closeNewChat(); });
$('newPrompt').oninput = creationState; $('newProject').onchange = () => { renderProjects(); creationState(); };
$('checkCreation').onclick = checkCreation;
$('newChatForm').onsubmit = async e => {
  e.preventDefault(); creationState(); if ($('createChat').disabled) return;
  const c = state.creation, authEpoch = state.authEpoch, intent = navigation.intent;
  const requestId = uuid(), value = $('newProject').value;
  const files = attachments.snapshot('new');
  const input = { requestId, text: $('newPrompt').value, target: value ? { type: 'project', projectId: value } : { type: 'projectless' }, ...modelSelection('create'), ...(files.length ? { attachments: files } : {}) };
  c.auto = { requestId, intent, text: input.text, files }; c.nextAt = Date.now() + 2000; c.attempt = 0;
  c.receipt = { kind: 'create', requestId, state: 'reserved' }; c.busy = true; c.message = ''; c.missing = false; persistDevice(true); creationState();
  try {
    const receipt = await api('/api/create', input);
    if (c !== state.creation || authEpoch !== state.authEpoch) return;
    c.receipt = receipt;
    completeCreation(c, true);
  } catch (err) {
    if (c !== state.creation || authEpoch !== state.authEpoch) return;
    c.receipt.state = err.status >= 400 && err.status < 500 && !['CREATE_UNCERTAIN', 'REQUEST_ID_CONFLICT', 'PREVIOUS_CREATE_UNCERTAIN', 'CREATE_IN_PROGRESS'].includes(err.code) ? 'rejected' : 'uncertain';
    c.message = errorText(err);
  } finally { if (c === state.creation && authEpoch === state.authEpoch) { c.busy = false; persistDevice(true); creationState(); } }
};
$('openCreated').onclick = () => { const r = state.creation.receipt; if (r?.state === 'delivered' && r.threadId) openThread(r.threadId); };
$('acknowledgeCreation').onclick = async () => {
  const c = state.creation, authEpoch = state.authEpoch;
  if (c.busy || c.checking || !c.receipt || !['pending', 'uncertain'].includes(c.receipt.state)) return;
  if (!confirm('PC 대화 목록에서 생성 여부를 직접 확인하셨나요? 보호만 해제하며 취소·재생성하지 않습니다. 새로 만들면 중복 작업이 될 수 있습니다.')) return;
  c.checking = true; creationState();
  try {
    const receipt = c.missing ? { ...c.receipt, state: 'acknowledged' } : await api(`/api/create/${c.receipt.requestId}/acknowledge`, { confirmed: true });
    if (c !== state.creation || authEpoch !== state.authEpoch) return;
    c.receipt = receipt; c.message = ''; persistDevice(true);
  } catch (e) { if (c === state.creation && authEpoch === state.authEpoch) c.message = errorText(e); }
  finally { if (c === state.creation && authEpoch === state.authEpoch) { c.checking = false; creationState(); } }
};
function clearQuestions() {
  state.questionNodes.clear(); state.questionResult = null; state.questionFlight = null; state.questionAt = 0;
  $('questionCards').replaceChildren(); $('questions').hidden = true; $('questions').open = false; delete $('questions').dataset.mode;
  $('questionStatus').textContent = ''; $('questionStatus').hidden = true; $('questionRetry').hidden = true; $('questionRetry').disabled = false; setText($('questionSummary'), '질문 기록');
}
function canSend() {
  const cap = state.capability;
  return Boolean(state.selected && state.csrf && state.connected && cap.online && cap.continuationEnabled && !cap.uncertain && !accountLocked() && !state.recovery.gated && !state.recovery.suspended && navigator.onLine !== false && !state.sending && !state.acknowledging && !state.serverSending && !state.pending);
}
function answerableQuestion(q) {
  return q && ['unconfirmed', 'historical'].includes(q.state) && /^[0-9a-f]{64}$/.test(q.sourceKey || '');
}
function sameQuestion(a, b) {
  return a.id === b.id && a.sourceKey === b.sourceKey && a.title === b.title && JSON.stringify(a.options) === JSON.stringify(b.options);
}
function questionDelivered(q) {
  return q?.state === 'answered' || /^[0-9a-f]{64}$/.test(q?.sourceKey || '') && (q.messageState === 'delivered' || state.questionReceipts.get(`${state.selected}/${q.id}`) === q.sourceKey);
}
function questionActions() {
  for (const ui of state.questionNodes.values()) if (ui.send) {
    const source = state.questionResult?.state === 'ready' && state.questionResult.data?.find(q => sameQuestion(q, ui.question) && answerableQuestion(q));
    const local = state.questionReceipts.get(`${state.selected}/${ui.question.id}`);
    const receipt = local && local === ui.question.sourceKey ? 'delivered' : (source || ui.question).messageState;
    let note = receipt === 'delivered' ? '답변 메시지를 전달했습니다. PC 질문은 PC에서 확인해 주세요. 폼 응답 완료는 확인되지 않았으며 다시 보내지 않습니다.'
      : ['reserved', 'uncertain', 'acknowledged'].includes(receipt) ? '이 답변의 전달 여부가 미확인입니다. 전송 상태와 PC 대화 기록을 확인해 주세요. 자동으로 다시 보내지 않습니다.'
      : !source ? state.questionResult?.state !== 'ready' ? '질문 소스를 확인할 수 없습니다. 입력은 유지됩니다. 질문 기록을 다시 확인해 주세요.' : '현재 조회 범위에 없거나 질문 내용이 변경되었습니다. 입력은 유지됩니다. 기록 재확인 전에는 보낼 수 없습니다.'
      : state.pending || state.sending || state.serverSending ? '이전 요청의 전달 여부를 확인 중입니다. 전송 상태를 먼저 확인해 주세요.'
      : accountLocked() || state.recovery.gated || state.recovery.suspended ? '재연결 중입니다. 이전 요청 상태 확인 후 보낼 수 있습니다.'
      : navigator.onLine === false || !state.connected ? '오프라인 또는 PC 연결 확인 필요 · 답변은 유지됩니다.'
      : !canSend() ? '전송 잠금 또는 PC 연결을 먼저 확인해 주세요. 답변은 유지됩니다.'
      : ui.failure ? ui.failure : receipt === 'rejected' ? '이전 답변 메시지는 전송 전에 거절되었습니다. 답변을 확인하고 직접 다시 보내세요.'
      : !ui.answer ? '선택지를 누르거나 직접 답변을 입력해 주세요.' : '';
    ui.send.disabled = !canSend() || !source || !ui.answer || ['delivered', 'reserved', 'uncertain', 'acknowledged'].includes(receipt);
    setText(ui.feedback, note);
    if (receipt === 'delivered') setText(ui.status, '답변 메시지 전달됨 · PC 질문 폼의 응답 완료는 확인되지 않았습니다.');
    else if (['reserved', 'uncertain', 'acknowledged'].includes(receipt)) setText(ui.status, '답변 메시지 전달 여부 미확인 · PC 대화 기록과 전송 상태를 확인해 주세요.');
    else setText(ui.status, `${ui.question.state === 'historical' ? '이전 작업의 미응답 질문 기록' : '미응답 질문 기록'} · 현재 PC 대기 여부는 확인할 수 없습니다.`);
    ui.retry.hidden = Boolean(source) && !ui.failure;
  }
}
function questionCard(q) {
  const eligible = answerableQuestion(q), root = node(eligible ? 'article' : 'details', undefined, 'question-card');
  const ui = { root, question: q, answer: '', signature: JSON.stringify(q) };
  if (!eligible) {
    root.append(node('summary', `${q.state === 'answered' ? '답변 완료' : q.state === 'pc-only' ? 'PC에서 확인' : '이전 질문'} · ${q.title}`));
    root.append(node('p', q.state === 'answered' ? `답변: ${q.answer}` : q.state === 'pc-only' ? '이 질문과 PC 승인 요청은 PC에서 처리해 주세요.' : '질문 식별 정보를 확인할 수 없어 읽기 전용으로 표시합니다. 질문 기록을 다시 확인하거나 PC에서 답해 주세요.'));
    return ui;
  }
  root.append(node('h3', q.title));
  const status = node('p', '', 'question-status'); root.append(status); ui.status = status;
  const form = node('div', undefined, 'question-answer');
  const fieldset = node('fieldset'), legend = node('legend', '선택하거나 직접 입력하세요'); fieldset.append(legend);
  const radios = [], directLabel = node('label', '직접 답변'), direct = node('textarea'); direct.rows = 2; direct.maxLength = 2000;
  direct.setAttribute('aria-label', `${q.title} · 직접 답변`); directLabel.append(direct);
  const feedback = node('p', '', 'question-status'); feedback.setAttribute('role', 'status');
  const send = node('button', '답변 보내기'); send.type = 'button'; send.disabled = true;
  const retry = node('button', '질문 기록 다시 확인'); retry.type = 'button'; retry.hidden = true;
  const epoch = state.epoch, id = state.selected;
  const current = () => epoch === state.epoch && id === state.selected && state.questionNodes.get(q.id) === ui;
  (q.options ?? []).slice(0, 8).forEach((option, index) => {
    const label = node('label', undefined, 'question-option'), radio = node('input'); radio.type = 'radio'; radio.name = JSON.stringify([state.epoch, q.id]); radio.value = String(index); radio.checked = false;
    radio.onchange = () => { if (!current() || !radio.checked) return; radios.forEach(other => { if (other !== radio) other.checked = false; }); direct.value = ''; ui.answer = option; ui.failure = ''; questionActions(); };
    label.append(radio, node('span', option)); fieldset.append(label); radios.push(radio);
  });
  direct.oninput = () => { if (!current()) return; radios.forEach(radio => { radio.checked = false; }); ui.answer = direct.value.trim().slice(0, 2000); ui.failure = ''; questionActions(); };
  retry.onclick = async () => { if (!current() || retry.disabled) return; retry.disabled = true; ui.failure = ''; try { await $('questionRetry').onclick(); } finally { if (current()) { retry.disabled = false; questionActions(); } } };
  send.onclick = async () => {
    questionActions(); if (send.disabled || epoch !== state.epoch || id !== state.selected || state.questionNodes.get(q.id) !== ui) return;
    ui.failure = '';
    const failure = await sendText(`질문: ${q.title}\n답변: ${ui.answer}`, q.id);
    if (current() && failure) { ui.failure = errorText(failure); questionActions(); }
  };
  ui.send = send; ui.feedback = feedback; ui.retry = retry;
  if (radios.length) form.append(fieldset);
  form.append(directLabel, node('p', '답변을 이 대화에 메시지로 보냅니다. PC 질문 폼의 선택·완료를 대신하지 않습니다. PC 승인 요청은 PC에서 처리하세요.', 'question-status'), feedback, send, retry); root.append(form);
  return ui;
}
function renderQuestions(result) {
  state.questionResult = result;
  const all = result.state === 'ready' && Array.isArray(result.data) ? result.data : [];
  // Delivery is evidence of an answer message, not completion of the native PC form.
  for (const [id, ui] of state.questionNodes) if (questionDelivered(ui.question) || all.some(q => q?.id === id && questionDelivered(q))) {
    if (ui.send) ui.send.disabled = true;
    ui.root.remove(); state.questionNodes.delete(id);
  }
  const data = all.filter(q => q && typeof q.id === 'string' && typeof q.title === 'string' && ['unconfirmed', 'historical', 'pc-only'].includes(q.state) && !questionDelivered(q)).slice(-12);
  const area = $('questions'), discovered = data.some(q => !state.questionNodes.has(q.id));
  const recent = result.coverage === 'recent';
  area.hidden = result.state === 'ready' && !data.length && !recent && ![...state.questionNodes.values()].some(ui => ui.answer || ['reserved', 'uncertain', 'acknowledged'].includes(ui.question.messageState));
  if (discovered) area.open = true; // No focus/scroll calls; routine polls preserve the user's collapsed state.
  setText($('questionSummary'), result.state === 'ready' ? `${recent ? '최근 구간 · ' : ''}미응답 질문 ${data.length}개` : result.state === 'loading' ? `${recent ? '최근 구간 · ' : ''}질문 확인 중` : '질문 확인 불가');
  const scope = recent ? '최근 제한 구간만 확인했습니다. 오래된 질문·답변은 포함되지 않을 수 있으며 전체 기록에 질문이 없다는 뜻이 아닙니다. 전체 기록은 PC에서 확인해 주세요.' : '';
  const note = result.reason === 'runtime-unavailable' ? 'PC의 질문 조회 연결을 시작하지 못했습니다. Codex 업데이트 직후라면 잠시 후 다시 확인해 주세요. 입력한 답변은 유지됩니다.' : result.reason === 'line-too-large' ? '한 줄이 안전한 읽기 한도(512KiB)를 넘었습니다. PC에서 질문 기록을 확인해 주세요.' : result.state === 'loading' ? '질문을 제한된 크기로 나누어 확인하고 있습니다. 입력한 답변은 유지됩니다.' : result.state === 'ready' ? '' : '소스를 확인하지 못했습니다. 다시 확인하거나 PC에서 질문을 확인해 주세요. 입력한 답변은 유지됩니다.';
  setText($('questionStatus'), [scope, note].filter(Boolean).join(' '));
  $('questionStatus').hidden = !scope && !note;
  $('questionRetry').hidden = result.state === 'ready' && !recent && !data.some(q => ['unconfirmed', 'historical'].includes(q?.state) && !answerableQuestion(q));
  if (result.state !== 'ready') { questionActions(); return; } // Retain unsent card input/open state through transient failures.
  const children = [], ids = new Set();
  for (const q of data) {
    if (!q || typeof q.id !== 'string' || typeof q.title !== 'string' || !['unconfirmed', 'answered', 'historical', 'pc-only'].includes(q.state)) continue;
    ids.add(q.id); let ui = state.questionNodes.get(q.id);
    const signature = JSON.stringify(q);
    if (ui && answerableQuestion(q) && answerableQuestion(ui.question) && sameQuestion(q, ui.question)) {
      // Async questions outlive tasks; turn/receipt changes must not detach a focused answer form.
      ui.question = q; ui.signature = signature;
    } else if (ui?.send && answerableQuestion(q) && (ui.answer || ui.editing)) {
      // Keep changed-source drafts visible, but never apply them to the replacement question.
    } else if (!ui || ui.signature !== signature) { ui = questionCard(q); state.questionNodes.set(q.id, ui); }
    children.push(ui.root);
  }
  for (const [id, ui] of state.questionNodes) if (!ids.has(id)) {
    if ((ui.answer || ui.editing || ['reserved', 'uncertain', 'acknowledged'].includes(ui.question.messageState)) && children.length < 24) {
      children.push(ui.root); setText(ui.feedback, '현재 조회 범위에 없는 질문입니다. 작성 내용은 유지되며, 기록을 다시 확인하기 전에는 보낼 수 없습니다.');
    } else state.questionNodes.delete(id);
  }
  if (children.length) area.hidden = false;
  if (children.length > data.length) setText($('questionSummary'), `${recent ? '최근 구간 · ' : ''}미응답 질문 ${data.length}개 · 이전 입력·전달 상태 확인 필요`);
  reconcile($('questionCards'), children); questionActions();
}
function refreshQuestions(epoch = state.epoch) {
  if (state.questionFlight?.epoch === epoch) return state.questionFlight.promise;
  if (!viewingCurrent() || !state.selected || !state.csrf || (state.questionAt && Date.now() - state.questionAt < 2000)) return Promise.resolve();
  const id = state.selected, flight = { epoch }; state.questionFlight = flight; state.questionAt = Date.now();
  flight.promise = api(`/api/threads/${id}/questions`).then(result => {
    if (epoch === state.epoch && id === state.selected && state.csrf) renderQuestions(result);
  }).catch(e => {
    if (e.code !== 'STALE_RESPONSE' && epoch === state.epoch && id === state.selected && state.csrf) renderQuestions({ state: 'unavailable', data: [] });
  }).finally(() => { if (state.questionFlight === flight) state.questionFlight = null; });
  return flight.promise;
}
$('questionRetry').onclick = async () => {
  if ($('questionRetry').disabled) return;
  const epoch = state.epoch; $('questionRetry').disabled = true;
  try { state.questionAt = 0; await refreshCurrent(epoch); if (epoch === state.epoch) await refreshQuestions(epoch); }
  catch (e) { if (epoch === state.epoch) showError(e); }
  finally { if (epoch === state.epoch) $('questionRetry').disabled = false; }
};
function composerState() {
  renderModelSelect('send');
  const cap = state.capability, pendingHere = state.pending?.threadId === state.selected;
  $('attachFiles').disabled = accountLocked() || !state.selected || !state.csrf || state.sending || Boolean(pendingHere);
  renderAttachments(state.selected);
  const available = state.selected && state.connected && cap.online && cap.continuationEnabled && !cap.uncertain;
  $('draft').disabled = !state.selected || state.sending || Boolean(pendingHere);
  $('send').disabled = !available || accountLocked() || state.recovery.gated || state.recovery.suspended || navigator.onLine === false || !attachments.ready(state.selected) || state.sending || state.acknowledging || state.serverSending || Boolean(state.pending) || !$('draft').value.trim();
  $('send').textContent = state.sending ? '…' : '↑';
  const sendLabel = state.sending ? '전송 중' : state.status === 'active' ? '같은 대화에 추가 지시' : '선택한 대화에 보내기';
  $('send').setAttribute('aria-label', sendLabel); $('send').title = sendLabel;
  $('checkSend').hidden = !pendingHere;
  $('sendRecovery').hidden = !state.recoverRequest;
  $('acknowledgeSend').disabled = !state.connected || state.sending || state.serverSending || Boolean(state.acknowledging);
  const historyError = ['HISTORY_SIZE_LIMIT', 'DESKTOP_TOOL_FAILED'].includes(state.errorCode);
  $('connection').textContent = !state.selected ? '대기' : historyError ? '기록 확인 필요' : !state.connected ? '재연결 중' : state.status === 'active' ? '작업 중' : '연결됨';
  $('connection').classList.toggle('online', Boolean(state.connected && cap.online));
  const feedback = accountLocked() ? '계정 확인 필요 · 도구의 계정 화면에서 상태를 확인해 주세요. 초안과 연결은 유지합니다.' : state.recovery.gated ? '재연결 · 이전 요청 상태부터 확인 중입니다.' : navigator.onLine === false ? '오프라인 · 초안과 첨부는 유지됩니다.' : !attachments.ready(state.selected) ? '첨부를 전송 완료하거나 제거해 주세요.' : state.sending ? '전달 여부 확인 중…' : pendingHere ? '중복 전송 방지 · 상태 확인 필요' : cap.uncertain ? '이전 전송 불명 · PC 확인 필요' : state.serverSending ? '다른 전송의 전달 여부를 확인 중입니다. 잠시 뒤 확인해 주세요.' : state.pending ? '다른 대화의 전송 상태를 먼저 확인해 주세요.' : state.selected && (historyError || !state.connected || !available) ? historyError ? '기록 확인 필요 · PC에서 확인해 주세요.' : !state.connected ? 'PC 연결 확인 필요 · 초안은 유지됩니다.' : '읽기 전용 · PC 연결 확인 필요' : '';
  const storageFeedback = state.savedDevice === false ? '기기 저장 실패 · 초안은 화면에 유지됩니다. 닫기 전에 복사해 주세요.' : '';
  setText($('composerStatus'), [feedback, storageFeedback].filter(Boolean).join(' ')); $('composerFeedback').hidden = !feedback && !storageFeedback && !pendingHere;
  fitDraft(); questionActions(); quickState(); editorState();
  if (state.tools.pane === 'updates') renderUpdates();
  if (state.tools.pane === 'accounts') renderAccounts();
}
function fitDraft() {
  const draft = $('draft'), height = viewportHeight(), cap = height <= 500 ? 44 : Math.max(44, Math.min(144, height * .25));
  const layout = JSON.stringify([draft.value, draft.clientWidth, cap]);
  if (layout === state.draftLayout) return;
  state.draftLayout = layout; draft.style.height = 'auto';
  draft.style.height = `${Math.max(44, Math.min(cap, draft.scrollHeight))}px`;
  draft.style.overflowY = draft.scrollHeight > cap ? 'auto' : 'hidden';
}
function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const s = [...b].map(n => n.toString(16).padStart(2, '0')).join(''); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
function savePending() { try { if (state.pending) sessionStorage.setItem('codex-phone-pending', JSON.stringify({ ...durable.bounded({ version: 2, scope: durable.scope, pending: state.pending }).pending, storageScope: durable.scope })); else sessionStorage.removeItem('codex-phone-pending'); } catch { /* Only request IDs, never messages or credentials. */ } persistDevice(true); }
function settlePending(receipt) {
  if (state.pending?.requestId !== receipt.requestId || !['delivered', 'rejected', 'acknowledged'].includes(receipt.state)) return;
  if (receipt.state === 'delivered') {
    attachments.consume(receipt.threadId, state.pending.files);
    if (state.pending.selection && JSON.stringify(state.models.preferences.get(receipt.threadId)) === JSON.stringify(state.pending.selection)) state.models.preferences.delete(receipt.threadId);
    if (state.pending.questionId) {
      state.questionReceipts.set(`${receipt.threadId}/${state.pending.questionId}`, state.pending.questionSourceKey || true);
      while (state.questionReceipts.size > 128) state.questionReceipts.delete(state.questionReceipts.keys().next().value);
    } else {
      state.drafts.delete(receipt.threadId);
      if (receipt.threadId === state.selected) { $('draft').value = ''; $('composerStatus').textContent = 'PC 대화에 전달했습니다. 작업 완료를 뜻하지 않습니다.'; }
    }
  }
  state.pending = null; savePending();
  if (state.questionResult) renderQuestions(state.questionResult);
  composerState();
}
async function checkPending() {
  const pending = state.pending, authEpoch = state.authEpoch;
  if (!pending) return;
  try {
    const receipt = await api(`/api/requests/${pending.requestId}`);
    if (authEpoch !== state.authEpoch || pending !== state.pending) return;
    settlePending(receipt);
    if (['delivered', 'acknowledged'].includes(receipt.state) && (connectionErrors.has(state.errorCode) || ['SEND_UNCERTAIN', 'PREVIOUS_SEND_UNCERTAIN'].includes(state.errorCode))) clearError();
    if (['uncertain', 'reserved'].includes(receipt.state)) showError({ code: 'SEND_UNCERTAIN' });
  } catch (e) {
    if (authEpoch !== state.authEpoch || pending !== state.pending) return;
    if (e.code === 'REQUEST_NOT_FOUND') showError({ code: 'SEND_UNCERTAIN' }); else throw e;
  }
}
$('acknowledgeSend').onclick = async () => {
  const id = state.selected, epoch = state.epoch;
  state.acknowledging = true; composerState();
  try {
    await refreshCurrent(epoch);
    if (epoch !== state.epoch || !state.recoverRequest) return;
    const requestId = state.recoverRequest;
    if (!confirm('현재 대화 기록에서 이전 요청의 전달 여부를 직접 확인하셨나요? 로컬 전송 보호만 해제합니다. 이전 요청을 취소하거나 다시 보내지 않습니다. 새로 보내면 중복 작업이 될 수 있습니다.')) return;
    const receipt = await api(`/api/requests/${requestId}/acknowledge`, { threadId: id, confirmed: true });
    settlePending(receipt); // Acknowledgement never clears the in-memory draft.
    if (epoch === state.epoch) {
      if (['SEND_UNCERTAIN', 'PREVIOUS_SEND_UNCERTAIN', 'READ_CURRENT_THREAD_FIRST'].includes(state.errorCode)) clearError();
      await refreshCurrent(epoch);
    }
  } catch (e) { if (epoch === state.epoch) showError(e); }
  finally { state.acknowledging = false; composerState(); }
};
$('checkSend').onclick = () => checkPending().catch(showError);
$('draft').oninput = () => { composerState(); persistDevice(); };
$('composer').onsubmit = e => { e.preventDefault(); if (!$('send').disabled) return sendText($('draft').value); };
async function sendText(message, questionId = null) {
  if (!canSend() || !message.trim() || !questionId && !attachments.ready(state.selected)) return;
  const id = state.selected, epoch = state.epoch, authEpoch = state.authEpoch;
  const selection = state.models.preferences.get(id), files = questionId ? [] : attachments.snapshot(id);
  const q = questionId && state.questionNodes.get(questionId)?.question;
  const question = q?.sourceKey ? { question: { id: q.id, sourceKey: q.sourceKey } } : {};
  const input = { threadId: id, requestId: uuid(), text: message, ...selection, ...(files.length ? { attachments: files } : {}), ...question };
  state.pending = { requestId: input.requestId, threadId: id, ...(files.length ? { files } : {}), ...(questionId ? { questionId, ...(q?.sourceKey ? { questionSourceKey: q.sourceKey } : {}) } : {}), ...(selection ? { selection: { ...selection } } : {}) }; savePending(); state.sending = true; clearError(); composerState();
  try {
    const receipt = await api('/api/send', input);
    if (authEpoch !== state.authEpoch) return;
    settlePending(receipt);
    if (epoch === state.epoch) await refreshCurrent(epoch);
  } catch (err) {
    if (authEpoch !== state.authEpoch) return;
    if (err.status >= 400 && err.status < 500 && !['SEND_UNCERTAIN', 'REQUEST_ID_CONFLICT'].includes(err.code)) { state.pending = null; savePending(); }
    if (epoch === state.epoch) showError(err); await checkPending().catch(() => {});
    return err;
  } finally { if (authEpoch === state.authEpoch) { state.sending = false; composerState(); schedulePoll(); } }
}
// Viewport changes are local layout only; there is no native JavaScript bridge.
let viewportFrame = null;
function viewportHeight() {
  const heights = [window.innerHeight, window.visualViewport?.height].filter(h => Number.isFinite(h) && h > 0);
  return heights.length ? Math.min(...heights) : 640;
}
function viewport() {
  const height = viewportHeight();
  document.documentElement.style.setProperty('--app-height', `${height}px`);
  document.documentElement.dataset.compactViewport = String(height <= 500);
  fitDraft(); resizeImage(); resizeToolsNav();
}
function resizeViewport() {
  viewport();
  if (viewportFrame === null && !document.hidden) viewportFrame = requestAnimationFrame(() => { viewportFrame = null; viewport(); });
}
window.visualViewport?.addEventListener('resize', resizeViewport); window.addEventListener('resize', resizeViewport); viewport();
function recoverVisible() {
  stopReveal(); viewport();
  if (document.hidden || navigator.onLine === false) return Promise.resolve();
  if (!state.csrf) return state.booting ? Promise.resolve() : boot();
  const recovery = state.recovery, authEpoch = state.authEpoch;
  recovery.suspended = false; state.usage.suspended = false;
  if (recovery.flight) return recovery.flight;
  recovery.gated = true; const generation = recovery.generation = (recovery.generation || 0) + 1; composerState(); creationState();
  const current = () => recovery === state.recovery && generation === recovery.generation && authEpoch === state.authEpoch && !recovery.suspended && !document.hidden;
  recovery.flight = (async () => {
    try {
      await checkPending(); if (!current()) return;
      await checkCreation(true); if (!current()) return;
      if (state.creation.message || state.creation.checking) throw { code: 'NETWORK' };
      recovery.gated = false; recovery.failures = 0;
      if (state.accounts.revision) { await accountPresence(); if (accountLocked()) { await refreshAccounts(); return; } }
      if (viewingCurrent() && state.selected) await refreshCurrent();
      if (!current()) return;
      refreshUsage(); refreshRelease(); await refreshActivity();
    } catch (e) { if (current() && e.code !== 'STALE_RESPONSE') { recovery.failures = Math.min(3, recovery.failures + 1); showError(e); } }
    finally { if (current()) { recovery.flight = null; composerState(); creationState(); scheduleActivity(); schedulePoll(); } }
  })();
  return recovery.flight;
}
function suspendRecovery() {
  if (viewportFrame !== null) { cancelAnimationFrame(viewportFrame); viewportFrame = null; }
  state.recovery.suspended = true; state.recovery.gated = true; state.recovery.generation = (state.recovery.generation || 0) + 1; state.recovery.flight = null; cancelReads();
  clearTimeout(state.timer); clearTimeout(state.activityTimer);
  composerState(); creationState();
}
document.addEventListener('visibilitychange', () => {
  stopReveal();
  if (document.hidden) { cancelAccountConfirmation(); imageGestures(); persistDevice(true); accountPresence(); pauseVideos(); suspendRecovery(); }
  clearTimeout(state.timer); clearTimeout(state.activityTimer); clearTimeout(state.usage.timer); state.usage.timer = null; stopUsageClock();
  if (!document.hidden && state.csrf) recoverVisible();
});
window.addEventListener('online', recoverVisible);
window.addEventListener('pageshow', recoverVisible);
window.addEventListener('offline', () => { cancelAccountConfirmation(); suspendRecovery(); stopReveal(); pauseVideos(); clearTimeout(state.usage.timer); state.usage.timer = null; stopUsageClock(); renderUsage(); });
window.addEventListener('pagehide', () => {
  cancelAccountConfirmation(false); navigation.revision++; stopReveal(); persistDevice(true); closeAccountPresence(); clearImage(); suspendRecovery();
  // Do not start a history traversal while the document is leaving / entering BFCache.
  if ($('imageDialog').open) { $('imageCaption').textContent = '대화 이미지'; $('imageViewerStatus').textContent = '이미지 보기를 닫고 다시 열어 주세요.'; $('imageViewerStatus').hidden = false; }
  state.usage.suspended = true; clearTimeout(state.usage.timer); state.usage.timer = null; stopUsageClock();
});
window.addEventListener('codexNative', e => {
  const d = e.detail || {};
  if (d.version === 2) state.nativeVersion = 2;
  if (typeof d.monitor === 'boolean') state.nativeMonitor = d.monitor;
  $('monitorStart').hidden = state.nativeMonitor; $('monitorStop').hidden = !state.nativeMonitor;
  if (typeof d.message === 'string') { $('nativeStatus').textContent = d.message.slice(0, 300); $('nativeStatus').hidden = false; }
  if (typeof d.transfer === 'string') { $('transferStatus').textContent = d.transfer.slice(0, 300); $('transferArea').hidden = false; }
  if (d.transfer || d.transferDone) state.transferBusy = !d.transferDone;
  if (d.transferDone) $('cancelTransfer').hidden = true;
  else if (d.transfer) $('cancelTransfer').hidden = false;
  if (state.tools.pane === 'updates') renderUpdates();
  if (state.tools.pane === 'accounts') renderAccounts();
});
window.addEventListener('codexOpenThread', e => {
  const id = e.detail?.threadId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return;
  if (state.csrf && !state.booting) openThread(id); else state.openIntent = id;
});
for (const id of ['monitorStart', 'monitorStop', 'cancelTransfer']) $(id).onclick = e => {
  if (state.nativeVersion < 2) { e.preventDefault(); $('nativeStatus').hidden = false; $('nativeStatus').textContent = '이 기능은 Codex 원격 v0.2 앱에서 사용할 수 있습니다.'; }
};
Object.defineProperty(window, 'codexPhoneFileContext', { get: () => state.csrf && !state.loggingOut ? `${navigation.scope}:${state.authEpoch}:${navigation.intent}:${state.selected || 'list'}:${$('newChatDialog').open ? 'new' : 'chat'}` : null });
Object.defineProperty(window, 'codexPhoneDocument', { get: () => navigation.scope });
initConveniences(); initAccounts();
window.codexPhoneReady = true;
boot();
