import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { startProxy } from './proxy.mjs';

const backendPort = 3080;
const password = 'integration-password-12345';
const basic = 'Basic ' + Buffer.from('agent:' + password).toString('base64');
const token = 'synthetic-token-not-a-secret';
const backendRequests = [];

const backend = http.createServer((req, res) => {
  backendRequests.push({ url: req.url, host: req.headers.host });
  if (req.url === '/?token=' + token) {
    res.writeHead(303, {
      Location: './',
      'Set-Cookie': 'dsh-auth-test=valid; Path=/; HttpOnly; SameSite=Strict'
    });
    return res.end();
  }
  if (req.url === '/' && String(req.headers.cookie || '').includes('dsh-auth-test=valid')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('DeepSeek mock application loaded');
  }
  res.writeHead(401);
  res.end('Mock backend: missing signed session');
});

function callProxy(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1', port, path, headers: { Authorization: basic, ...headers }
    }, res => {
      const chunks = [];
      res.on('data', part => chunks.push(part));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
  });
}

test('proxy authentication and Strict-cookie bootstrap do not redirect endlessly', async t => {
  await new Promise(resolve => backend.listen(backendPort, '127.0.0.1', resolve));
  t.after(() => backend.close());

  const proxy = startProxy({
    password,
    getToken: () => token,
    getPublicUrl: () => 'https://example.tunnl.gg',
    port: 0
  });
  await new Promise(resolve => proxy.once('listening', resolve));
  t.after(() => proxy.close());
  const port = proxy.address().port;

  const challenge = await callProxy(port, '/', { Authorization: '' });
  assert.equal(challenge.status, 401);

  const landing = await callProxy(port, '/');
  assert.equal(landing.status, 200);
  assert.match(landing.body, /http-equiv="refresh"/);
  assert.equal(landing.headers.location, undefined);
  const marker = landing.headers['set-cookie'][0].split(';')[0];
  assert.match(marker, /^dsh-proxy-boot=1$/);
  assert.match(landing.headers['set-cookie'][0], /SameSite=Lax/);

  const withoutMarker = await callProxy(port, '/?dsh-proxy-auth=1');
  assert.equal(withoutMarker.status, 403);

  const exchanged = await callProxy(port, '/?dsh-proxy-auth=1', { Cookie: marker });
  assert.equal(exchanged.status, 303);
  assert.equal(exchanged.headers.location, './');
  assert.match(exchanged.headers['set-cookie'][0], /SameSite=Strict/);
  assert.match(exchanged.headers['set-cookie'][0], /Secure/);
  const harnessCookie = exchanged.headers['set-cookie'][0].split(';')[0];

  const success = await callProxy(port, '/', { Cookie: marker + '; ' + harnessCookie });
  assert.equal(success.status, 200);
  assert.match(success.body, /mock application loaded/);
  assert.match(success.headers['set-cookie'][0], /Max-Age=0/);

  const missingStrictCookie = await callProxy(port, '/', { Cookie: marker });
  assert.equal(missingStrictCookie.status, 401);
  assert.equal(missingStrictCookie.headers.location, undefined);
  assert.match(missingStrictCookie.body, /stopped retrying/);

  const oldSession = await callProxy(port, '/', { Cookie: 'dsh-auth-test=expired' });
  assert.equal(oldSession.status, 200);
  assert.match(oldSession.body, /http-equiv="refresh"/);

  const safeExternalNavigation = await callProxy(port, '/', {
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document'
  });
  assert.equal(safeExternalNavigation.status, 200);

  const crossSiteApi = await callProxy(port, '/api/remote', {
    'Sec-Fetch-Site': 'cross-site'
  });
  assert.equal(crossSiteApi.status, 403);

  assert.ok(backendRequests.length >= 3);
  assert.ok(backendRequests.every(r => r.host === '127.0.0.1:3080'));
});
