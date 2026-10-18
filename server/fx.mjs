// Public USD/KRW reference only. No usage, account, cookies or query values leave this process.
export const FX_URL = 'https://api.frankfurter.dev/v2/rate/USD/KRW';
export const FX_TTL = 86400000, FX_BACKOFF = 900000, FX_MAX_AGE = 7 * FX_TTL, FX_TIMEOUT = 2500, FX_BYTES = 4096;
const day = now => Math.floor(now / FX_TTL) * FX_TTL;
function dateAt(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value && at <= day(now) && at >= day(now) - FX_MAX_AGE ? at : null;
}
function project(value, now) {
  if (!value || Array.isArray(value) || value.base !== 'USD' || value.quote !== 'KRW' || dateAt(value.date, now) === null ||
      typeof value.rate !== 'number' || !Number.isFinite(value.rate) || value.rate < 1 || value.rate > 100000 || !/^\d{1,6}(?:\.\d{1,8})?$/.test(String(value.rate))) throw new Error('FX_INVALID');
  return { rate: String(value.rate), date: value.date, checkedAt: now };
}
export class Fx {
  constructor({ fetch = globalThis.fetch, now = Date.now, clock = globalThis } = {}) { this.fetch = fetch; this.now = now; this.clock = clock; }
  view() {
    const now = this.now(), value = this.value;
    if (value && (dateAt(value.date, now) === null || now >= value.checkedAt + FX_MAX_AGE)) this.value = null;
    const usable = this.value, stale = Boolean(usable && (this.failed || now >= usable.checkedAt + FX_TTL || dateAt(usable.date, now) < day(now) - 3 * FX_TTL));
    return { source: 'frankfurter', base: 'USD', quote: 'KRW', state: usable ? stale ? 'stale' : 'ready' : 'unavailable',
      rate: usable?.rate ?? null, date: usable?.date ?? null, checkedAt: usable?.checkedAt ?? null, stale, refreshAfter: this.nextAt ?? null };
  }
  snapshot() {
    if (this.flight) return this.flight;
    if (this.nextAt != null && this.now() < this.nextAt) return Promise.resolve(this.view());
    this.flight = this.read().then(value => { this.value = value; this.failed = false; this.nextAt = this.now() + FX_TTL; })
      .catch(() => { this.failed = true; this.nextAt = this.now() + FX_BACKOFF; })
      .then(() => this.view()).finally(() => { this.flight = null; });
    return this.flight;
  }
  async read() {
    const controller = new AbortController(); let reader, timer;
    const deadline = new Promise((_, reject) => { timer = this.clock.setTimeout(() => { controller.abort(); reject(new Error('FX_TIMEOUT')); }, FX_TIMEOUT); });
    const operation = (async () => {
      const response = await this.fetch(FX_URL, { redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (controller.signal.aborted) throw new Error('FX_TIMEOUT');
      if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('FX_INVALID');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d{1,8}$/.test(length) || Number(length) > FX_BYTES)) throw new Error('FX_SIZE');
      reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new Error('FX_TIMEOUT');
        if (done) break;
        size += value.byteLength; if (size > FX_BYTES) throw new Error('FX_SIZE');
        chunks.push(value);
      }
      return project(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))), this.now());
    })();
    try { return await Promise.race([operation, deadline]); }
    finally { this.clock.clearTimeout(timer); controller.abort(); reader?.cancel().catch(() => {}); }
  }
}
