import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';

// Complete-file scan threshold; larger owned sources use a separate bounded recent window.
export const QUESTION_FILE_LIMIT = 32 * 1024 * 1024;
export const QUESTION_LINE_LIMIT = 512 * 1024;
const SCAN_BUDGET = 4 * 1024 * 1024;
export const QUESTION_RECENT_LIMIT = 8 * 1024 * 1024;
const lineFail = () => { throw new Error('QUESTION_LINE_TOO_LARGE'); };
function parseLine(bytes) {
  if (bytes.length > QUESTION_LINE_LIMIT) lineFail();
  const line = bytes.toString('utf8');
  if (!line.trim()) return null;
  const header = /^\s*\{\s*"timestamp"\s*:\s*"[^"\n]{1,80}"\s*,\s*(?:"ordinal"\s*:\s*(?:0|[1-9]\d*)\s*,\s*)?"type"\s*:\s*"([a-z_]{1,40})"\s*,\s*"payload"\s*:\s*\{/.exec(line);
  if (!header) fail();
  if (!['session_meta', 'turn_context', 'event_msg', 'response_item'].includes(header[1])) return null;
  // Exclude opaque reasoning before parsing its body, including in the recent window.
  if (/^\s*"type"\s*:\s*"reasoning"(?:\s*,|\s*\})/.test(line.slice(header[0].length))) return null;
  try { return JSON.parse(line); } catch { fail(); }
}
function snapshot(entry, latest) {
  const result = entry.complete ? entry.parser.result(latest) : { state: 'loading', data: [] };
  return entry.recent ? { ...result, coverage: 'recent', reason: entry.complete ? 'recent-window' : 'scan-in-progress' } : result;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const callId = /^[A-Za-z0-9_-]{1,160}$/;
const clean = (s, max) => typeof s === 'string' ? s.replace(/[\x00-\x08\x0b-\x1f\x7f‪-‮⁦-⁩]/g, '').trim().slice(0, max) : '';
const unavailable = () => ({ state: 'unavailable', data: [] });
const samePath = (a, b, paths) => paths.sep === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join('/');
const objectId = s => `${s.dev}/${s.ino}`;
const fail = () => { throw new Error('QUESTION_SOURCE_UNAVAILABLE'); };

export function questionIdentity(value) {
  if (typeof value !== 'string' || value.length > 210) return false;
  try {
    const id = JSON.parse(value);
    return Array.isArray(id) && id.length === 3 && id[0] === 'request_user_input_async' && typeof id[1] === 'string' && callId.test(id[1]) && Number.isInteger(id[2]) && id[2] >= 0 && id[2] < 8 && JSON.stringify(id) === value;
  } catch { return false; }
}

// Only a complete, ordinary user message with this exact envelope is a native reply.
export function questionReplies(value) {
  if (typeof value !== 'string' || value.length > 32000) return [];
  const match = /^<send_user_message_question_reply>\r?\n([\s\S]+)\r?\n<\/send_user_message_question_reply>$/.exec(value.trim());
  if (!match) return [];
  let rows; try { rows = JSON.parse(match[1]); } catch { return []; }
  if (!Array.isArray(rows) || rows.length > 8) return [];
  return rows.every(r => {
    if (!r || Object.keys(r).sort().join(',') !== 'answer,question,questionItemId' || typeof r.question !== 'string' || r.question.length > 1000 || typeof r.answer !== 'string' || !r.answer.trim() || r.answer.length > 4000) return false;
    return questionIdentity(r.questionItemId);
  }) ? rows : [];
}
export function questionParser(id) {
  const questions = new Map(), replies = new Map(), ended = new Set(); let current = null, verified = false;
  return {
    // Called only for structural event/response records. Never access reasoning content/tool outputs.
    record(record) {
      if (!record || !['session_meta', 'turn_context', 'event_msg', 'response_item'].includes(record.type)) return;
      const p = record.payload; if (!p || typeof p !== 'object') return;
      if (record.type === 'session_meta') { if (p.id !== id) fail(); verified = true; return; }
      if (record.type === 'turn_context') { current = uuid.test(p.turn_id) ? p.turn_id : null; return; }
      if (record.type === 'event_msg') {
        if (p.type === 'task_started') current = uuid.test(p.turn_id) ? p.turn_id : null;
        if (['task_complete', 'turn_aborted'].includes(p.type) && uuid.test(p.turn_id)) { ended.add(p.turn_id); if (ended.size > 128) ended.delete(ended.values().next().value); if (current === p.turn_id) current = null; }
        return;
      }
      if (p.type === 'reasoning') return;
      if (p.type === 'function_call' && ['request_user_input_async', 'request_user_input'].includes(p.name) && typeof p.call_id === 'string' && callId.test(p.call_id)) {
        if (p.name === 'request_user_input') {
          const key = JSON.stringify([p.name, p.call_id, 0]);
          questions.set(key, { id: key, title: 'PC에서 질문 확인', options: [], turnId: current, pcOnly: true });
        } else {
          if (typeof p.arguments !== 'string' || p.arguments.length > 64000) fail();
          let args; try { args = JSON.parse(p.arguments); } catch { fail(); }
          if (!Array.isArray(args?.questions) || args.questions.length > 8) fail();
          args.questions.forEach((q, index) => {
            const options = q && Object.hasOwn(q, 'options') ? q.options : [];
            if (!q || typeof q.title !== 'string' || !q.title.trim() || q.title.length > 1000 || !Array.isArray(options) || options.length > 8 || options.some(o => typeof o !== 'string' || o.length > 500)) fail();
            const key = JSON.stringify([p.name, p.call_id, index]); if (questions.has(key)) return;
            const answer = replies.get(key);
            // Async questions send ordinary messages; incidental words cannot turn them into approval APIs.
            questions.set(key, { id: key, rawTitle: q.title, title: clean(q.title, 400), options: options.map(o => clean(o, 500)).filter(Boolean), turnId: current,
              sourceKey: createHash('sha256').update(JSON.stringify([key, q.title, options])).digest('hex'),
              ...(answer?.question === q.title ? { answer: clean(answer.answer, 4000) } : {}) });
          });
        }
        while (questions.size > 64) questions.delete(questions.keys().next().value);
      } else if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
        // Do not inspect other message roles, reasoning, world_state or function output.
        if (p.content.length !== 1 || p.content[0]?.type !== 'input_text') return;
        const value = p.content[0].text, parsed = questionReplies(value);
        if (typeof value === 'string' && value.trimStart().startsWith('<send_user_message_question_reply>') && !parsed.length) fail();
        for (const reply of parsed) {
          replies.set(reply.questionItemId, reply); while (replies.size > 256) replies.delete(replies.keys().next().value);
          const q = questions.get(reply.questionItemId); if (q && q.rawTitle === reply.question) q.answer = clean(reply.answer, 4000);
        }
      }
    },
    result(latest) {
      if (!verified) return unavailable();
      return { state: 'ready', data: [...questions.values()].map(q => ({ id: q.id, title: q.pcOnly ? 'PC에서 질문 확인' : q.title, options: q.pcOnly ? [] : q.options, turnId: q.turnId,
        state: q.pcOnly ? 'pc-only' : q.answer ? 'answered' : q.turnId && (ended.has(q.turnId) || (latest && (latest.id !== q.turnId || latest.status !== 'inProgress'))) ? 'historical' : 'unconfirmed',
        ...(!q.pcOnly ? { sourceKey: q.sourceKey } : {}),
        ...(q.answer && !q.pcOnly ? { answer: q.answer } : {}) })) };
    }
  };
}

export class Questions {
  constructor({ root = path.join(homedir(), '.codex', 'sessions'), io = fs, now = Date.now, paths = path } = {}) {
    this.paths = paths; this.root = paths.resolve(root); this.io = io; this.now = now; this.cache = new Map(); this.flights = new Map(); this.busy = 0;
  }
  metadataPath(file) {
    if (typeof file !== 'string' || file.length > 4096) fail();
    if (this.paths.sep !== '\\' || !file.startsWith('\\\\?\\')) return file;
    // Only trusted native metadata may use the extended ordinary drive form; not UNC/device namespaces.
    const local = file.slice(4);
    if (!/^[A-Za-z]:\\/.test(local)) fail();
    const parts = local.slice(3).split('\\');
    if (parts.some(part => !part || /[<>:"/|?*\x00-\x1f%]/.test(part) || /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail();
    return local;
  }
  inspect(file, id) {
    const paths = this.paths;
    if (typeof file !== 'string' || file.length > 4096 || /[\x00-\x1f%]|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(file) || !paths.isAbsolute(file) || /^(?:\\\\|\/\/|\\\?)/.test(file)) fail();
    if (!samePath(paths.normalize(file), paths.sep === '\\' ? file.replaceAll('/', paths.sep) : file, paths)) fail();
    const relative = paths.relative(this.root, file);
    if (relative.startsWith('..') || paths.isAbsolute(relative) || relative.split(paths.sep).length !== 4 || !/^\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]/.test(relative)) fail();
    if (!new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${id}\\.jsonl$`, 'i').test(paths.basename(file))) fail();
    let current = paths.parse(file).root; const parts = paths.relative(current, file).split(paths.sep);
    for (let n = 0; n < parts.length; n++) {
      current = paths.join(current, parts[n]); const stat = this.io.lstatSync(current);
      if (stat.isSymbolicLink() || !samePath(this.io.realpathSync(current), current, paths) || (n < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail();
      if (n === parts.length - 1) { if (!Number.isSafeInteger(stat.size) || stat.size <= 0) fail(); return stat; }
    }
    fail();
  }
  async get(id, metadata, latest, { fresh = false } = {}) {
    if (!uuid.test(id)) return unavailable();
    if (this.flights.has(id)) {
      if (!fresh) return this.flights.get(id);
      await this.flights.get(id);
      return this.get(id, metadata, latest, { fresh });
    }
    if (this.busy >= 2) return unavailable();
    const flight = this.read(id, metadata, latest, fresh).finally(() => { this.flights.delete(id); this.busy--; });
    this.busy++; this.flights.set(id, flight); return flight;
  }
  async read(id, metadata, latest, fresh = false) {
    let entry = this.cache.get(id);
    if (!fresh && entry && this.now() - entry.checked < 2000) return entry.parser ? snapshot(entry, latest) : entry.failure ?? unavailable();
    let fd;
    try {
      if (fresh || !entry?.parser || this.now() - entry.metadataAt >= 30000) {
        const result = await metadata(); if (result?.thread?.id !== id) fail();
        const file = this.metadataPath(result.thread.path); this.inspect(file, id);
        if (!entry || entry.file !== file) entry = { file, offset: 0, tail: Buffer.alloc(0), parser: questionParser(id) };
        entry.metadataAt = this.now();
      }
      const before = this.inspect(entry.file, id);
      fd = this.io.openSync(entry.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      if (identity(this.io.fstatSync(fd)) !== identity(before)) fail();
      const old = entry.stat;
      let reset = !entry.offset || (old && (objectId(old) !== objectId(before) || before.size < entry.offset || (before.size === old.size && identity(old) !== identity(before))));
      // Validate the previous boundary before accepting append-only growth. Never scan the middle.
      if (!reset && entry.checkpoint) {
        const checkpoint = Buffer.alloc(entry.checkpoint.length);
        const n = this.io.readSync(fd, checkpoint, 0, checkpoint.length, entry.offset - checkpoint.length);
        if (n !== checkpoint.length || !checkpoint.equals(entry.checkpoint)) reset = true;
      }
      if (before.size > QUESTION_FILE_LIMIT && (!entry.recent || before.size - entry.windowStart > QUESTION_RECENT_LIMIT)) reset = true;
      let budget = SCAN_BUDGET;
      const buffer = Buffer.alloc(64 * 1024);
      if (reset) {
        entry.offset = 0; entry.tail = Buffer.alloc(0); entry.parser = questionParser(id); entry.checkpoint = null;
        entry.recent = before.size > QUESTION_FILE_LIMIT; entry.windowStart = 0; entry.discard = false; entry.skipped = 0;
        if (entry.recent) {
          // Verify the exact first record of the owned file separately. A tail session_meta is not proof.
          let head = Buffer.alloc(0), position = 0, newline = -1;
          while (newline < 0 && position < before.size) {
            const n = this.io.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
            if (!n) fail(); position += n; budget -= n;
            head = Buffer.concat([head, buffer.subarray(0, n)]); newline = head.indexOf(10);
            if ((newline < 0 ? head.length : newline) > QUESTION_LINE_LIMIT) lineFail();
            await new Promise(resolve => setImmediate(resolve));
          }
          if (newline < 0) fail();
          const meta = parseLine(head.subarray(0, newline));
          if (meta?.type !== 'session_meta' || meta.payload?.id !== id) fail();
          entry.parser.record(meta);
          entry.offset = Math.max(newline + 1, before.size - (QUESTION_RECENT_LIMIT - 2 * 1024 * 1024));
          entry.windowStart = entry.offset;
          // The first tail fragment is deliberately omitted even if it happened to begin at a boundary.
          entry.discard = entry.offset > newline + 1;
        }
      }
      const end = Math.min(before.size, entry.offset + budget);
      while (entry.offset < end) {
        const n = this.io.readSync(fd, buffer, 0, Math.min(buffer.length, end - entry.offset), entry.offset); if (!n) fail();
        entry.offset += n; entry.checkpoint = Buffer.from(buffer.subarray(Math.max(0, n - 64), n));
        const bytes = Buffer.concat([entry.tail, buffer.subarray(0, n)]); let start = 0, newline;
        if (entry.discard) {
          const boundary = bytes.indexOf(10);
          entry.skipped += boundary < 0 ? bytes.length : boundary;
          if (entry.skipped > QUESTION_LINE_LIMIT) lineFail();
          if (boundary < 0) { entry.tail = Buffer.alloc(0); await new Promise(resolve => setImmediate(resolve)); continue; }
          start = boundary + 1; entry.discard = false;
        }
        while ((newline = bytes.indexOf(10, start)) !== -1) {
          const record = parseLine(bytes.subarray(start, newline)); start = newline + 1;
          if (record) entry.parser.record(record);
        }
        entry.tail = Buffer.from(bytes.subarray(start)); if (entry.tail.length > QUESTION_LINE_LIMIT) lineFail();
        // Yield between bounded chunks; other history/media requests must remain responsive.
        await new Promise(resolve => setImmediate(resolve));
      }
      if (identity(this.io.fstatSync(fd)) !== identity(before) || identity(this.inspect(entry.file, id)) !== identity(before)) fail();
      entry.stat = before; entry.complete = entry.offset === before.size && entry.tail.length === 0 && !entry.discard; entry.checked = this.now();
      this.cache.delete(id); this.cache.set(id, entry); while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
      return snapshot(entry, latest);
    } catch (error) {
      const runtime = ['CODEX_INSTALL_UNAVAILABLE', 'CODEX_INSTALL_AMBIGUOUS', 'CODEX_DISCONNECTED', 'CODEX_TIMEOUT'].includes(error?.code);
      const failure = { ...unavailable(), ...(error?.message === 'QUESTION_LINE_TOO_LARGE' ? { reason: 'line-too-large' } : runtime ? { reason: 'runtime-unavailable' } : {}) };
      this.cache.delete(id); this.cache.set(id, { checked: this.now(), metadataAt: 0, failure });
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
      return failure;
    }
    finally { if (fd !== undefined) this.io.closeSync(fd); }
  }
}
