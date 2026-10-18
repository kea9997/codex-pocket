import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { browser } from './browser-fixture.mjs';
import { createPreview } from '../tools/ui-preview.mjs';
import { assets } from '../server/http.mjs';
import { httpCall } from './helpers.mjs';

const nativeAgent = 'Mozilla/5.0 Android Chrome/140 CodexPhone/2 CodexPhoneApp/0.3.0';
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const edges = ['top', 'right', 'bottom', 'left'];
// Execute actual blocking head scripts before the stylesheet, without a body, app state, I/O or storage.
// These are ownership/boot checks, not a CSS layout or Android inset measurement.
function headBoot(userAgent) {
  const values = new Map([['--app-height', '640px']]), root = { dataset: {}, style: { setProperty: (name, value) => values.set(name, value) } };
  const navigator = Object.freeze({ userAgent }), context = vm.createContext({ document: { documentElement: root }, navigator });
  for (const match of html.slice(0, html.indexOf('</head>')).matchAll(/<script\b[^>]*>|<link\b[^>]*>/g)) {
    if (/rel="stylesheet"/.test(match[0])) break;
    if (!match[0].startsWith('<script') || /\b(?:defer|async)\b/.test(match[0])) continue;
    const src = match[0].match(/src="([^"]+)"/)[1];
    vm.runInContext(readFileSync(new URL('../web' + src, import.meta.url), 'utf8'), context);
  }
  return { values, root, context, navigator };
}

test('known native UA owns only four safe-area layout variables before stylesheet/body, without capabilities, storage or network', () => {
  const f = headBoot(nativeAgent);
  assert.equal(f.root.dataset.insetOwner, 'native');
  for (const edge of edges) assert.equal(f.values.get('--safe-' + edge), '0px');
  assert.equal(f.values.size, 5); assert.equal(f.values.get('--app-height'), '640px');
  assert.equal(f.navigator.userAgent, nativeAgent); assert.equal(f.context.codexPhoneReady, undefined); assert.equal(f.context.state, undefined);
});

test('browser/PWA, unknown versions and lookalike markers preserve environment-backed layout on all four sides', () => {
  for (const agent of ['', 'Mozilla/5.0 Android Chrome/140', 'Mozilla/5.0 Safari/605', 'CodexPhone/2', 'CodexPhoneApp/0.3.0', 'CodexPhone/2 CodexPhoneApp/0.2.1', 'CodexPhone/2 CodexPhoneApp/0.3.1', 'NotCodexPhone/2 CodexPhoneApp/0.3.0', 'CodexPhone/20 CodexPhoneApp/0.3.0', 'CodexPhone/2 CodexPhoneApp/0.3.0-extra']) {
    const f = headBoot(agent); assert.equal(f.root.dataset.insetOwner, 'browser', agent);
    for (const edge of edges) assert.equal(f.values.get('--safe-' + edge), `var(--viewport-safe-${edge})`, agent);
    assert.equal(f.values.size, 5); assert.equal(f.navigator.userAgent, agent);
  }
});

test('layout ownership survives synthetic app boot, polling, IME resize and pairing view without granting a native capability or changing draft/focus', async () => {
  for (const [userAgent, owner] of [[nativeAgent, 'native'], ['Mozilla/5.0 Chrome/140', 'browser']]) {
    const f = await browser({ userAgent, innerHeight: 844 });
    assert.equal(f.document.documentElement.dataset.insetOwner, owner); assert.equal(f.ui.state.nativeVersion, 0);
    const draft = f.el('draft').value; f.el('draft').focus(); await f.ui.refreshCurrent();
    f.window.visualViewport = { height: 360 }; f.windowEvents.get('resize')(); f.frame(16);
    assert.equal(f.el('draft').value, draft); assert.equal(f.document.activeElement, f.el('draft')); assert.equal(f.ui.state.nativeVersion, 0);
    assert.equal(f.document.documentElement.dataset.insetOwner, owner);
    assert.ok(!f.calls.some(c => c.options.method === 'POST' && c.path !== '/api/accounts/presence'));
    f.ui.showPair(); assert.equal(f.el('pairView').hidden, false); assert.equal(f.document.documentElement.dataset.insetOwner, owner);
  }
});

test('loopback-only synthetic inset pages share production assets and nonzero inputs; native sample exercises shipped layout only without spoofing UA', async t => {
  const server = createPreview(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = (path, headers = {}) => httpCall(server.address().port, path, { headers: { Host: '127.0.0.1:47832', ...headers } });
  const css = await call('/sample-insets.css'), script = await call('/sample-insets-native.js');
  assert.equal(css.status, 200); assert.match(css.headers['content-type'], /^text\/css/); assert.equal(script.status, 200);
  assert.equal((await call('/sample-insets.css', { Host: 'other.invalid' })).status, 403);
  assert.equal((await call('/sample-insets-native.js', { Origin: 'http://other.invalid' })).status, 403);
  for (const mode of ['browser', 'native']) {
    const page = await call('/?sampleInsets=' + mode); assert.equal(page.status, 200);
    assert.match(page.text, /합성 안전 여백/); assert.match(page.text, /실제 Android inset·native 기능 검증이 아닙니다/);
    assert.ok(page.text.includes('href="/sample-insets.css"')); assert.equal(page.text.includes('src="/sample-insets-native.js"'), mode === 'native');
    const f = headBoot('Mozilla/5.0 Chrome/140');
    if (mode === 'native') vm.runInContext(script.text, f.context);
    assert.equal(f.root.dataset.insetOwner, mode); assert.equal(f.navigator.userAgent, 'Mozilla/5.0 Chrome/140');
    for (const edge of edges) assert.equal(f.values.get('--safe-' + edge), mode === 'native' ? '0px' : `var(--viewport-safe-${edge})`);
  }
  for (const path of ['/?sampleInsets=bad', '/?sampleInsets=native&extra=1', '/?sampleInsets=native&sampleInsets=browser']) assert.equal((await call(path)).status, 400);
  for (const path of ['/style.css', '/convenience.js', '/app.js']) assert.equal((await call(path)).text, assets.get(path).data.toString());
  assert.ok(!(await call('/')).text.includes('/sample-insets'));
  assert.equal(assets.has('/sample-insets.css'), false); assert.equal(assets.has('/sample-insets-native.js'), false);
  assert.ok(!assets.get('/').data.toString().includes('sampleInsets'));
});
