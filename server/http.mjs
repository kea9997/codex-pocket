import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './rpc.mjs';
import { serveVideo } from './video.mjs';
import { serveFile } from './files.mjs';
import { storageScope } from './events.mjs';
import { Fx } from './fx.mjs';
import { release, releaseScript } from './release.mjs';
import { TEST_NETWORK, COOKIE, guardRequest, guardPeer, body, keys, text, threadId } from './security.mjs';

export const assets = new Map([
  ['/', ['../web/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['../web/app.js', 'text/javascript; charset=utf-8']],
  ['/device-state.js', ['../web/device-state.js', 'text/javascript; charset=utf-8']],
  ['/uploads.js', ['../web/uploads.js', 'text/javascript; charset=utf-8']],
  ['/convenience.js', ['../web/convenience.js', 'text/javascript; charset=utf-8']],
  ['/accounts.js', ['../web/accounts.js', 'text/javascript; charset=utf-8']],
  ['/markdown-blocks.js', ['../web/markdown-blocks.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['../web/style.css', 'text/css; charset=utf-8']]
].map(([route, [file, mime]]) => [route, { data: readFileSync(fileURLToPath(new URL(file, import.meta.url))), mime }]));
assets.get('/').data = Buffer.from(assets.get('/').data.toString().replace('__WEB_REVISION__', release.revision));
assets.get('/app.js').data = Buffer.concat([releaseScript, assets.get('/app.js').data]);
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
};
export function createBridge({ auth, engine, accounts = null, bodyClock = globalThis, fx = new Fx(), config = TEST_NETWORK }) {
  const ORIGIN = config.origin;
  const readBody = (req, limit) => body(req, limit, bodyClock);
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 120000, headersTimeout: 10000 }, async (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    req.on('error', () => {}); // An aborted body may emit an error after its reader has already cleaned up.
    let accountReadGuard = null;
    const json = (status, data) => {
      if (res.destroyed) return;
      if (status === 200) accountReadGuard?.();
      if (accounts && res.hasHeader('X-Codex-Account-Revision')) res.setHeader('X-Codex-Account-Revision', accounts.revision);
      if (!req.complete && res.socket) {
        res.setHeader('Connection', 'close');
        // Drain only a bounded remainder so early errors can reach the peer without a TCP reset.
        const socket = res.socket; let discarded = 0;
        const drain = chunk => { discarded += chunk.length; if (discarded > 128 * 1024) socket.destroy(); };
        const timer = setTimeout(() => socket.destroy(), 1000); timer.unref();
        const clean = () => {
          clearTimeout(timer); req.removeListener('data', drain); req.removeListener('end', clean); socket.removeListener('close', clean);
          if (!req.complete) req.destroy();
        };
        req.once('end', clean); socket.once('close', clean); req.on('data', drain); req.resume();
        res.once('finish', () => socket.end());
      }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
    };
    try {
      guardPeer(req.socket.remoteAddress, config); guardRequest(req, config);
      if (req.method === 'GET' && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'])) throw new BridgeError('BODY_REJECTED', 400);
      if (req.url.length > 8192 || req.url.includes('\\') || /%2f|%5c|%00/i.test(req.url)) throw new BridgeError('INVALID_PATH', 400);
      const url = new URL(req.url, ORIGIN);
      if (url.origin !== ORIGIN) throw new BridgeError('INVALID_PATH', 400);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/health') return json(200, { service: 'codex-phone', ok: true });
      if (req.method === 'GET' && assets.has(path)) {
        const asset = assets.get(path); res.writeHead(200, { 'Content-Type': asset.mime }); return res.end(asset.data);
      }
      if (req.method === 'POST' && path === '/api/pair') {
        const input = await readBody(req, 256); keys(input, ['code']);
        const paired = auth.pair(input.code, req.socket.remoteAddress);
        res.setHeader('Set-Cookie', `${COOKIE}=${paired.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.ttl / 1000)}`);
        return json(200, { paired: true });
      }
      const session = auth.authenticate(req.headers.cookie);
      if (req.method === 'POST') auth.csrf(session, req.headers['x-codex-csrf']);
      const authorize = () => {
        const current = auth.authenticate(req.headers.cookie);
        if (current.id !== session.id) throw new BridgeError('AUTH_REQUIRED', 401);
        auth.csrf(current, req.headers['x-codex-csrf']);
      };
      if (accounts && path.startsWith('/api/')) {
        await accounts.init();
        res.setHeader('X-Codex-Account-Revision', accounts.revision);
        const revision = accounts.revision;
        const nativeRead = req.method === 'GET' && !['/api/session', '/api/release', '/api/accounts', '/api/create/state'].includes(path) && !path.startsWith('/api/requests/');
        if (nativeRead) {
          accountReadGuard = () => accounts.guard(revision);
          accountReadGuard();
        }
      }
      if (req.method === 'GET' && path === '/api/session')
        return json(200, { csrf: session.csrf, expires: session.expires, storageScope: storageScope(session), ...engine.capability(), ...(accounts ? { accountRevision: accounts.revision } : {}) });
      if (accounts && path === '/api/accounts' && req.method === 'GET') {
        if (req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        const result = await accounts.refresh(session); auth.authenticate(req.headers.cookie); return json(200, result);
      }
      const accountActions = { save: ['operationId', 'label'], login: ['operationId', 'label'], switch: ['operationId', 'profileId', 'confirmed', 'pageId', 'pcTasksComplete'], recover: ['operationId', 'mode', 'confirmed', 'pageId', 'pcTasksComplete'], rename: ['operationId', 'profileId', 'label'], remove: ['operationId', 'profileId', 'confirmed'] };
      const accountAction = /^\/api\/accounts\/(save|login|switch|recover|rename|remove|cancel|presence)$/.exec(path);
      if (accounts && accountAction && req.method === 'POST') {
        if (req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        const input = await readBody(req, 1024), kind = accountAction[1]; authorize();
        if (kind === 'presence') { keys(input, ['pageId', 'blocked', 'visible', 'closed']); return json(200, accounts.presence(session, input)); }
        if (kind === 'cancel') { keys(input, ['operationId']); return json(200, await accounts.cancel(session, input.operationId)); }
        keys(input, accountActions[kind]);
        if (kind === 'remove' && input.confirmed !== true) throw new BridgeError('ACCOUNT_CONFIRM_REQUIRED', 400);
        return json(200, await accounts.begin(session, kind, input, req.headers['x-codex-account-revision'], authorize));
      }
      if (req.method === 'POST' && path === '/api/logout') {
        keys(await readBody(req), []); auth.revoke(session); accounts?.revoke(session); engine.media.revoke(session); engine.files.revoke(session);
        res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return json(200, { revoked: true });
      }
      if (req.method === 'GET' && path === '/api/release') {
        if (req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        return json(200, release);
      }
      if (req.method === 'GET' && path === '/api/events') {
        if ([...url.searchParams.keys()].some(k => k !== 'cursor') || url.searchParams.getAll('cursor').length > 1) throw new BridgeError('INVALID_QUERY', 400);
        return json(200, await engine.events.feed(session, text(url.searchParams.get('cursor'), 100, true)));
      }
      const file = /^\/api\/files\/([A-Za-z0-9_-]{43})(\/info)?$/.exec(path);
      if (req.method === 'GET' && file) {
        if (url.search) throw new BridgeError('INVALID_QUERY', 400);
        if (file[2]) return json(200, engine.files.info(session, file[1]));
        if (accounts) {
          engine.accountTransfers = (engine.accountTransfers || 0) + 1; let done = false;
          const finish = () => { if (!done) { done = true; engine.accountTransfers--; } };
          res.once('close', finish); res.once('finish', finish);
        }
        return serveFile(engine.files, session, file[1], req, res);
      }
      const media = /^\/api\/media\/([A-Za-z0-9_-]{43})$/.exec(path);
      if (req.method === 'GET' && media) {
        if (url.search) throw new BridgeError('INVALID_QUERY', 400);
        if (engine.media.kind(session, media[1]) === 'video') return serveVideo(engine.media, session, media[1], req, res);
        const image = engine.media.load(session, media[1]);
        res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.data.length, 'Content-Disposition': 'inline', 'Accept-Ranges': 'none' });
        return res.end(image.data);
      }
      if (req.method === 'GET' && path === '/api/usage') {
        if (url.search || req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        const authorize = engine.accountReadGuard(); authorize();
        const [result, reference] = await Promise.all([engine.usageSnapshot(), fx.snapshot()]);
        authorize(); auth.authenticate(req.headers.cookie); // Do not return private data after an in-flight logout/expiry, including an FX wait.
        return json(200, { ...result, fx: reference });
      }
      if (req.method === 'GET' && path === '/api/diagnostics') {
        if (url.search) throw new BridgeError('INVALID_QUERY', 400);
        return json(200, await engine.diagnostics());
      }
      if (req.method === 'GET' && path === '/api/activity') {
        if (url.search) throw new BridgeError('INVALID_QUERY', 400);
        return json(200, await engine.activity.snapshot());
      }
      if (req.method === 'GET' && path === '/api/threads') {
        for (const k of url.searchParams.keys()) if (!['cursor', 'search'].includes(k)) throw new BridgeError('INVALID_QUERY', 400);
        return json(200, await engine.list({ cursor: url.searchParams.get('cursor'), search: url.searchParams.get('search') }));
      }
      const match = /^\/api\/threads\/([A-Za-z0-9_-]{1,100})(?:\/(history|questions))?$/.exec(path);
      if (req.method === 'GET' && match) {
        const id = threadId(match[1]);
        if (!match[2]) return json(200, await engine.read(id, session));
        if (match[2] === 'questions') {
          if (url.search) throw new BridgeError('INVALID_QUERY', 400);
          const result = await engine.questionState(id, session); auth.authenticate(req.headers.cookie);
          return json(200, result);
        }
        return json(200, await engine.history(id, text(url.searchParams.get('cursor'), 4096, true), session));
      }
      if (req.method === 'GET' && path === '/api/options') {
        if (url.search || req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        const result = await engine.options.snapshot(); auth.authenticate(req.headers.cookie);
        return json(200, result);
      }
      if (req.method === 'GET' && path === '/api/create/state') {
        if (url.search || req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        const current = engine.creationState(session); // Owned local journal only, including account recovery boot.
        auth.authenticate(req.headers.cookie); return json(200, current);
      }
      if (req.method === 'POST' && path === '/api/uploads') {
        if (url.search || req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        const lease = accounts ? await accounts.enterWrite(req.headers['x-codex-account-revision']) : null;
        try { return json(200, await engine.uploads.receive(session, req, () => { authorize(); lease?.authorize(); })); }
        finally { lease?.close(); }
      }
      const cancelUpload = /^\/api\/uploads\/([A-Za-z0-9_-]{43})\/cancel$/.exec(path);
      if (req.method === 'POST' && cancelUpload) {
        if (url.search || req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        keys(await readBody(req, 128), []); authorize(); return json(200, engine.uploads.cancel(session, cancelUpload[1]));
      }
      if (req.method === 'POST' && ['/api/send', '/api/create'].includes(path)) {
        if (url.search || req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        const input = await readBody(req, 64 * 1024); authorize();
        const lease = accounts ? await accounts.enterWrite(req.headers['x-codex-account-revision']) : null;
        const dispatch = () => { authorize(); lease?.authorize(); };
        try {
          dispatch(); const result = await (path === '/api/send' ? engine.send(session, input, dispatch) : engine.create(session, input, dispatch));
          authorize(); return json(200, result);
        } finally { lease?.close(); }
      }
      const acknowledgeCreate = /^\/api\/create\/([A-Za-z0-9-]{36})\/acknowledge$/.exec(path);
      if (req.method === 'POST' && acknowledgeCreate) {
        if (url.search || req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        const input = await readBody(req, 512); authorize();
        return json(200, engine.acknowledgeCreation(session, acknowledgeCreate[1], input));
      }
      const acknowledge = /^\/api\/requests\/([A-Za-z0-9-]{36})\/acknowledge$/.exec(path);
      if (req.method === 'POST' && acknowledge)
        return json(200, engine.acknowledge(session, acknowledge[1], await readBody(req, 512)));
      const receipt = /^\/api\/requests\/([A-Za-z0-9-]{36})$/.exec(path);
      if (req.method === 'GET' && receipt) {
        if (url.search || req.url.includes('?')) throw new BridgeError('INVALID_QUERY', 400);
        let native = true;
        if (accounts) { try { accounts.guard(accounts.revision); } catch { native = false; } }
        const result = native ? await engine.inspectReceipt(session, receipt[1], () => auth.authenticate(req.headers.cookie)) : engine.receipt(session, receipt[1]);
        auth.authenticate(req.headers.cookie); return json(200, result);
      }
      throw new BridgeError('ROUTE_NOT_FOUND', 404);
    } catch (error) {
      if (res.headersSent) return res.end();
      return json(error instanceof BridgeError ? error.status : 500,
        { error: error instanceof BridgeError ? error.code : 'BRIDGE_ERROR' });
    }
  });
  server.maxConnections = 64; server.keepAliveTimeout = 5000;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.bridgeConfig = config;
  return server;
}
export function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const { port, host } = server.bridgeConfig;
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}
