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

export function startProxy({ password, getToken, getPublicUrl, port = 3081 }) {
  // Reject cross-site browser requests BEFORE mapping the upstream authority
  // to localhost. Otherwise rewriting Origin would weaken DSH's CSRF fence.
  function isAllowedBrowserOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      const publicUrl = getPublicUrl();
      return !!publicUrl && new URL(origin).origin === new URL(publicUrl).origin;
    } catch {
      return false;
    }
  }
  if (!password || password.length < 16) {
    throw new Error('HARNESS_ACCESS_PASSWORD must be at least 16 characters.');
  }
  const server = http.createServer((req, res) => {
    if (!checkPassword(req.headers.authorization, password)) return unauthorized(res);
    if (!isAllowedBrowserOrigin(req)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' });
      return res.end('Cross-origin requests are not permitted.');
    }
    const token = getToken();
    if (!token) {
      res.writeHead(503, { 'Cache-Control': 'no-store' });
      return res.end('DeepSeek Harness is starting. Refresh after it is ready.');
    }
    const headers = { ...req.headers };
    delete headers.authorization;
    // npm latest currently has no --public-url. Its signed browser cookie is
    // bound to the backend authority. Use loopback consistently for BOTH
    // token exchange and subsequent HTTP/WebSocket requests.
    headers.host = '127.0.0.1:3080';
    if (headers.origin) headers.origin = 'http://127.0.0.1:3080';
    const isRoot = req.method === 'GET' && req.url === '/';
    const hasSessionCookie = String(req.headers.cookie || '').includes('dsh-auth-');
    const refresh = req.method === 'GET' && req.url === '/?refresh-session=1';
    // Exchange the process token only when necessary. Always doing so on '/'
    // would cause an endless redirect: DSH redirects the exchange back to '/'.
    const path = refresh || (isRoot && !hasSessionCookie)
      ? '/?token=' + encodeURIComponent(token)
      : req.url;
    const upstream = http.request({
      hostname: '127.0.0.1', port: 3080, path, method: req.method, headers
    }, response => {
      // A browser may retain a cookie from a previous ephemeral runner.
      // A new runner uses a new signature, so exchange a fresh token once.
      if (isRoot && hasSessionCookie && response.statusCode === 401) {
        response.resume();
        res.writeHead(302, { Location: '/?refresh-session=1', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const outgoing = { ...response.headers, 'cache-control': 'no-store' };
      if (outgoing['set-cookie']) {
        outgoing['set-cookie'] = outgoing['set-cookie'].map(cookie =>
          /;\s*secure(?:;|$)/i.test(cookie) ? cookie : cookie + '; Secure'
        );
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
    if (!isAllowedBrowserOrigin(req)) {
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
