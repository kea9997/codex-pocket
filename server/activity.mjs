import { hash } from './security.mjs';

export function normalizeStatus(value) {
  const raw = typeof value === 'string' ? value : value?.type;
  const flags = Array.isArray(value?.activeFlags) ? value.activeFlags : [];
  const key = s => typeof s === 'string' ? s.replace(/[_ -]/g, '').toLowerCase() : '';
  if (flags.some(f => ['awaitingapproval', 'awaitinguserinput', 'waitingonapproval', 'waitingonuserinput'].includes(key(f)))) return 'waiting';
  const status = key(raw);
  if (['waiting', 'waitingforuser', 'awaitinguserinput', 'awaitingapproval', 'waitingforapproval', 'needsinput'].includes(status)) return 'waiting';
  if (['active', 'running', 'working', 'inprogress'].includes(status)) return 'active';
  if (status === 'idle') return 'idle';
  if (['notloaded', 'unavailable', 'disconnected', 'error', 'systemerror'].includes(status)) return 'unavailable';
  return 'unknown';
}

// Only the latest turn's visible assistant text. Never inspect reasoning or tool output.
export function assistantPreview(turns, observedAt) {
  const turn = turns?.[0];
  if (!turn) return null;
  for (let n = (turn.items?.length ?? 0) - 1; n >= 0; n--) {
    const item = turn.items[n];
    if (item?.type !== 'agentMessage' || typeof item.text !== 'string' || !item.text.trim()) continue;
    const text = item.text.slice(0, 64000), turnId = String(turn.id ?? ''), itemId = String(item.id ?? n);
    return { turnId, itemId, version: hash(JSON.stringify([turnId, itemId, text])),
      text: text.replace(/\s+/g, ' ').trim().slice(0, 240),
      phase: item.phase === 'commentary' ? 'commentary' : item.phase === 'final_answer' ? 'final' : null,
      turnStatus: turn.status, observedAt };
  }
  return null;
}

export class Activity {
  constructor(engine) { this.engine = engine; this.authorize = engine.accountReadGuard?.() || (() => {}); this.entries = new Map(); this.cached = null; this.pending = null; this.reading = null; }
  snapshot() {
    this.authorize();
    if (this.pending) return this.pending;
    if (this.cached && this.engine.now() - this.cached.at < 4000) return Promise.resolve(this.cached.value);
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect() {
    const now = this.engine.now();
    let rows;
    try { rows = await this.engine.recentThreads(); }
    catch {
      this.authorize();
      const value = { data: (this.cached?.value.data ?? []).map(r => ({ ...r, stale: true,
        previewState: r.preview ? 'stale' : 'unavailable' })), checkedAt: this.cached?.value.checkedAt ?? null,
        available: false, scope: '최근 50개와 고정 대화', warning: 'DESKTOP_NOT_AVAILABLE' };
      this.cached = { at: now, value }; return value;
    }
    this.authorize();
    const ids = new Set(rows.map(r => r.id));
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
    const candidates = rows.map(row => {
      const entry = this.entries.get(row.id), status = normalizeStatus(row.status);
      const key = JSON.stringify([row.updatedAt, status, row.isUnread]);
      const busy = ['active', 'waiting'].includes(status);
      const due = !entry || now - entry.attemptedAt >= (busy || entry.key !== key ? 4000 : 30000);
      const priority = busy ? 3 : row.isUnread ? 2 : entry && entry.key !== key ? 1 : 0;
      return { row, entry, key, busy, due, priority };
    }).filter(c => c.due).sort((a, b) => b.priority - a.priority ||
      (a.entry?.attemptedAt ?? -Infinity) - (b.entry?.attemptedAt ?? -Infinity));
    const quiet = candidates.filter(c => !c.busy).sort((a, b) =>
      (a.entry?.attemptedAt ?? -Infinity) - (b.entry?.attemptedAt ?? -Infinity))[0];
    const batch = candidates.slice(0, 4);
    if (quiet && !batch.includes(quiet) && now - (quiet.entry?.attemptedAt ?? -Infinity) >= 30000) batch[3] = quiet;
    // At most four latest-turn reads per snapshot, at most two outstanding. Shared across sessions.
    let index = 0;
    const worker = async () => {
      while (index < batch.length) {
        this.authorize();
        const { row, entry, key } = batch[index++];
        try {
          const checkedAt = this.engine.now();
          const result = await this.engine.desktopRead(row.id, undefined, 1, false); this.authorize();
          this.entries.set(row.id, { key, attemptedAt: checkedAt, checkedAt, failed: false,
            latestTurn: result.turns[0] ? { id: result.turns[0].id, status: result.turns[0].status } : null,
            preview: assistantPreview(result.turns, checkedAt) });
        } catch {
          this.entries.set(row.id, { ...entry, key, attemptedAt: this.engine.now(), failed: true });
        }
      }
    };
    if (!this.reading && batch.length) {
      const reading = Promise.all([worker(), worker()]).finally(() => {
        this.reading = null;
        while (this.entries.size > 96) this.entries.delete(this.entries.keys().next().value);
      });
      this.reading = reading;
      // Slow previews must not hold up live status or create another native read pool on the next poll.
      let timer;
      try { await Promise.race([reading, new Promise(resolve => { timer = setTimeout(resolve, 1200); })]); }
      finally { clearTimeout(timer); }
    }
    this.authorize();
    while (this.entries.size > 96) this.entries.delete(this.entries.keys().next().value);
    const checkedAt = this.engine.recent.at;
    const data = rows.map(row => {
      const entry = this.entries.get(row.id), key = JSON.stringify([row.updatedAt, normalizeStatus(row.status), row.isUnread]);
      const stale = entry?.failed || (entry?.checkedAt !== undefined && (now - entry.checkedAt > 30000 || entry.key !== key));
      return { id: row.id, title: typeof row.title === 'string' ? row.title.slice(0, 300) : '제목 없는 대화',
        status: normalizeStatus(row.status), desktopUnread: row.isUnread === true, updatedAt: row.updatedAt,
        stale: false, latestTurn: entry?.latestTurn ?? null, preview: entry?.preview ?? null, previewCheckedAt: entry?.checkedAt ?? null,
        previewState: stale ? entry?.preview ? 'stale' : 'unavailable' : entry?.checkedAt !== undefined ? 'ready' : 'pending' };
    });
    const value = { data, checkedAt, available: true, scope: '최근 50개와 고정 대화' };
    this.cached = { at: this.engine.now(), value }; return value;
  }
}
