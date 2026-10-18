import { randomBytes } from 'node:crypto';
import { hash } from './security.mjs';

export const storageScope = session => hash(session.id + ':device-state-v2');
const safe = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
// A single bounded observer shared by every authenticated client. No timer, writer or per-device source scan.
export class Events {
  constructor(engine) {
    this.engine = engine; this.authorize = engine.accountReadGuard?.() || (() => {}); this.epoch = randomBytes(12).toString('hex'); this.sequence = 0;
    this.ledger = []; this.threads = new Map(); this.at = -Infinity; this.flight = null; this.scanIndex = 0; this.available = false;
  }
  push(row, type, key, body) {
    const fingerprint = hash(JSON.stringify([row.id, type, key]));
    if (this.ledger.some(e => e.fingerprint === fingerprint)) return;
    this.ledger.push({ sequence: ++this.sequence, fingerprint, threadId: row.id, type, title: safe(row.title, 100) || 'Codex 원격', body: safe(body, 180) });
    if (this.ledger.length > 128) this.ledger.shift();
  }
  async collect() {
    this.authorize();
    const result = await this.engine.activity.snapshot(), now = this.engine.now(); this.authorize(); this.available = result.available;
    if (!result.available) return;
    const candidates = [];
    for (const row of result.data) {
      if (row.stale || row.previewState !== 'ready' || !row.latestTurn?.id) continue;
      let previous = this.threads.get(row.id);
      if (!previous) { previous = { questions: null }; this.threads.set(row.id, previous); }
      const turn = row.latestTurn, continuous = previous.at !== undefined && now - previous.at <= 120000;
      if (continuous && previous.turn?.id === turn.id && previous.turn.status === 'inProgress' && ['active', 'waiting'].includes(previous.status) && turn.status === 'completed' && row.status === 'idle')
        this.push(row, 'completed', turn.id, '작업이 완료되었습니다. 대화에서 결과를 확인해 주세요.');
      if (continuous && row.status === 'waiting' && previous.status !== 'waiting' && previous.turn?.id === turn.id)
        this.push(row, 'waiting', turn.id, 'PC에서 사용자 확인을 기다립니다. 승인·질문은 PC에서 확인해 주세요.');
      previous.turn = { id: turn.id, status: turn.status }; previous.status = row.status; previous.at = now;
      if (['active', 'waiting'].includes(row.status) && turn.status === 'inProgress') candidates.push(row);
    }
    // The existing Questions reader supplies its own 4MiB budget, eight sources and two-flight ceiling.
    for (let n = 0; n < Math.min(2, candidates.length); n++) {
      this.authorize();
      const row = candidates[(this.scanIndex + n) % candidates.length], previous = this.threads.get(row.id);
      const questions = await this.engine.questions.get(row.id, async () => {
        this.authorize(); const rpc = await this.engine.stored(); this.authorize();
        return rpc ? rpc.request('thread/read', { threadId: row.id, includeTurns: false }) : null;
      }, row.latestTurn);
      this.authorize();
      // A recent-only snapshot cannot establish all historical question IDs. Suppress async alerts
      // until a complete baseline is available; native waiting/completion observations stay independent.
      if (questions.state !== 'ready' || questions.coverage === 'recent') { previous.questions = null; continue; }
      const ids = new Set(questions.data.map(q => q.id));
      if (previous.questions) for (const q of questions.data) {
        if (!previous.questions.has(q.id) && q.state === 'unconfirmed' && q.turnId === row.latestTurn.id)
          this.push(row, 'question', q.id, '새 질문 기록이 있습니다. 현재 PC 대기 여부는 대화에서 확인해 주세요.');
      }
      previous.questions = new Set([...(previous.questions ?? []), ...ids].slice(-128));
    }
    if (candidates.length) this.scanIndex = (this.scanIndex + 2) % candidates.length;
    const current = new Set(result.data.map(r => r.id));
    for (const id of this.threads.keys()) if (!current.has(id)) this.threads.delete(id);
    while (this.threads.size > 96) this.threads.delete(this.threads.keys().next().value);
  }
  async feed(session, cursor) {
    this.authorize();
    if (!this.flight && this.engine.now() - this.at >= 15000) {
      this.flight = this.collect().catch(() => { this.available = false; }).finally(() => { this.at = this.engine.now(); this.flight = null; });
    }
    if (this.flight) await this.flight;
    this.authorize();
    const match = typeof cursor === 'string' && /^([a-f0-9]{24})\.(\d{1,12})$/.exec(cursor);
    const sequence = match ? Number(match[2]) : -1;
    const reset = !match || match[1] !== this.epoch || sequence > this.sequence || sequence < (this.ledger[0]?.sequence ?? this.sequence + 1) - 1;
    return { storageScope: storageScope(session), cursor: `${this.epoch}.${this.sequence}`, reset, available: this.available,
      events: reset ? [] : this.ledger.filter(e => e.sequence > sequence).map(({ sequence: n, fingerprint, ...event }) => ({ ...event, id: `${this.epoch}.${n}`, fingerprint })) };
  }
}
