'use strict';
// Run in the head: the known native root already pads system bars, cutout and IME.
// This spoofable marker owns layout only, never capabilities or authorization.
function setSafeAreaOwner(userAgent = navigator.userAgent) {
  const native = /(?:^|\s)CodexPhone\/2 CodexPhoneApp\/0\.3\.0(?:\s|$)/.test(userAgent);
  document.documentElement.dataset.insetOwner = native ? 'native' : 'browser';
  for (const edge of ['top', 'right', 'bottom', 'left']) document.documentElement.style.setProperty(`--safe-${edge}`, native ? '0px' : `var(--viewport-safe-${edge})`);
}
setSafeAreaOwner();
// Secondary UI only. All dispatch stays in the ordinary guarded composer.
function renderLatestAnswer() {
  const pending = state.latestAnswer.pending && state.historyNodes.has(state.latestAnswer.key);
  $('latestResponse').hidden = !pending;
  $('latestResponse').textContent = '새 답변 ↓';
}
function jumpLatestAnswer() {
  const ui = state.historyNodes.get(state.latestAnswer.key);
  if (!state.csrf || !viewingCurrent() || !ui) return;
  stopReveal(); state.reveal.away = false;
  const area = $('history');
  area.scrollTop += ui.root.getBoundingClientRect().top - area.getBoundingClientRect().top;
  state.reveal.top = area.scrollTop; state.latestAnswer.pending = false; renderLatestAnswer();
  // Reading a long answer's beginning does not acknowledge its unseen end.
  markViewed(); persistDevice();
}
function editorCurrent() {
  return state.editor && state.editor.auth === state.authEpoch && state.editor.thread === state.selected && state.csrf;
}
function syncEditor() {
  const editor = state.editor;
  if (!editor || editor.auth !== state.authEpoch || !state.csrf) return;
  const value = $('expandedDraft').value.slice(0, 16000);
  state.drafts.set(editor.thread, value);
  if (editor.thread === state.selected) { $('draft').value = value; state.draftThread = editor.thread; }
}
function editorState() {
  const locked = !state.csrf || !state.selected || $('draft').disabled || state.sending || state.serverSending || Boolean(state.pending) || state.capability.uncertain;
  $('expandDraft').disabled = Boolean(locked);
  $('expandedDraft').disabled = Boolean(locked || !editorCurrent());
  if (state.editor) $('editorStatus').textContent = state.savedDevice === false ? '기기 저장 실패 · 편집 내용은 화면에 유지됩니다. 닫기 전에 복사해 주세요.' : locked ? '전송 확인 중에는 편집할 수 없습니다. 초안은 유지됩니다.' : '같은 대화의 초안입니다. 돌아간 뒤 보내기를 눌러 주세요.';
}
function finishEditor() {
  const editor = state.editor, current = editorCurrent(); syncEditor();
  if (editor && state.composing.has('expandedDraft')) { editor.detached = true; persistDevice(true); return; }
  const start = $('expandedDraft').selectionStart, end = $('expandedDraft').selectionEnd;
  state.editor = null; state.composing.delete('expandedDraft'); $('expandedDraft').value = '';
  if (current) {
    persistDevice(true); fitDraft();
    if (!document.hidden && !state.loggingOut && viewingCurrent() && editor.thread === state.selected) {
      $('draft').focus({ preventScroll: true }); $('draft').setSelectionRange?.(start, end);
    }
  }
}
function openEditor() {
  editorState();
  if ($('expandDraft').disabled || state.editor || state.composing.has('draft') || navigation.pending || state.tools.layer) return;
  const draft = $('draft');
  state.editor = { thread: state.selected, auth: state.authEpoch };
  $('expandedDraft').value = draft.value;
  openToolLayer('editorDialog'); editorState();
  $('expandedDraft').focus({ preventScroll: true });
  $('expandedDraft').setSelectionRange?.(draft.selectionStart ?? draft.value.length, draft.selectionEnd ?? draft.value.length);
}
function resetSnippetForm() {
  state.snippetEdit = null; $('snippetLabel').value = ''; $('snippetText').value = '';
  $('saveSnippet').textContent = '추가'; $('cancelSnippet').hidden = true; $('snippetFeedback').textContent = '';
}
function saveSnippets(message) {
  renderSnippets(); persistDevice(true);
  $('snippetFeedback').textContent = state.savedDevice ? message : message + ' · 기기 저장 실패. 화면에는 유지되지만 앱을 닫으면 사라질 수 있습니다.';
}
function renderSnippets() {
  const existing = new Map(Array.from($('snippetList').children).map(row => [row.snippetId, row]));
  const auth = state.authEpoch;
  const current = id => auth === state.authEpoch && state.csrf && state.snippets.some(r => r.id === id);
  const rows = state.snippets.map((snippet, index) => {
    let row = existing.get(snippet.id);
    if (!row) {
      row = node('div', undefined, 'snippet-row'); row.snippetId = snippet.id;
      row.apply = node('button'); row.apply.type = 'button';
      const actions = node('div', undefined, 'tool-actions'); row.actions = {};
      for (const [action, label] of [['edit', '수정'], ['up', '위로'], ['down', '아래로'], ['remove', '삭제']]) {
        const button = node('button', label); button.type = 'button'; row.actions[action] = button; actions.append(button);
        button.onclick = () => {
          if (!current(snippet.id)) return;
          const at = state.snippets.findIndex(r => r.id === snippet.id), value = state.snippets[at];
          if (action === 'edit') {
            state.snippetEdit = value.id; $('snippetLabel').value = value.label; $('snippetText').value = value.text;
            $('saveSnippet').textContent = '수정 저장'; $('cancelSnippet').hidden = false; $('snippetLabel').focus(); return;
          }
          if (action === 'remove') {
            if (!confirm(`‘${value.label}’ 지시를 삭제할까요?`)) return;
            state.snippets.splice(at, 1); if (state.snippetEdit === value.id) resetSnippetForm();
            saveSnippets('삭제했습니다.'); $('snippetLabel').focus(); return;
          }
          const next = at + (action === 'up' ? -1 : 1);
          if (next < 0 || next >= state.snippets.length) return;
          [state.snippets[at], state.snippets[next]] = [state.snippets[next], state.snippets[at]];
          saveSnippets('순서를 저장했습니다.'); button.focus({ preventScroll: true });
        };
      }
      row.apply.onclick = () => { if (current(snippet.id)) applyQuickInstruction(state.snippets.find(r => r.id === snippet.id).text); };
      row.append(row.apply, actions);
    }
    setText(row.apply, snippet.label); row.apply.title = snippet.text;
    for (const [action, button] of Object.entries(row.actions)) button.setAttribute('aria-label', `${snippet.label} · ${button.textContent}`);
    row.actions.up.disabled = index === 0; row.actions.down.disabled = index === state.snippets.length - 1;
    return row;
  });
  reconcile($('snippetList'), rows); $('snippetEmpty').hidden = rows.length > 0; quickState();
}
function applyQuickInstruction(text) {
  quickState(); if ($('quickContinue').disabled || state.composing.size || !state.csrf) return;
  syncEditor(); const id = state.selected, draft = $('draft'), value = draft.value + (draft.value ? '\n\n' : '') + text;
  if (value.length > 16000) { $('quickFeedback').textContent = '초안의 16,000자 한도를 넘어 추가하지 않았습니다. 기존 초안은 유지됩니다.'; return; }
  draft.value = value; state.draftThread = id; state.drafts.set(id, value);
  if (editorCurrent()) $('expandedDraft').value = value;
  composerState(); persistDevice(true); const auth = state.authEpoch, closing = closeTools();
  const focus = () => { if (state.csrf && auth === state.authEpoch && id === state.selected && !state.tools.layer) { draft.focus(); draft.setSelectionRange?.(value.length, value.length); } };
  if (!state.tools.layer) focus(); else if (closing) closing.then(focus);
}
function validRelease(value) {
  return value && typeof value.revision === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.revision) &&
    Array.isArray(value.notes) && value.notes.length <= 6 && value.notes.every(n => typeof n === 'string' && n.length > 0 && n.length <= 180 && !/[\x00-\x1f\x7f]/.test(n));
}
function updateBlock() {
  if (accountLocked() || state.accounts.result?.operation?.state === 'waiting') return '계정 작업 또는 현재 계정 확인을 먼저 마쳐 주세요.';
  if (!state.csrf || state.booting || state.loggingOut || document.hidden || navigator.onLine === false || state.recovery.gated || state.recovery.suspended) return '연결 확인이 끝난 뒤 다시 적용해 주세요.';
  if (state.composing.size) return '글자 입력을 마친 뒤 적용해 주세요.';
  if (state.sending || state.serverSending || state.pending || state.acknowledging || state.capability.uncertain || state.recoverRequest || state.creation.busy || state.creation.checking || !state.creation.checked || state.creation.message || ['reserved', 'pending', 'uncertain'].includes(state.creation.receipt?.state)) return '전송·새 대화 생성 결과를 먼저 확인해 주세요.';
  if ([...attachments.groups.values()].some(rows => rows.length)) return '첨부가 사라지지 않도록 먼저 보내기를 완료하거나 직접 제거해 주세요.';
  if (state.transferBusy) return '파일 저장·공유 전송을 완료하거나 취소한 뒤 적용해 주세요.';
  if ($('newPrompt').value || $('snippetLabel').value || $('snippetText').value || [...state.questionNodes.values()].some(ui => ui.answer)) return '새 대화·빠른 지시·질문에 작성 중인 입력을 먼저 저장하거나 정리해 주세요.';
  return '';
}
function currentRelease() {
  const value = globalThis.CodexPhoneRelease;
  return validRelease(value) && document.documentElement.dataset.webRevision === value.revision ? value : null;
}
function renderUpdates() {
  const u = state.updates, current = currentRelease(), known = Boolean(current);
  const available = known && u.result && u.result.revision !== current.revision;
  $('webRevision').textContent = known ? `현재 웹 · ${current.revision}` : '현재 웹 버전을 확인할 수 없습니다. 다시 열기 전 초안을 별도로 보관해 주세요.';
  setText($('listUpdates'), available ? '웹 업데이트 있음' : '업데이트');
  setText($('toolUpdates'), available ? '업데이트 있음' : '업데이트');
  $('listMenuToggle').dataset.webUpdate = String(Boolean(available));
  $('listMenuToggle').setAttribute('aria-label', available ? '관리 · 웹 업데이트 있음' : '관리');
  $('chatTools').dataset.webUpdate = String(Boolean(available));
  $('chatTools').setAttribute('aria-label', available ? '대화 도구 · 웹 업데이트 있음' : '대화 도구');
  const manifest = available ? u.result : known ? current : null;
  const signature = JSON.stringify(manifest);
  if ($('releaseNotes').releaseSignature !== signature) {
    $('releaseNotes').releaseSignature = signature; $('releaseNotes').replaceChildren(...(manifest?.notes || []).map(note => node('li', note)));
  }
  const blocked = updateBlock();
  $('updateStatus').textContent = !known ? '문서와 화면 코드의 웹 버전을 확인할 수 없어 적용을 중단했습니다. 초안을 별도로 보관한 뒤 화면을 다시 열어 주세요.' : u.message || (u.flight ? '웹 버전을 확인하고 있습니다…' : u.failed ? '웹 업데이트 확인 불가 · 이전 정보는 유지합니다. 직접 다시 확인할 수 있습니다.' : available ? `다른 웹 버전이 있습니다 · ${u.result.revision}${blocked ? '\n' + blocked : ''}` : u.result ? '현재 웹 버전과 같습니다.' : '웹 버전을 아직 확인하지 못했습니다.');
  $('retryUpdate').disabled = Boolean(u.flight);
  $('applyUpdate').hidden = !available; $('applyUpdate').disabled = Boolean(blocked || u.flight || u.failed || u.applying);
}
function refreshRelease(manual = false) {
  const u = state.updates;
  if (!state.csrf || document.hidden || navigator.onLine === false || state.recovery.suspended) return Promise.resolve();
  if (u.flight) return u.flight;
  if (Date.now() < (manual ? u.manualAt || 0 : u.nextAt)) { renderUpdates(); return Promise.resolve(); }
  u.manualAt = Date.now() + 3000; u.message = ''; const auth = state.authEpoch;
  u.flight = (async () => {
    try {
      const result = await api('/api/release');
      if (u !== state.updates || auth !== state.authEpoch || document.hidden) return;
      if (!validRelease(result)) throw new Error('INVALID_RELEASE');
      u.result = { revision: result.revision, notes: [...result.notes] }; u.failed = false; u.nextAt = Date.now() + 300000;
    } catch (e) {
      if (u !== state.updates || auth !== state.authEpoch) return;
      u.failed = true; u.nextAt = Date.now() + 60000;
    } finally { if (u === state.updates && auth === state.authEpoch) { u.flight = null; renderUpdates(); } }
  })();
  renderUpdates(); return u.flight;
}
function applyWebUpdate() {
  const u = state.updates, current = currentRelease();
  if (!validRelease(current) || !u.result || u.result.revision === current.revision || u.failed || u.flight || u.applying) return;
  u.message = ''; if (updateBlock()) { renderUpdates(); return; }
  syncEditor(); persistDevice(true);
  const saved = new Map(durable.data.drafts);
  if (!state.savedDevice || [...state.drafts].some(([id, text]) => text && saved.get(id) !== text) || state.snippets.length !== durable.data.snippets.length) {
    u.message = '초안을 모두 기기에 저장하지 못해 적용하지 않았습니다. 중요한 초안을 복사하고 저장 공간·초안 보관 한도를 확인해 주세요.'; renderUpdates(); return;
  }
  u.applying = true; u.message = '저장했습니다. 웹 화면을 다시 엽니다.'; renderUpdates(); location.reload();
}
function initConveniences() {
  // Includes dynamic question fields as well as the fixed composer and tool forms.
  document.addEventListener('compositionstart', e => state.composing.add(e.target), true);
  document.addEventListener('compositionend', e => { state.composing.delete(e.target); if (state.tools.pane === 'updates') renderUpdates(); }, true);
  $('latestResponse').onclick = jumpLatestAnswer; $('expandDraft').onclick = openEditor;
  $('closeEditor').onclick = () => closeToolLayer('editorDialog');
  $('editorDialog').addEventListener('cancel', e => { e.preventDefault(); closeToolLayer('editorDialog'); });
  $('expandedDraft').oninput = () => { if (!editorCurrent() || $('expandedDraft').disabled) return; syncEditor(); composerState(); persistDevice(); };
  for (const id of ['draft', 'expandedDraft', 'newPrompt', 'snippetLabel', 'snippetText']) {
    $(id).addEventListener('compositionstart', () => state.composing.add(id));
    $(id).addEventListener('compositionend', () => {
      state.composing.delete(id);
      if (id === 'expandedDraft') { syncEditor(); persistDevice(); if (state.editor?.detached) finishEditor(); else if (state.editor?.closeRequested) closeToolLayer('editorDialog'); }
    });
  }
  $('snippetForm').onsubmit = e => {
    e.preventDefault(); if (!state.csrf || state.loggingOut || state.composing.size) return;
    const label = $('snippetLabel').value.trim(), text = $('snippetText').value.trim(), edit = state.snippetEdit;
    const error = !label || !text ? '이름과 본문을 입력해 주세요.' : label.length > 40 || text.length > 2000 || /[\x00-\x1f\x7f]/.test(label) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? '이름 40자·본문 2,000자와 일반 문자만 사용할 수 있습니다.' :
      state.snippets.some(r => r.id !== edit && (r.label === label || r.text === text)) ? '같은 이름 또는 본문이 이미 있습니다.' : !edit && state.snippets.length >= 12 ? '최대 12개입니다. 기존 지시를 수정하거나 삭제해 주세요.' : '';
    if (error) { $('snippetFeedback').textContent = error; return; }
    if (edit && !state.snippets.some(r => r.id === edit)) { resetSnippetForm(); return; }
    const row = { id: edit || uuid(), label, text };
    if (edit) state.snippets[state.snippets.findIndex(r => r.id === edit)] = row; else state.snippets.push(row);
    resetSnippetForm(); saveSnippets(edit ? '수정했습니다.' : '추가했습니다.');
  };
  $('cancelSnippet').onclick = resetSnippetForm;
  $('listUpdates').onclick = () => openTools('updates');
  $('retryUpdate').onclick = () => refreshRelease(true); $('applyUpdate').onclick = applyWebUpdate;
  renderUpdates(); renderSnippets();
}
