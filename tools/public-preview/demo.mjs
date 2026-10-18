// Synthetic, read-only web demo. No production imports, native calls or filesystem writes.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const demoRelease = { revision: 'public-preview', notes: ['Synthetic preview only. No Codex connection or real account operations.'] };
const staticFiles = new Map([['/', ['index.html', 'text/html']], ...['app.js', 'convenience.js', 'device-state.js', 'uploads.js', 'markdown-blocks.js', 'accounts.js'].map(name => ['/' + name, [name, 'text/javascript']]), ['/style.css', ['style.css', 'text/css']], ['/demo-controls.js', ['demo-controls.js', 'text/javascript']]]);
export function createDemo({ root = new URL('./web/', import.meta.url) } = {}) {
  let scenario = 0;
  const rows = [{ id: 'demo-chat', title: '[합성 Preview] 모바일에서 기존 대화 읽기', status: 'idle', updatedAt: 1792100000 }];
  const turns = [{ id: 'demo-turn', status: 'completed', items: [
    { id: 'demo-user', type: 'userMessage', text: '이것은 생성한 예시 대화입니다. 실제 채팅이나 계정 정보가 아닙니다.' },
    { id: 'demo-answer', type: 'agentMessage', text: '## A pocket-sized conversation view\n\nRead, search, copy and collect results without losing your place. This demo never connects to Codex.\n\n| 기능 | 범위 |\n| --- | --- |\n| 토큰 활동 | 합성 값 · quota와 별도 |\n| 초기화 | 기기 내 카운트다운 |\n\n- [x] 합성 기록 읽기\n- [ ] 실제 연결은 이 패키지에 없음\n\n```js\nconst demo = "synthetic only";\n```\n\n![Generated pattern](/api/media/demo-image)' }
  ] }];
  const answer = turns[0].items[1];
  answer.images = [{ start: answer.text.indexOf('![Generated'), end: answer.text.length, media: { state: 'ready', url: '/api/media/demo-image', alt: 'Generated geometric pattern, not a screenshot' } }];
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.headers.host !== origin.slice(7) || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'DEMO_LOOPBACK_ONLY' });
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.method === 'POST') {
        // Only the finite synthetic scenario control is writable. No submitted text/files retained.
        if (path !== '/demo/scenario' || url.search || req.headers.origin !== origin || req.headers['x-preview-action'] !== 'synthetic' || req.headers['content-type'] !== 'application/json') { req.resume(); return json(403, { error: 'DEMO_READ_ONLY' }); }
        let bytes = 0, body = '';
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 32) return json(413, { error: 'DEMO_BODY_LIMIT' }); body += chunk; }
        if (body !== '{}') return json(400, { error: 'INVALID_INPUT' });
        scenario = (scenario + 1) % 8; return json(200, { scenario });
      }
      if (req.method !== 'GET') return json(405, { error: 'DEMO_READ_ONLY' });
      if (staticFiles.has(path)) {
        if (url.search) return json(400, { error: 'INVALID_QUERY' });
        const [name, type] = staticFiles.get(path); res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); return res.end(readFileSync(new URL(name, root)));
      }
      if (path === '/api/media/demo-image') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320"><rect width="640" height="320" fill="#292929"/><path d="M80 220L240 70L400 220Z" fill="#79bb91"/><circle cx="460" cy="130" r="65" fill="#e6cfae"/><text x="40" y="290" fill="#eeeae5" font-size="20">GENERATED DEMO · NOT A SCREENSHOT</text></svg>');
      }
      const now = Date.now();
      if (path === '/api/session') return json(200, { csrf: 'synthetic-not-authentication', storageScope: 'd'.repeat(64) });
      if (path === '/api/release') return json(200, demoRelease);
      if (path === '/api/threads') return json(200, { data: rows.filter(row => !url.searchParams.get('search') || row.title.includes(url.searchParams.get('search'))), nextCursor: null, searchScope: '合成 Preview · 1 conversation only' });
      if (path === '/api/activity') return json(200, { data: rows, available: true, checkedAt: now });
      if (path === '/api/threads/demo-chat') return json(200, { thread: rows[0], capability: { online: true, continuationEnabled: false, approvalsOnPc: true }, uncertain: false });
      if (path === '/api/threads/demo-chat/history') return json(200, { data: turns, status: 'idle', nextCursor: null });
      if (path === '/api/threads/demo-chat/questions') return json(200, { state: 'ready', data: [] });
      if (path === '/api/create/state') return json(200, { request: null });
      if (path === '/api/options') return json(200, { source: 'synthetic', refreshAfter: now + 60000, send: { available: false, state: 'unsupported', models: [] }, create: { available: false, state: 'unsupported', models: [] }, projects: { state: 'unsupported', items: [] } });
      if (path === '/api/accounts') return json(200, { revision: 'dddddddd-dddd-dddd-dddd-dddddddddddd', busy: false, supported: false, switchSupported: false, recovery: false, current: null, profiles: [], error: 'ACCOUNT_ATOMIC_SWITCH_UNAVAILABLE' });
      if (path === '/api/diagnostics') return json(200, { bridge: 'available', desktop: 'unsupported', readonly: 'unsupported', checkedAt: now });
      if (path === '/api/usage') {
        const old = scenario === 5 || scenario === 6, absent = scenario === 2 || scenario === 3;
        const tokenActivity = { source: 'pc-codex-account-activity', state: scenario === 2 ? 'unknown' : scenario === 3 ? 'unsupported' : scenario === 4 ? 'unavailable' : 'ready', checkedAt: absent ? null : now - (old ? 120000 : 0), stale: old,
          lifetimeTokens: absent || scenario === 4 || scenario === 7 ? null : scenario === 1 ? 0 : 1234567, peakDailyTokens: null, daily: scenario === 7 ? [{ startDate: '2026-06-18', tokens: 12345 }] : [], refreshAfter: now + 60000 };
        return json(200, { source: 'pc-codex', state: 'ready', checkedAt: now, refreshAfter: now + 60000, stale: false, tokenActivity,
          buckets: [{ id: 'codex', label: 'Synthetic quota', primary: { remainingPercent: 75, windowDurationMins: 300, resetsAt: scenario === 7 ? null : Math.floor(now / 1000) + (scenario === 6 ? -1 : 3660) }, secondary: { remainingPercent: 30, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 90000 }, credits: null }] });
      }
      return json(404, { error: 'DEMO_NOT_IMPLEMENTED' });
    } catch { if (!res.headersSent) json(500, { error: 'DEMO_ERROR' }); else res.end(); }
  });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createDemo().listen(47833, '127.0.0.1', () => process.stdout.write('Synthetic preview: http://127.0.0.1:47833\n'));
}
