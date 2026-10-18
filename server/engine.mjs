import { join } from 'node:path';
import { BridgeError } from './rpc.mjs';
import { hash, loadJson, saveJson, keys, text, threadId } from './security.mjs';
import { Activity, normalizeStatus, assistantPreview } from './activity.mjs';
import { Media, markdownImages, mediaPlaceholder } from './media.mjs';
import { Questions, questionReplies, questionIdentity } from './questions.mjs';
import { Files } from './files.mjs';
import { Events } from './events.mjs';
import { Usage } from './usage.mjs';
import { TokenUsage } from './token-usage.mjs';
import { Options, choices } from './options.mjs';
import { Uploads } from './uploads.mjs';
import { workTime, newestUpdate, compareWork } from './work-order.mjs';

const clip = (s, max = 64000) => typeof s === 'string' ? s.slice(0, max) : '';
export function summary(t) {
  return { id: t.id, title: t.title ?? t.name ?? t.preview ?? '제목 없는 대화',
    cwd: clip(t.cwd, 1000), modelProvider: clip(t.modelProvider, 100), model: clip(t.model, 100),
    source: typeof t.source === 'string' ? t.source : 'desktop',
    updatedAt: workTime(t.updatedAt) === null ? null : t.updatedAt, status: normalizeStatus(t.status), isUnread: t.isUnread === true,
    retrievalSummary: clip(t.summary, 500) };
}
function userText(value) {
  const replies = questionReplies(value);
  return clip(replies.length ? replies.map(r => `질문 답변\n${r.question}\n${r.answer}`).join('\n\n') : value);
}
function delegatedRequest(i, base, controllerId, cleanRequest) {
  // Whitelist native metadata before touching output; never inspect other tools or reasoning.
  if (i.type !== 'functionCallOutput' || i.namespace !== 'codex_app' || i.name !== 'send_message_to_thread' ||
      typeof controllerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(controllerId)) return null;
  const notice = text => ({ ...base, type: 'requestNotice', text, requestState: 'unavailable' });
  const output = i.output;
  if (output == null) return notice('요청 전달 기록의 원문을 제공받지 못했습니다. 전체 요청은 PC에서 확인해 주세요.');
  if (typeof output !== 'object' || Array.isArray(output) || typeof output.text !== 'string') return null;
  const value = output.text;
  const header = /^\s*<codex_delegation>\s*<source_thread_id>([A-Za-z0-9_-]{1,100})<\/source_thread_id>\s*<input>/.exec(value.slice(0, 1500));
  if (!header || header[1] !== controllerId) return null;
  if (value.length > 1500 || output.truncated === true)
    return notice('요청 전달 기록의 원문이 조회 한도에서 잘려 전체 내용을 표시할 수 없습니다. 전체 요청은 PC에서 확인해 주세요.');
  if (output.truncated !== false) return notice('요청 전달 기록의 원문이 완전한지 확인할 수 없습니다. 전체 요청은 PC에서 확인해 주세요.');
  // Anchor the entire frame. Greedy inner text preserves literal XML/code, including closing tags.
  const framed = /^([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/.exec(value.slice(header[0].length));
  if (!framed) return null;
  const request = framed[1];
  return { ...base, type: 'userMessage', text: userText(cleanRequest(request)), requestState: 'complete' };
}
export function item(i, index = 0, resolveImage = () => mediaPlaceholder(), resolveFile = () => null, controllerId = null, cleanRequest = value => value) {
  if (!i || i.type === 'reasoning') return null; // Never inspect hidden reasoning fields.
  const base = { id: i.id ?? `item-${index}`, type: i.type };
  const request = delegatedRequest(i, base, controllerId, cleanRequest);
  if (request) return request;
  if (i.type === 'imageView') {
    const file = resolveFile(i.path, 'Codex가 확인한 이미지');
    return { ...base, media: resolveImage(i.path, 'Codex가 확인한 이미지'), ...(file ? { files: [{ file }] } : {}) };
  }
  if (i.type === 'userMessage') {
    const content = Array.isArray(i.content) ? i.content : [];
    const value = content.map(c => c.type === 'text' ? c.text : '[이미지 또는 첨부]').join('\n');
    return { ...base, text: userText(value),
      images: content.filter(c => ['localImage', 'image'].includes(c.type)).slice(0, 64)
        .map(c => c.type === 'localImage' ? resolveImage(c.path, '첨부한 이미지') : mediaPlaceholder('MEDIA_SOURCE_UNSUPPORTED', '첨부 이미지 · 로컬 경로 없음')) };
  }
  if (['agentMessage', 'plan'].includes(i.type)) {
    const value = clip(i.text);
    return { ...base, text: value, images: markdownImages(value).map(({ start, end, alt, path }) => ({ start, end, media: resolveImage(path, alt) })),
      ...(i.type === 'agentMessage' ? { files: markdownImages(value, true).map(({ start, end, alt, path }) => ({ start, end, file: resolveFile(path, alt) })).filter(r => r.file) } : {}) };
  }
  if (i.type === 'commandExecution') return { ...base, text: clip(i.command),
    detail: clip(i.aggregatedOutput), status: i.status, exitCode: i.exitCode };
  if (i.type === 'fileChange') return { ...base, text: clip((i.changes ?? []).map(c => c.path).join('\n')),
    detail: clip((i.changes ?? []).map(c => `${c.path}\n${c.diff ?? ''}`).join('\n')), status: i.status };
  return { ...base, text: ['mcpToolCall', 'webSearch', 'review'].includes(i.type) ? clip(i.tool ?? i.query ?? i.review, 1500) : '', status: i.status };
}
export function turn(t, resolveImage, resolveFile, controllerId = null, cleanRequest = value => value) {
  return { id: t.id, status: t.status, startedAt: t.startedAt ?? null,
    items: (t.items ?? []).map((i, n) => item(i, n, resolveImage, resolveFile, controllerId, cleanRequest)).filter(Boolean), error: t.error ? 'CODEX_TURN_FAILED' : null };
}
const localCodex = t => t?.kind === 'codex' && t.hostId === 'local';
// Requests are forwarded verbatim. The operator's Codex instructions govern their workflow.

export class Engine {
  constructor(desktop, dir, { historyRpcFactory = null, now = Date.now } = {}) {
    this.desktop = desktop; this.historyRpcFactory = historyRpcFactory; this.historyRpc = null;
    this.now = now; this.readChecks = new Map(); this.accountGeneration = 0;
    this.journalPath = join(dir, 'requests.json'); this.records = loadJson(this.journalPath, []);
    for (const r of this.records) if (['reserved', 'active'].includes(r.state)) r.state = 'uncertain';
    this.prune(); this.persist(); this.sending = new Set(); this.recent = null;
    this.activity = new Activity(this); this.media = new Media({ now, privateRoot: dir, ownedUpload: (session, raw) => this.uploads.mediaSource(session, raw) }); this.readModes = new Map();
    this.questions = new Questions({ now }); this.questionTurns = new Map();
    this.files = new Files({ now, privateRoot: dir }); this.events = new Events(this);
    this.resetUsage();
    this.options = new Options(desktop, { now: () => this.now() }); this.creating = new Set();
    this.creationReads = new Map(); this.creationReadAt = new Map();
    this.uploads = new Uploads(dir, () => this.records, { now: () => this.now() });
  }
  persist() { saveJson(this.journalPath, this.records); }
  prune() {
    const cutoff = this.now() - 7 * 86400000;
    this.records = this.records.filter(r => {
      const at = r.acknowledgedAt ?? r.finishedAt ?? r.createdAt;
      return !['delivered', 'rejected', 'acknowledged'].includes(r.state) || !Number.isFinite(at) || at >= cutoff;
    });
  }
  capability() {
    const tools = this.desktop.catalog ?? [];
    return { online: Boolean(this.desktop.socket && !this.desktop.socket.destroyed),
      continuationEnabled: tools.some(t => t.name === 'send_message_to_thread' && t.namespace === 'codex_app'),
      ownership: 'desktop-owner', approvalsOnPc: true, interruptSupported: false };
  }
  accountReadGuard() {
    const generation = this.accountGeneration;
    return () => {
      if (this.accountPaused) throw new BridgeError('ACCOUNT_BUSY', 409);
      if (generation !== this.accountGeneration) throw new BridgeError('ACCOUNT_CHANGED', 409);
    };
  }
  async stored() {
    const authorize = this.accountReadGuard(); authorize();
    if (!this.historyRpcFactory) return null;
    if (this.historyRpc?.closed) { this.historyRpc.close(); this.historyRpc = null; }
    if (!this.historyRpc) {
      if (!this.historyStarting) {
        const flight = this.historyRpcFactory().then(rpc => {
          this.historyRpc = rpc; authorize(); return rpc;
        }).finally(() => { if (this.historyStarting === flight) this.historyStarting = null; });
        this.historyStarting = flight;
      }
      return this.historyStarting;
    }
    return this.historyRpc;
  }
  resetUsage() {
    this.usage = new Usage(this.desktop, { now: () => this.now() });
    this.tokenUsage = new TokenUsage(async () => {
      const authorize = this.accountReadGuard(); authorize();
      const rpc = await this.stored(); authorize();
      if (!rpc) throw new BridgeError('TOKEN_USAGE_UNSUPPORTED');
      try { const data = await rpc.request('account/usage/read'); authorize(); return data; }
      catch (error) { authorize(); throw error; }
    }, { now: () => this.now() });
  }
  async usageSnapshot() {
    const authorize = this.accountReadGuard(); authorize();
    const [quota, tokenActivity] = await Promise.all([this.usage.snapshot(), this.tokenUsage.snapshot()]);
    authorize(); return { ...quota, tokenActivity };
  }
  recentThreads() {
    const authorize = this.accountReadGuard(); authorize();
    if (this.recentPending) return this.recentPending;
    if (this.recent && this.now() - this.recent.at < 4000) return Promise.resolve(this.recent.rows);
    const flight = (async () => {
      const r = await this.desktop.call('list_threads', { limit: 50 }); authorize();
      if (!Array.isArray(r.threads) || !Array.isArray(r.pinnedThreads)) throw new BridgeError('DESKTOP_RESPONSE_INVALID', 502);
      const merged = new Map();
      for (const row of [...r.pinnedThreads, ...r.threads].filter(localCodex)) {
        const previous = merged.get(row.id);
        merged.set(row.id, { ...previous, ...row, updatedAt: newestUpdate(previous?.updatedAt, row.updatedAt) });
      }
      const rows = [...merged.values()].sort(compareWork);
      this.desktopSuccessAt = this.now(); this.recent = { at: this.desktopSuccessAt, rows }; return rows;
    })().finally(() => { if (this.recentPending === flight) this.recentPending = null; });
    this.recentPending = flight; return flight;
  }
  async list({ cursor, search } = {}) {
    const authorize = this.accountReadGuard(); authorize();
    if (cursor) text(cursor, 4096); if (search) text(search, 200);
    let live = [], liveError = null;
    try { live = await this.recentThreads(); } catch (e) { liveError = e.code ?? 'DESKTOP_NOT_AVAILABLE'; }
    authorize();
    let rpc;
    try { rpc = await this.stored(); } catch { /* Desktop-only fallback is explicitly labelled. */ }
    authorize();
    if (rpc) {
      const r = await rpc.request('thread/list', { limit: 30, sortKey: 'updated_at', sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true,
        ...(cursor ? { cursor } : {}), ...(search ? { searchTerm: search } : {}) });
      authorize();
      const recent = new Map(live.map(t => [t.id, t]));
      return { data: r.data.map(t => summary(recent.has(t.id) ? { ...t, ...recent.get(t.id), updatedAt: newestUpdate(t.updatedAt, recent.get(t.id).updatedAt) } : t)).sort(compareWork),
        nextCursor: r.nextCursor ?? null, scope: 'all-stored', warning: liveError,
        searchScope: '전체 저장 대화 제목 · Codex 제목 검색 기준' };
    }
    if (liveError) throw new BridgeError(liveError);
    if (cursor) throw new BridgeError('HISTORY_PAGINATION_UNAVAILABLE', 409);
    return { data: live.filter(t => !search || t.title?.includes(search)).map(summary), nextCursor: null,
      scope: 'recent-desktop', warning: '최근 50개와 고정 대화만 표시합니다. 전체 기록 조회 연결이 필요합니다.',
      searchScope: '최근 50개와 고정 대화 제목만 검색' };
  }
  async desktopRead(id, cursor, turnLimit = 1, includeOutputs = true) {
    const authorize = this.accountReadGuard(); authorize();
    threadId(id);
    if (cursor) text(cursor, 4096);
    const cached = this.readModes.get(id), mode = cached?.expires > this.now() ? cached : null;
    turnLimit = Math.min(turnLimit, mode?.turnLimit ?? turnLimit);
    includeOutputs = includeOutputs && !mode?.omitOutputs;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.desktop.call('read_thread', { threadId: id, hostId: 'local', turnLimit,
          includeOutputs, maxOutputCharsPerItem: 1500, ...(cursor ? { cursor } : {}) });
        authorize();
        if (r.thread?.id !== id) throw new BridgeError('THREAD_ID_MISMATCH', 409);
        if (!localCodex(r.thread)) throw new BridgeError('LOCAL_CODEX_THREAD_REQUIRED', 403);
        if (!Array.isArray(r.turns)) throw new BridgeError('DESKTOP_RESPONSE_INVALID', 502);
        this.desktopSuccessAt = this.now();
        return { ...r, readOptions: { outputLimit: includeOutputs ? 1500 : 0, outputsOmitted: !includeOutputs } };
      } catch (e) {
        authorize();
        if (e.code !== 'HISTORY_SIZE_LIMIT') throw e;
        if (turnLimit > 1) turnLimit = 1;
        else if (includeOutputs) includeOutputs = false;
        else throw e;
        this.readModes.delete(id); this.readModes.set(id, { turnLimit, omitOutputs: !includeOutputs, expires: this.now() + 30 * 60000 });
        while (this.readModes.size > 64) this.readModes.delete(this.readModes.keys().next().value);
      }
    }
    throw new BridgeError('HISTORY_SIZE_LIMIT', 502);
  }
  diagnostics() {
    const authorize = this.accountReadGuard(); authorize();
    if (this.diagnosticFlight) return this.diagnosticFlight;
    if (this.diagnosticResult && this.now() - this.diagnosticResult.checkedAt < 8000) return Promise.resolve(this.diagnosticResult);
    const flight = (async () => {
      let desktop = 'unavailable', readonly = 'unavailable';
      await Promise.all([
        this.recentThreads().then(() => { desktop = 'available'; }).catch(() => {}),
        (async () => {
          const rpc = await this.stored(); authorize();
          if (!rpc) { readonly = 'unsupported'; return; }
          const result = await rpc.request('thread/list', { limit: 1, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true });
          authorize();
          if (Array.isArray(result?.data)) { readonly = 'available'; this.readonlySuccessAt = this.now(); }
        })().catch(() => {})
      ]);
      authorize();
      return this.diagnosticResult = { checkedAt: this.now(), bridge: 'available', desktop, readonly,
        desktopSuccessAt: this.desktopSuccessAt ?? null, readonlySuccessAt: this.readonlySuccessAt ?? null };
    })().finally(() => { if (this.diagnosticFlight === flight) this.diagnosticFlight = null; });
    this.diagnosticFlight = flight; return flight;
  }
  async read(id, session) {
    const r = await this.desktopRead(id, undefined, 1, false);
    return { thread: summary(r.thread), capability: this.capability(),
      sending: this.sending.has(id), uncertain: this.records.some(r => r.threadId === id && r.state === 'uncertain'),
      uncertainRequest: this.records.find(r => r.threadId === id && r.state === 'uncertain' && r.owner === session?.id)?.requestId ?? null };
  }
  cleanUploadRequest(session, id, value) {
    const r = this.records.find(r => r.owner === session?.id && r.threadId === id &&
      ['delivered', 'pending', 'uncertain', 'acknowledged'].includes(r.state) && r.attachments?.length && r.uploadPromptHash === hash(value));
    if (!r) return value;
    const start = value.lastIndexOf('\n\n[휴대폰에서 전송한 파일 ·');
    if (start < 0) return value;
    const message = value.slice(0, start);
    try {
      const selected = this.uploads.select(session, r.attachments);
      if (this.uploads.prompt(session, message, selected) !== value) return value;
      return `${message}\n\n첨부 ${selected.length}개 · PC에 전송한 파일`;
    } catch { return value; } // Missing/changed metadata never justifies inferring a shortened request.
  }
  async history(id, cursor, session) {
    const authorize = this.accountReadGuard(); authorize();
    const observedAt = this.now();
    const r = await this.desktopRead(id, cursor); authorize();
    if (session && !cursor) {
      // Acknowledgement requires this session to have fetched actual current history recently.
      const key = `${session.id}/${id}`;
      this.readChecks.delete(key);
      this.readChecks.set(key, this.now());
      while (this.readChecks.size > 128) this.readChecks.delete(this.readChecks.keys().next().value);
      this.questionTurns.delete(id); this.questionTurns.set(id, { id: r.turns[0]?.id, status: r.turns[0]?.status });
      while (this.questionTurns.size > 64) this.questionTurns.delete(this.questionTurns.keys().next().value);
    }
    let imageCount = 0, fileCount = 0;
    const resolveImage = (path, alt) => ++imageCount <= 64 ? this.media.register(session, id, path, alt) : mediaPlaceholder('MEDIA_LIMIT', alt);
    const resolveFile = (path, alt) => ++fileCount <= 64 ? this.files.register(session, id, path, alt) : null;
    return { data: r.turns.map(t => turn(t, resolveImage, resolveFile, this.desktop.controllerId, value => this.cleanUploadRequest(session, id, value))), nextCursor: r.page?.nextCursor ?? null,
      status: normalizeStatus(r.thread.status), order: 'newest_first', ...r.readOptions,
      ...(cursor ? {} : { preview: assistantPreview(r.turns, observedAt), previewCheckedAt: observedAt }) };
  }
  async questionState(id, session, { fresh = false } = {}) {
    const authorize = this.accountReadGuard(); authorize();
    threadId(id);
    const at = this.readChecks.get(`${session.id}/${id}`);
    if (at === undefined || this.now() - at > 30000) return { state: 'unavailable', data: [] };
    const result = await this.questions.get(id, async () => {
      authorize(); const rpc = await this.stored(); authorize(); if (!rpc) return null;
      return rpc.request('thread/read', { threadId: id, includeTurns: false });
    }, this.questionTurns.get(id), { fresh });
    authorize();
    if (result.state !== 'ready') return result;
    return { ...result, data: result.data.map(q => {
      const key = hash(JSON.stringify([q.id, q.sourceKey]));
      const rows = this.records.filter(r => r.owner === session.id && r.threadId === id && r.questionKey === key);
      const receipt = rows.find(r => r.state === 'delivered') ?? rows.find(r => ['reserved', 'uncertain', 'acknowledged'].includes(r.state)) ?? rows.at(-1);
      return { ...q, ...(receipt ? { messageState: receipt.state } : {}) };
    }) };
  }
  receipt(session, requestId) {
    const r = this.records.find(r => r.requestId === requestId && r.owner === session.id);
    if (!r) throw new BridgeError('REQUEST_NOT_FOUND', 404);
    return { requestId: r.requestId, threadId: r.threadId ?? null, state: r.state, error: r.error ?? null,
      acknowledgedAt: r.acknowledgedAt ?? null, ...(r.kind === 'create' ? { kind: 'create', verification: r.candidateId ? 'candidate' : r.state === 'delivered' ? 'verified' : 'unresolved' } : {}) };
  }
  async inspectReceipt(session, requestId, authorize = () => {}) {
    authorize(); this.receipt(session, requestId);
    const r = this.records.find(r => r.requestId === requestId && r.owner === session.id);
    if (r.kind === 'create' && r.candidateId && ['pending', 'uncertain'].includes(r.state) && !this.creating.has(session.id)) {
      let flight = this.creationReads.get(requestId);
      if (!flight && this.now() - (this.creationReadAt.get(requestId) ?? -Infinity) >= 5000) {
        this.creationReadAt.set(requestId, this.now());
        while (this.creationReadAt.size > 1000) this.creationReadAt.delete(this.creationReadAt.keys().next().value);
        flight = (async () => {
          try {
            await this.desktopRead(threadId(r.candidateId), undefined, 1, false);
            authorize();
            if (['pending', 'uncertain'].includes(r.state)) { r.threadId = r.candidateId; delete r.candidateId; r.state = 'delivered'; r.error = null; r.finishedAt = this.now(); this.recent = null; this.persist(); }
          } catch (e) {
            if (['THREAD_ID_MISMATCH', 'LOCAL_CODEX_THREAD_REQUIRED', 'INVALID_THREAD_ID'].includes(e.code)) { delete r.candidateId; this.persist(); }
          }
        })().finally(() => this.creationReads.delete(requestId));
        this.creationReads.set(requestId, flight);
      }
      if (flight) await flight;
    }
    authorize(); return this.receipt(session, requestId);
  }
  acknowledge(session, requestId, input) {
    keys(input, ['threadId', 'confirmed']);
    const id = threadId(input.threadId);
    const r = this.records.find(r => r.kind !== 'create' && r.requestId === requestId && r.owner === session.id && r.threadId === id);
    if (!r) throw new BridgeError('REQUEST_NOT_FOUND', 404);
    if (input.confirmed !== true) throw new BridgeError('CONFIRMATION_REQUIRED', 400);
    if (r.state === 'acknowledged') return this.receipt(session, requestId);
    if (r.state !== 'uncertain' || this.sending.has(id)) throw new BridgeError('REQUEST_NOT_UNCERTAIN', 409);
    const readAt = this.readChecks.get(`${session.id}/${id}`);
    if (readAt === undefined || readAt < (r.uncertainAt ?? r.createdAt) || this.now() - readAt > 5 * 60000)
      throw new BridgeError('READ_CURRENT_THREAD_FIRST', 409);
    r.state = 'acknowledged'; r.acknowledgedAt = this.now(); r.acknowledgedAfterReadAt = readAt;
    this.persist();
    return this.receipt(session, requestId); // Guard only: no tool call, send, retry or history mutation.
  }
  creationState(session) {
    const row = this.records.find(r => r.kind === 'create' && r.owner === session.id && ['reserved', 'pending', 'uncertain'].includes(r.state));
    return { request: row ? this.receipt(session, row.requestId) : null };
  }
  acknowledgeCreation(session, requestId, input) {
    keys(input, ['confirmed']);
    const r = this.records.find(r => r.kind === 'create' && r.requestId === requestId && r.owner === session.id);
    if (!r) throw new BridgeError('REQUEST_NOT_FOUND', 404);
    if (input.confirmed !== true) throw new BridgeError('CONFIRMATION_REQUIRED', 400);
    if (r.state === 'acknowledged') return this.receipt(session, requestId);
    if (!['pending', 'uncertain'].includes(r.state) || this.creating.has(session.id)) throw new BridgeError('REQUEST_NOT_UNCERTAIN', 409);
    r.state = 'acknowledged'; r.acknowledgedAt = this.now(); this.persist();
    return this.receipt(session, requestId); // Explicit PC check only. Never search/guess an ID, retry or create.
  }
  async create(session, input, authorize = () => {}) {
    keys(input, ['requestId', 'text', 'target', 'model', 'thinking', 'attachments']);
    const message = text(input.text, 16000), selection = choices(input), target = input.target;
    const attachments = this.uploads.select(session, input.attachments), attached = attachments.length ? { attachments } : {};
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new BridgeError('INVALID_TARGET', 400);
    if (target.type === 'projectless') keys(target, ['type']);
    else if (target.type === 'project') {
      keys(target, ['type', 'projectId']);
      if (typeof target.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(target.projectId)) throw new BridgeError('INVALID_TARGET', 400);
    } else throw new BridgeError('INVALID_TARGET', 400);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId ?? '')) throw new BridgeError('INVALID_REQUEST_ID', 400);
    const localTarget = target.type === 'projectless' ? { type: 'projectless' } : { type: 'project', projectId: target.projectId, environment: { type: 'local' } };
    const payload = hash(JSON.stringify({ kind: 'create', message, target: localTarget, ...selection, ...attached }));
    const old = this.records.find(r => r.requestId === input.requestId);
    if (old) {
      if (old.kind !== 'create' || old.owner !== session.id || old.payload !== payload) throw new BridgeError('REQUEST_ID_CONFLICT', 409);
      return this.receipt(session, input.requestId);
    }
    if (this.creating.has(session.id)) throw new BridgeError('CREATE_IN_PROGRESS', 409);
    if (this.creationState(session).request) throw new BridgeError('PREVIOUS_CREATE_UNCERTAIN', 409);
    this.prune();
    if (this.records.length >= 1000) throw new BridgeError('REQUEST_JOURNAL_FULL', 409);
    const r = { kind: 'create', requestId: input.requestId, owner: session.id, payload, ...attached, state: 'reserved', createdAt: this.now() };
    this.creating.add(session.id); let dispatched = false;
    try {
      this.records.push(r); this.persist();
      await this.options.validate('create', selection, localTarget); authorize();
      const prompt = this.uploads.prompt(session, message, attachments); authorize();
      if (attachments.length) { r.uploadPromptHash = hash(prompt); this.persist(); }
      dispatched = true;
      const result = await this.desktop.call('create_thread', { prompt, target: localTarget, ...selection }, input.requestId, authorize);
      const status = typeof result?.status === 'string' ? result.status : result?.status?.type;
      if (!result || typeof result !== 'object' || Array.isArray(result) || result.success === false || result.isError === true || result.error != null ||
          ['failed', 'failure', 'error', 'rejected', 'cancelled', 'canceled', 'aborted'].includes(typeof status === 'string' ? status.trim().toLowerCase() : null)) throw new BridgeError('CREATE_RESULT_UNCONFIRMED', 409);
      if (result.threadId != null) {
        if (result.hostId !== 'local') throw new BridgeError('CREATE_RESULT_UNCONFIRMED', 409);
        const id = threadId(result.threadId);
        // Advertised IDs, not an assumed status enum, determine readiness; verify even when a client ID coexists.
        r.candidateId = id; this.persist();
        try { await this.desktopRead(id, undefined, 1, false); }
        catch (e) { if (['THREAD_ID_MISMATCH', 'LOCAL_CODEX_THREAD_REQUIRED'].includes(e.code)) delete r.candidateId; throw e; }
        r.threadId = id; delete r.candidateId; r.state = 'delivered';
      } else if ((result.hostId == null || result.hostId === 'local') && typeof result.clientThreadId === 'string' &&
          result.clientThreadId.trim() && result.clientThreadId.length <= 256 && !/[\x00-\x1f\x7f]/.test(result.clientThreadId)) {
        r.state = 'pending'; // Setup was observed, not completion. Never persist or read/send to the client ID.
      } else throw new BridgeError('CREATE_RESULT_UNCONFIRMED', 409);
      r.finishedAt = this.now(); this.recent = null; this.persist(); return this.receipt(session, input.requestId);
    } catch (e) {
      r.state = dispatched ? 'uncertain' : 'rejected';
      if (dispatched) r.uncertainAt = this.now(); else r.finishedAt = this.now();
      r.error = e instanceof BridgeError ? e.code : 'CREATE_FAILED'; this.persist();
      throw new BridgeError(dispatched ? 'CREATE_UNCERTAIN' : r.error, dispatched ? 409 : (e.status ?? 503));
    } finally { this.creating.delete(session.id); }
  }
  async send(session, input, authorize = () => {}) {
    keys(input, ['threadId', 'requestId', 'text', 'model', 'thinking', 'attachments', 'question']);
    const id = threadId(input.threadId), message = text(input.text, 16000), selection = choices(input);
    let question;
    if (Object.hasOwn(input, 'question')) {
      if (!input.question || typeof input.question !== 'object' || Array.isArray(input.question)) throw new BridgeError('INVALID_QUESTION', 400);
      keys(input.question, ['id', 'sourceKey']);
      if (!questionIdentity(input.question.id) || typeof input.question.sourceKey !== 'string' || !/^[0-9a-f]{64}$/.test(input.question.sourceKey) || input.attachments?.length)
        throw new BridgeError('INVALID_QUESTION', 400);
      question = { id: input.question.id, sourceKey: input.question.sourceKey };
    }
    const association = question ? { questionKey: hash(JSON.stringify([question.id, question.sourceKey])) } : {};
    const attachments = this.uploads.select(session, input.attachments), attached = attachments.length ? { attachments } : {};
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId ?? ''))
      throw new BridgeError('INVALID_REQUEST_ID', 400);
    // Keep the legacy default hash byte-for-byte; explicit choices become part of the identity.
    const payload = hash(JSON.stringify({ id, message, ...selection, ...attached, ...(question ? { question } : {}) }));
    const old = this.records.find(r => r.requestId === input.requestId);
    if (old) {
      if (old.kind === 'create' || old.owner !== session.id || old.payload !== payload) throw new BridgeError('REQUEST_ID_CONFLICT', 409);
      return this.receipt(session, input.requestId);
    }
    if (this.sending.has(id)) throw new BridgeError('SEND_IN_PROGRESS', 409);
    if (this.records.some(r => r.threadId === id && r.state === 'uncertain')) throw new BridgeError('PREVIOUS_SEND_UNCERTAIN', 409);
    this.prune();
    if (this.records.length >= 1000) throw new BridgeError('REQUEST_JOURNAL_FULL', 409);
    this.sending.add(id);
    const r = { requestId: input.requestId, threadId: id, owner: session.id, payload, ...attached, state: 'reserved', createdAt: this.now() };
    let dispatched = false;
    try {
      this.records.push(r); this.persist();
      const before = await this.desktopRead(id, undefined, 1, false);
      if (!this.capability().continuationEnabled) throw new BridgeError('DESKTOP_TOOL_UNSUPPORTED', 409);
      r.previousStatus = before.thread.status?.type ?? 'unknown';
      if (selection.model) await this.options.validate('send', selection);
      if (question) {
        // A task ending does not answer an async question. Revalidate the owned source, never titles or a guessed turn.
        const result = await this.questionState(id, session, { fresh: true });
        const source = result.state === 'ready' && result.data.find(q => q.id === question.id && q.sourceKey === question.sourceKey && ['unconfirmed', 'historical'].includes(q.state));
        if (!source || !message.startsWith(`질문: ${source.title}\n답변: `) || !message.slice(`질문: ${source.title}\n답변: `.length).trim())
          throw new BridgeError('QUESTION_SOURCE_CHANGED', 409);
        const prior = this.records.find(row => row !== r && row.owner === session.id && row.threadId === id && row.questionKey === association.questionKey && ['delivered', 'reserved', 'uncertain', 'acknowledged'].includes(row.state));
        if (prior) throw new BridgeError(prior.state === 'delivered' ? 'QUESTION_MESSAGE_DELIVERED' : 'QUESTION_MESSAGE_UNCONFIRMED', 409);
        // Persist an association only after validating the exact owned source, never client assertions alone.
        r.questionKey = association.questionKey; this.persist();
      }
      authorize();
      // Same desktop owner, never a second writer. Optional choices require explicit phone selection.
      const prompt = this.uploads.prompt(session, message, attachments); authorize();
      if (attachments.length) { r.uploadPromptHash = hash(prompt); this.persist(); }
      dispatched = true;
      await this.desktop.call('send_message_to_thread', { threadId: id, hostId: 'local',
        prompt, ...selection }, input.requestId, authorize);
      r.state = 'delivered'; r.finishedAt = this.now(); this.recent = null; this.persist();
      return this.receipt(session, input.requestId);
    } catch (e) {
      r.state = dispatched ? 'uncertain' : 'rejected';
      if (dispatched) r.uncertainAt = this.now(); else r.finishedAt = this.now();
      r.error = e instanceof BridgeError ? e.code : 'SEND_FAILED';
      this.persist();
      throw new BridgeError(dispatched ? 'SEND_UNCERTAIN' : r.error, dispatched ? 409 : (e.status ?? 503));
    } finally { this.sending.delete(id); }
  }
  async pauseAccounts() {
    this.accountPaused = true; this.accountGeneration++; this.resetUsage();
    if (this.historyStarting) { try { await this.historyStarting; } catch { /* Inspect any child assigned before the gate closed. */ } }
    const rpc = this.historyRpc;
    try {
      if (rpc?.stop) await rpc.stop(); else rpc?.close();
      if (this.historyRpc === rpc) this.historyRpc = null;
    } finally { await this.desktop.reset?.(); }
  }
  resumeAccounts() {
    this.recent = null; this.recentPending = null; this.diagnosticFlight = null; this.diagnosticResult = null;
    this.desktopSuccessAt = null; this.readonlySuccessAt = null; this.readChecks.clear(); this.readModes.clear(); this.questionTurns.clear();
    this.activity = new Activity(this); this.questions = new Questions({ now: () => this.now() }); this.events = new Events(this);
    this.resetUsage(); this.options = new Options(this.desktop, { now: () => this.now() });
    this.accountPaused = false;
  }
  close() { this.desktop.close(); this.historyRpc?.close(); }
}
