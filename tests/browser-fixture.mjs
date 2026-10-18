import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { waitFor } from './helpers.mjs';
import { release, releaseScript } from '../server/release.mjs';

// Actual browser code, isolated DOM/HTTP/clock controls. No real service or credentials.
export function deviceStorage() {
  const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
export async function browser({ selected = true, storage = deviceStorage(), session = deviceStorage(), userAgent = '', requestHook = null, scope = 'a'.repeat(64), reducedMotion = false, initialHash = '', asyncHistory = false, visualViewport = null, innerHeight, blurOnDetach = false, accountRecoveryBoot = false, assetRoot = new URL('../web/', import.meta.url), activityCount = 2 } = {}) {
  const events = new Map(), windowEvents = new Map(), timers = new Map(), frames = new Map(); let timerId = 0, frameId = 0, clock = 0;
  const motion = { matches: reducedMotion, addEventListener(_name, fn) { this.change = fn; } };
  class Text {
    constructor(value) { this.nodeType = 3; this.data = value; this.children = []; }
    get textContent() { return this.data; }
    set textContent(value) { this.data = value; }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  }
  class Element {
    constructor() { this.children = []; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.dataset = {}; this.style = { setProperty() {} }; this.classList = { toggle() {} }; this.scrollHeight = 100; this.scrollTop = 0; this.clientHeight = 100; this.attributes = {}; this.events = new Map(); }
    addEventListener(name, fn) { this.events.set(name, fn); }
    setAttribute(name, value) { this.attributes[name] = value; }
    setPointerCapture(id) { (this.captures ||= new Set()).add(id); }
    releasePointerCapture(id) { this.captures?.delete(id); }
    hasPointerCapture(id) { return this.captures?.has(id) || false; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') delete this.src; }
    showModal() { this.open = true; }
    close() { this.open = false; this.events.get('close')?.(); }
    append(...children) { for (const child of children) { child.remove?.(); if (typeof child === 'object') child.parent = this; this.children.push(child); } }
    insertBefore(child, before) { child.remove(); const index = before ? this.children.indexOf(before) : this.children.length; child.parent = this; this.children.splice(index, 0, child); }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove?.(); this.children = []; this.append(...children); }
    remove() { if (this.parent) { this.detached(); const index = this.parent.children.indexOf(this); if (index >= 0) this.parent.children.splice(index, 1); this.parent = null; } }
    detached() { this.detachCount = (this.detachCount || 0) + 1; if (blurOnDetach && document.activeElement === this) document.activeElement = null; for (const child of this.children) child.detached?.(); }
    focus() { document.activeElement = this; }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      event.currentTarget = this;
      event.preventDefault ||= () => { event.defaultPrevented = true; };
      const result = this['on' + event.type]?.(event); this.events.get(event.type)?.(event);
      if (event.bubbles && !event.cancelBubble) this.parent?.dispatchEvent?.(event);
      return result;
    }
    click() {
      if (this.disabled) return;
      const descendants = root => [root, ...root.children.flatMap(child => typeof child === 'object' ? descendants(child) : [])];
      const radio = this.tagName === 'INPUT' && this.type === 'radio';
      const checkbox = this.tagName === 'INPUT' && this.type === 'checkbox';
      const changed = checkbox || radio && !this.checked;
      if (checkbox) { this.checked = !this.checked; this.focus(); }
      if (radio) {
        for (const root of elements.values()) for (const other of descendants(root)) if (other !== this && other.tagName === 'INPUT' && other.type === 'radio' && other.name === this.name) other.checked = false;
        this.checked = true; this.focus();
      }
      const event = { type: 'click', bubbles: true, defaultPrevented: false };
      const result = this.dispatchEvent(event);
      if (changed && !event.defaultPrevented) { this.dispatchEvent({ type: 'input', bubbles: true }); this.dispatchEvent({ type: 'change', bubbles: true }); }
      if (this.tagName === 'SUMMARY' && this.parent?.tagName === 'DETAILS' && !event.defaultPrevented) {
        this.focus(); this.parent.open = !this.parent.open; this.parent.dispatchEvent({ type: 'toggle' });
      }
      // Native implicit label activation also applies when the option's text span is clicked.
      if (!radio && !event.defaultPrevented && !['BUTTON', 'TEXTAREA', 'INPUT'].includes(this.tagName)) {
        let label = this; while (label && label.tagName !== 'LABEL') label = label.parent;
        const control = label && descendants(label).find(child => ['INPUT', 'TEXTAREA'].includes(child.tagName));
        if (control && control !== this) return control.click();
      }
      return result;
    }
    play() { this.paused = false; this.playCalls = (this.playCalls || 0) + 1; return Promise.resolve(); }
    pause() { this.paused = true; this.pauseCalls = (this.pauseCalls || 0) + 1; }
    load() { this.loadCalls = (this.loadCalls || 0) + 1; this.currentTime = 0; }
    contains(target) { return this === target || this.children.some(child => child.contains?.(target)); }
    closest(selector) { let el = this; while (el) { if (el.tagName?.toLowerCase() === selector) return el; el = el.parent; } return null; }
    scrollIntoView(options) { this.scrollRequests = [...(this.scrollRequests || []), options]; }
    getBoundingClientRect() { return this.rect || { top: 0, bottom: 100 }; }
    get textContent() { return this.text?.data || ''; }
    set textContent(value) { this.text = new Text(value); this.replaceChildren(); }
    get childNodes() { return this.children.length ? this.children : this.text?.data ? [this.text] : []; }
    get isConnected() { return this === document.body || this === document.documentElement || [...elements.values()].includes(this) || Boolean(this.parent?.isConnected); }
    get childElementCount() { return this.children.length; }
    get parentNode() { return this.parent || null; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  }
  const elements = new Map(), calls = [];
  const document = { hidden: false, body: new Element(), documentElement: new Element(), activeElement: null,
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    createElement: tag => Object.assign(new Element(), { tagName: tag.toUpperCase() }), createDocumentFragment: () => new Element(), createTextNode: text => new Text(text),
    addEventListener(name, fn) { events.set(name, fn); } };
  const el = id => document.getElementById(id);
  el('appView').hidden = true; document.documentElement.dataset.webRevision = release.revision;
  Object.assign(el('accountPcIdle'), { tagName: 'INPUT', type: 'checkbox', checked: false });
  let offline = false, uncertain = false, hook = requestHook;
  let activity = ['fixture', 'other'].map(id => ({ id, title: id === 'fixture' ? '기존 제목' : '다른 대화', status: 'idle', desktopUnread: false,
    preview: { version: 'baseline', turnId: 'existing', itemId: 'a', text: '기존 답변', turnStatus: 'completed', observedAt: 100 }, previewCheckedAt: 100, previewState: 'ready' }));
  let historyPreview = { preview: activity[0].preview, previewCheckedAt: 100 };
  const location = { origin: 'http://100.64.0.10:47831', pathname: '/', search: '', hash: initialHash, reload() { this.reloads = (this.reloads || 0) + 1; } };
  const entries = [{ state: null, hash: initialHash }], traversals = []; let index = 0, rootExits = 0;
  const flushHistory = () => {
    if (!traversals.length) return;
    const target = index + traversals.shift();
    if (target < 0) { rootExits++; return; }
    if (target >= entries.length) return;
    index = target; location.hash = entries[index].hash;
    windowEvents.get('popstate')?.({ state: entries[index].state });
  };
  const history = {
    get state() { return entries[index].state; }, get length() { return entries.length; },
    pushState(state, _title, url) {
      const hash = String(url).includes('#') ? '#' + String(url).split('#').slice(1).join('#') : '';
      entries.splice(index + 1); entries.push({ state: structuredClone(state), hash }); index++; location.hash = hash;
    },
    replaceState(state, _title, url) {
      const hash = String(url).includes('#') ? '#' + String(url).split('#').slice(1).join('#') : '';
      entries[index] = { state: structuredClone(state), hash }; location.hash = hash;
    },
    go(delta) { traversals.push(delta); if (!asyncHistory) flushHistory(); },
    back() { this.go(-1); }, forward() { this.go(1); }
  };
  const uploads = [];
  class XMLHttpRequest {
    constructor() { this.upload = {}; this.headers = {}; }
    open(method, path) { this.method = method; this.path = path; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(file) { this.file = file; uploads.push(this); }
    abort() { this.aborted = true; this.onabort?.(); }
    progress(loaded) { this.upload.onprogress?.({ loaded, total: this.file.size, lengthComputable: true }); }
    respond(data, status = 200) { this.status = status; this.responseText = JSON.stringify(data); this.onload?.(); }
  }
  const context = vm.createContext({ XMLHttpRequest, document, window: { visualViewport, innerHeight, matchMedia: () => motion, addEventListener(name, fn) { windowEvents.set(name, fn); }, dispatchEvent(event) { windowEvents.get(event.type)?.(event); return true; } },
    performance: { now: () => clock }, requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    location, history, navigator: { userAgent }, crypto: webcrypto,
    URLSearchParams, AbortSignal, AbortController, TextEncoder, Uint8Array, Blob, File,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id), confirm: () => true,
    localStorage: storage, sessionStorage: session,
    fetch: async (path, options) => {
      calls.push({ path, options }); if (offline) throw new Error('fixture offline');
      const override = hook ? await hook(path, options) : null;
      let data, status = 200;
      if (override) { data = override.data; status = override.status ?? 200; }
      else if (path === '/api/session') data = { csrf: 'fixture-csrf', storageScope: scope };
      else if (path === '/api/activity') data = { data: activity, available: true, checkedAt: 100 };
      else if (path === '/api/usage') data = { source: 'pc-codex', state: 'unknown', checkedAt: Date.now(), attemptedAt: Date.now(), refreshAfter: Date.now() + 60000, stale: false, buckets: [] };
      else if (path === '/api/release') data = release;
      else if (path === '/api/create/state') data = { request: null };
      else if (path === '/api/options') data = { source: 'pc-desktop', refreshAfter: Date.now() + 60000, send: { available: false, state: 'unavailable', models: [] }, create: { available: false, state: 'unavailable', models: [] }, projects: { state: 'unavailable', items: [] } };
      else if (path === '/api/diagnostics') data = { bridge: 'available', desktop: 'available', readonly: 'available', checkedAt: 100, desktopSuccessAt: 100, readonlySuccessAt: 100 };
      else if (path.startsWith('/api/threads?')) data = { data: [{ id: 'fixture', title: '기존 제목' }], nextCursor: 'next-page', searchScope: '샘플 검색' };
      else if (path === '/api/logout') data = { revoked: true };
      else if (path.endsWith('/acknowledge')) { uncertain = false; data = { state: 'acknowledged', threadId: 'fixture', requestId: 'own-request' }; }
      else if (path.endsWith('/history')) data = { data: [{ id: 'existing', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: historyPreview.preview?.text ?? '' }] }], status: 'idle', nextCursor: null, ...historyPreview };
      else data = { thread: { title: '기존 제목' }, capability: { online: true, continuationEnabled: true }, uncertain, uncertainRequest: uncertain ? 'own-request' : null };
      return { ok: status >= 200 && status < 300, status, headers: { get: name => override?.headers?.[name] ?? null }, json: override?.json || (async () => data) };
    } });
  for (const file of ['convenience.js', 'device-state.js', 'uploads.js']) vm.runInContext(readFileSync(new URL(file, assetRoot), 'utf8'), context);
  vm.runInContext(releaseScript.toString(), context);
  for (const file of ['markdown-blocks.js', 'accounts.js']) vm.runInContext(readFileSync(new URL(file, assetRoot), 'utf8'), context);
  const source = readFileSync(new URL('app.js', assetRoot), 'utf8');
  vm.runInContext(source + '\nglobalThis.ui = { state, refreshCurrent, showError, loadList, composerState, refreshActivity, receiveActivity, openThread, markViewed, showPair, boot, scheduleActivity, persistDevice, capturePosition, restorePosition, durable };', context);
  await waitFor(() => accountRecoveryBoot ? !context.ui.state.booting && context.ui.state.csrf && context.ui.state.creation.checked : context.ui.state.activityRows.length === activityCount);
  const ui = context.ui;
  if (selected) { ui.state.selected = 'fixture'; el('draft').value = '보존할 한글 초안'; await ui.refreshCurrent(); }
  return { ui, el, calls, uploads, timers, frames, document, storage, window: context.window, events, windowEvents, evaluate: script => vm.runInContext(script, context),
    navigation: { history, location, entries, flush: flushHistory, get index() { return index; }, get pending() { return traversals.length; }, get rootExits() { return rootExits; } },
    advance: ms => { clock += ms; },
    frame: ms => { clock += ms; const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(clock); },
    reducedMotion: value => { motion.matches = value; motion.change?.(); },
    offline: value => { offline = value; context.navigator.onLine = !value; }, uncertain: value => { uncertain = value; }, hook: value => { hook = value; },
    activity: value => { activity = value; }, historyPreview: value => { historyPreview = value; } };
}
