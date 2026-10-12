import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

function checkPassword(header, password) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64');
  const expected = Buffer.from('agent:' + password);
  return decoded.length === expected.length && timingSafeEqual(decoded, expected);
}

function unauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Private DeepSeek Harness", charset="UTF-8"',
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('Sign in with username agent and your configured password.');
}

// Browsers mark legitimate links from other sites as "cross-site".
// Allow only safe, top-level document GET navigations to the app entrypoint.
// Cross-site API requests and WebSocket handshakes stay forbidden.
export function isAllowedBrowserOrigin(req, publicUrl) {
  const headers = req.headers ?? {};
  const path = (req.url || '/').split('?')[0];
  const entrypoint = path === '/' || path === '/index.html';
  const topLevelNavigation =
    req.method === 'GET' &&
    entrypoint &&
    headers['sec-fetch-mode'] === 'navigate' &&
    headers['sec-fetch-dest'] === 'document';

  if (topLevelNavigation) return true;
  if (headers['sec-fetch-site'] === 'cross-site') return false;

  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return Boolean(publicUrl) && new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}

const BOOT_COOKIE = 'dsh-proxy-boot';
const BOOT_QUERY = '/?dsh-proxy-auth=1';

function hasCookie(header, name) {
  return String(header || '').split(';').some(item => item.trim().startsWith(name + '='));
}

function guardedHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
}

function bootstrapPage(res) {
  // First render an actual same-origin document, then navigate internally.
  // Strict DSH cookies can be withheld throughout a cross-site redirect chain.
  res.writeHead(200, {
    ...guardedHeaders(),
    'Set-Cookie': BOOT_COOKIE + '=1; Path=/; Max-Age=90; HttpOnly; Secure; SameSite=Lax'
  });
  res.end('<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="0;url=/?dsh-proxy-auth=1">' +
    '<title>Opening DeepSeek Harness</title></head><body>' +
    '<p>Connecting to DeepSeek Harness...</p>' +
    '<p><a href="/?dsh-proxy-auth=1">Continue to the coding agent</a></p>' +
    '</body></html>');
}

function authFailed(res) {
  // Fail closed instead of starting an endless sequence of 303 redirects.
  res.writeHead(401, {
    ...guardedHeaders(),
    'Set-Cookie': BOOT_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
  });
  res.end('<!doctype html><html><head><title>DeepSeek Harness login failed</title></head>' +
    '<body><h1>DeepSeek Harness session was not accepted</h1>' +
    '<p>The browser refused or rejected the signed session cookie. ' +
    'Open the site directly in a fresh tab and try again. If needed, clear ' +
    'site cookies. The proxy stopped retrying to avoid a redirect loop.</p></body></html>');
}

export function startProxy({ password, getToken, getPublicUrl, port = 3081 }) {
  // Check browser context BEFORE translating Host/Origin to the backend's
  // loopback authority, preserving the upstream DSH CSRF fence.
  const allowedOrigin = req => isAllowedBrowserOrigin(req, getPublicUrl());
  if (!password || password.length < 16) {
    throw new Error('HARNESS_ACCESS_PASSWORD must be at least 16 characters.');
  }
  const server = http.createServer((req, res) => {
    if (!checkPassword(req.headers.authorization, password)) return unauthorized(res);
    if (!allowedOrigin(req)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      return res.end('Cross-origin requests are not permitted.');
    }
    const token = getToken();
    if (!token) {
      res.writeHead(503, { 'Cache-Control': 'no-store' });
      return res.end('DeepSeek Harness is starting. Refresh after it is ready.');
    }
    const isRoot = req.method === 'GET' && req.url === '/';
    const isExchange = req.method === 'GET' && req.url === BOOT_QUERY;
    const hasBootAttempt = hasCookie(req.headers.cookie, BOOT_COOKIE);
    const hasHarnessCookie = String(req.headers.cookie || '').includes('dsh-auth-');
    if (req.method === 'GET' && req.url === '/index.html') {
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (isExchange && !hasBootAttempt) {
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      return res.end('Authentication handshake requires the same-site entry page.');
    }
    if (isRoot && !hasHarnessCookie) {
      return hasBootAttempt ? authFailed(res) : bootstrapPage(res);
    }

    const headers = { ...req.headers };
    delete headers.authorization;
    // npm latest lacks --public-url. Keep DSH's Host-bound session audience
    // fixed at loopback for token exchange, HTTP requests and WebSockets.
    headers.host = '127.0.0.1:3080';
    if (headers.origin) headers.origin = 'http://127.0.0.1:3080';
    // Only for a previously validated, safe top-level GET navigation.
    if (isRoot && headers['sec-fetch-site'] === 'cross-site') {
      headers['sec-fetch-site'] = 'same-origin';
    }
    const path = isExchange ? '/?token=' + encodeURIComponent(token) : req.url;
    const upstream = http.request({
      hostname: '127.0.0.1', port: 3080, path, method: req.method, headers
    }, response => {
      if (isRoot && response.statusCode === 401) {
        response.resume();
        return hasBootAttempt ? authFailed(res) : bootstrapPage(res);
      }
      const outgoing = { ...response.headers, 'cache-control': 'no-store' };
      if (outgoing['set-cookie']) {
        outgoing['set-cookie'] = outgoing['set-cookie'].map(cookie =>
          /;\s*secure(?:;|$)/i.test(cookie) ? cookie : cookie + '; Secure'
        );
      }
      if (isRoot && response.statusCode === 200 && hasBootAttempt) {
        const cookies = outgoing['set-cookie'] || [];
        outgoing['set-cookie'] = [...cookies, BOOT_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'];
      }
      res.writeHead(response.statusCode || 502, outgoing);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Cache-Control': 'no-store' });
      res.end('Harness backend temporarily unavailable.');
    });
    req.pipe(upstream);
  });

  // Browser WebSocket handshakes do not consistently send cached Basic auth.
  // DSH itself requires its signed browser-session cookie for EVERY WebSocket
  // request; only the password-gated HTTP root can mint that cookie.
  server.on('upgrade', (req, socket, head) => {
    if (!allowedOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect(3080, '127.0.0.1');
    upstream.once('connect', () => {
      const headers = { ...req.headers };
      delete headers.authorization;
      headers.host = '127.0.0.1:3080';
      if (headers.origin) headers.origin = 'http://127.0.0.1:3080';
      const pairs = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map(item => name + ': ' + item)
      );
      upstream.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n' +
        pairs.join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });

  server.listen(port, '127.0.0.1', () => {
    console.log('Password-protected HTTP proxy listening on 127.0.0.1:' + port);
  });
  return server;
}
