// Account activity only, never quota, cost or a thread breakdown. RAM projection only.
export const TOKEN_TTL = 60000;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function date(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return null;
  const at = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? value : null;
}
export function tokenActivity(data) {
  const lifetimeTokens = count(data?.summary?.lifetimeTokens), peakDailyTokens = count(data?.summary?.peakDailyTokens);
  const dates = new Map();
  // An oversized response has unknown daily activity, not a misleading truncated "latest" day.
  const rows = data?.dailyUsageBuckets;
  if (Array.isArray(rows) && rows.length <= 400) for (const row of rows) {
    const day = date(row?.startDate);
    if (day) dates.set(day, dates.has(day) ? null : count(row?.tokens));
  }
  const daily = [...dates].sort(([a], [b]) => b.localeCompare(a)).slice(0, 14).map(([startDate, tokens]) => ({ startDate, tokens }));
  return { lifetimeTokens, peakDailyTokens, daily };
}
export class TokenUsage {
  constructor(read, { now = Date.now } = {}) { this.read = read; this.now = now; }
  view() {
    return { source: 'pc-codex-account-activity', state: this.state ?? 'unknown', checkedAt: this.checkedAt ?? null,
      attemptedAt: this.attemptedAt ?? null, refreshAfter: this.refreshAfter ?? null,
      stale: Boolean(this.checkedAt != null && (this.state === 'unavailable' || this.state === 'unsupported' || this.now() >= this.checkedAt + TOKEN_TTL)),
      ...(this.data ?? tokenActivity(null)) };
  }
  snapshot() {
    if (this.flight) return this.flight;
    if (this.refreshAfter != null && this.now() < this.refreshAfter) return Promise.resolve(this.view());
    const flight = Promise.resolve().then(() => this.read()).then(data => {
      this.data = tokenActivity(data); this.checkedAt = this.now();
      this.state = this.data.lifetimeTokens != null || this.data.peakDailyTokens != null || this.data.daily.some(row => row.tokens != null) ? 'ready' : 'unknown';
    }).catch(error => {
      if (['ACCOUNT_BUSY', 'ACCOUNT_CHANGED'].includes(error?.code)) throw error;
      this.state = error?.rpcCode === -32601 || error?.code === 'TOKEN_USAGE_UNSUPPORTED' ? 'unsupported' : 'unavailable';
    }).then(() => {
      this.attemptedAt = this.now(); this.refreshAfter = this.attemptedAt + TOKEN_TTL; return this.view();
    }).finally(() => { if (this.flight === flight) this.flight = null; });
    this.flight = flight; return flight;
  }
}
