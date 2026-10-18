// PC Desktop account only. Retain a bounded observation projection in RAM, never the native response.
export const USAGE_TTL = 60000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
function window(value) {
  if (!object(value)) return null;
  return {
    remainingPercent: finite(value.usedPercent) ? Math.max(0, Math.min(100, 100 - value.usedPercent)) : null,
    windowDurationMins: Number.isSafeInteger(value.windowDurationMins) && value.windowDurationMins > 0 && value.windowDurationMins <= 5256000 ? value.windowDurationMins : null,
    resetsAt: Number.isSafeInteger(value.resetsAt) && value.resetsAt > 0 && value.resetsAt <= 253402300799 ? value.resetsAt : null
  };
}
function credits(value) {
  if (!object(value)) return null;
  // Native balance is a decimal string: < 10^12, at most 18 fractional places / 31 characters.
  // Preserve the exact observation, without float conversion, coercion or boolean-derived zero.
  return {
    hasCredits: typeof value.hasCredits === 'boolean' ? value.hasCredits : null,
    unlimited: typeof value.unlimited === 'boolean' ? value.unlimited : null,
    balance: typeof value.balance === 'string' && value.balance.length <= 31 && /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?(?![\s\S])/.test(value.balance) ? value.balance : null
  };
}
function resetCount(data) {
  const value = object(data?.rateLimitResetCredits) ? data.rateLimitResetCredits.availableCount : null;
  // The service may cap/omit opaque detail rows. Only availableCount is authoritative.
  return Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
}
export function usageBuckets(data) {
  const modern = object(data?.rateLimitsByLimitId), map = modern ? data.rateLimitsByLimitId : null;
  const keys = map ? Object.keys(map) : [];
  if (keys.includes('codex')) { keys.splice(keys.indexOf('codex'), 1); keys.unshift('codex'); }
  const ids = map ? keys : object(data?.rateLimits) ? [data.rateLimits.limitId] : [];
  const buckets = [];
  for (const key of ids) {
    const value = map ? map[key] : data.rateLimits;
    if (!object(value)) continue;
    const codex = key === 'codex', n = buckets.length + 1;
    // Do not forward arbitrary native identifiers/names, which can contain account details.
    buckets.push({ id: codex ? 'codex' : `bucket-${n}`, label: codex ? 'Codex' : `추가 한도 ${n}`, primary: window(value.primary), secondary: window(value.secondary), credits: credits(value.credits) });
    if (buckets.length === 8) break;
  }
  return buckets;
}
export class Usage {
  constructor(desktop, { now = Date.now } = {}) { this.desktop = desktop; this.now = now; }
  view() {
    const now = this.now(), buckets = this.buckets ?? [];
    const windows = buckets.flatMap(b => [b.primary, b.secondary]).filter(Boolean);
    return { source: 'pc-codex', state: this.state ?? 'unknown', checkedAt: this.checkedAt ?? null,
      attemptedAt: this.attemptedAt ?? null, refreshAfter: this.refreshAfter ?? null, resetAvailableCount: this.resetAvailableCount ?? null,
      stale: Boolean(this.checkedAt != null && (this.state === 'unavailable' || this.state === 'unsupported' || now >= this.checkedAt + USAGE_TTL || windows.some(w => w.resetsAt != null && w.resetsAt * 1000 <= now))), buckets };
  }
  snapshot() {
    if (this.flight) return this.flight;
    if (this.refreshAfter != null && this.now() < this.refreshAfter) return Promise.resolve(this.view());
    this.flight = Promise.resolve().then(() => this.desktop.call('get_usage_limits', {})).then(data => {
      this.buckets = usageBuckets(data); this.resetAvailableCount = resetCount(data); this.checkedAt = this.now();
      this.state = this.resetAvailableCount != null || this.buckets.some(b => b.credits?.balance != null || b.credits?.unlimited === true || [b.primary, b.secondary].some(w => w?.remainingPercent != null && w.windowDurationMins != null)) ? 'ready' : 'unknown';
    }).catch(error => {
      this.state = error?.code === 'DESKTOP_TOOL_UNSUPPORTED' ? 'unsupported' : 'unavailable';
    }).then(() => {
      this.attemptedAt = this.now(); this.refreshAfter = this.attemptedAt + USAGE_TTL;
      return this.view();
    }).finally(() => { this.flight = null; });
    return this.flight;
  }
}
