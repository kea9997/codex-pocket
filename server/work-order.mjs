// Actual native updatedAt only. Observation/preview/seen clocks are never work timestamps.
// Keep the classic-script client counterpart in app.js aligned (cross-layer regression tested).
export function workTime(value) {
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
export function newestUpdate(a, b) {
  const left = workTime(a), right = workTime(b);
  return right !== null && (left === null || right > left) ? b : left !== null ? a : null;
}
export function compareWork(a, b) {
  const left = workTime(a.updatedAt), right = workTime(b.updatedAt);
  if (left !== right) return left === null ? 1 : right === null ? -1 : right > left ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
