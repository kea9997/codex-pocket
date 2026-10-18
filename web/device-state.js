'use strict';
// Deliberately whitelist UI state. Cookies, CSRF, previews and full chat text never enter this record.
class DeviceState {
  constructor(storage, report = () => {}) { this.storage = storage; this.report = report; this.scope = null; this.data = this.empty(); this.key = 'codex-phone-device-v2'; }
  empty() { return { version: 2, scope: null, selected: null, drafts: [], favorites: [], positions: [], reads: [], pending: null, smoothAnswers: true, modelChoices: [], creation: null, snippets: [] }; }
  choice(value) {
    if (!value || typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value.model)) return null;
    if (value.thinking !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.thinking)) return null;
    return { model: value.model, ...(value.thinking !== undefined ? { thinking: value.thinking } : {}) };
  }
  id(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value); }
  bounded(value) {
    const out = this.empty(); out.scope = this.scope;
    if (!value || value.version !== 2 || value.scope !== this.scope) return out;
    const snippetIds = new Set(), labels = new Set(), texts = new Set();
    for (const r of (Array.isArray(value.snippets) ? value.snippets : []).slice(0, 12)) {
      if (!this.id(r?.id) || snippetIds.has(r.id) || typeof r.label !== 'string' || typeof r.text !== 'string' ||
          !r.label.trim() || r.label.length > 40 || !r.text.trim() || r.text.length > 2000 ||
          /[\x00-\x1f\x7f]/.test(r.label) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(r.text) || labels.has(r.label.trim()) || texts.has(r.text.trim())) continue;
      snippetIds.add(r.id); labels.add(r.label.trim()); texts.add(r.text.trim());
      out.snippets.push({ id: r.id, label: r.label.trim(), text: r.text.trim() });
    }
    out.selected = this.id(value.selected) ? value.selected : null;
    out.smoothAnswers = typeof value.smoothAnswers === 'boolean' ? value.smoothAnswers : true;
    let budget = 96000;
    for (const row of (Array.isArray(value.drafts) ? value.drafts : []).slice(-8).reverse()) {
      if (!Array.isArray(row) || !this.id(row[0]) || typeof row[1] !== 'string') continue;
      const text = row[1].slice(0, Math.min(16000, budget)); budget -= text.length; if (text) out.drafts.unshift([row[0], text]);
    }
    out.favorites = (Array.isArray(value.favorites) ? value.favorites : []).filter(r => this.id(r?.id) && typeof r.title === 'string').slice(0, 32).map(r => ({ id: r.id, title: r.title.slice(0, 300) }));
    out.positions = (Array.isArray(value.positions) ? value.positions : []).filter(r => this.id(r?.id) && typeof r.key === 'string' && r.key.length < 500 && (r.cursor === null || typeof r.cursor === 'string' && r.cursor.length <= 4096) && Number.isFinite(r.offset)).slice(-16).map(r => ({ id: r.id, key: r.key, cursor: r.cursor, offset: Math.max(-100000, Math.min(100000, r.offset)), bottom: r.bottom === true }));
    out.reads = (Array.isArray(value.reads) ? value.reads : []).filter(r => this.id(r?.id)).slice(-96).map(r => ({ id: r.id, baseline: r.baseline === true, unread: r.unread === true, desktopDismissed: r.desktopDismissed === true,
      version: typeof r.version === 'string' && /^[a-f0-9]{64}$/.test(r.version) ? r.version : null,
      seenAt: Number.isFinite(r.seenAt) ? r.seenAt : -1,
      seen: (Array.isArray(r.seen) ? r.seen : []).filter(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)).slice(-8) }));
    const p = value.pending;
    if (this.id(p?.threadId) && typeof p.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(p.requestId)) out.pending = { threadId: p.threadId, requestId: p.requestId,
      ...(typeof p.questionId === 'string' && p.questionId.length <= 500 ? { questionId: p.questionId,
        ...(typeof p.questionSourceKey === 'string' && /^[a-f0-9]{64}$/.test(p.questionSourceKey) ? { questionSourceKey: p.questionSourceKey } : {}) } : {}),
      ...(this.choice(p.selection) ? { selection: this.choice(p.selection) } : {}) };
    out.modelChoices = (Array.isArray(value.modelChoices) ? value.modelChoices : []).filter(r => this.id(r?.[0]) && this.choice(r?.[1])).slice(-32).map(r => [r[0], this.choice(r[1])]);
    if (typeof value.creation?.requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.creation.requestId)) out.creation = { requestId: value.creation.requestId };
    return out;
  }
  bind(scope) {
    if (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope)) return this.empty();
    if (this.scope === scope) return this.data;
    this.scope = scope; let stored;
    try { const raw = this.storage.getItem(this.key); if (raw && raw.length <= 180000) stored = JSON.parse(raw); }
    catch { this.report(false); }
    if (stored?.scope !== scope) { try { this.storage.removeItem(this.key); } catch { this.report(false); } }
    this.data = this.bounded(stored); return this.data;
  }
  save(value) {
    if (!this.scope) return false;
    this.data = this.bounded({ ...value, version: 2, scope: this.scope });
    try {
      const text = JSON.stringify(this.data); if (text.length > 180000) throw new Error('UI_STATE_LIMIT');
      this.storage.setItem(this.key, text); this.report(true); return true;
    } catch { this.report(false); return false; }
  }
  clear() { this.scope = null; this.data = this.empty(); try { this.storage.removeItem(this.key); } catch { this.report(false); } }
}
globalThis.DeviceState = DeviceState;
