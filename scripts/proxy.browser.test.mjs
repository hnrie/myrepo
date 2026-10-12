import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startProxy } from './proxy.mjs';

const password = 'browser-testing-password-123456';
const token = 'browser-test-only-token';
const mockPort = 3080;
const proxyPort = 13881;
const publicPort = 19443;
const externalPort = 19444;
const targetOrigin = 'https://127.0.0.1:' + publicPort;
const externalOrigin = 'https://localhost:' + externalPort;
const events = [];

function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
}
async function close(server) {
  await new Promise(resolve => server.close(resolve));
}
function certFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-browser-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const proc = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'pipe' });
  if (proc.status !== 0) throw new Error('OpenSSL unavailable for browser test');
  return { dir, key: readFileSync(key), cert: readFileSync(cert) };
}
function mockHarness(req, res) {
  events.push({ path: req.url, host: req.headers.host,
    site: req.headers['sec-fetch-site'], cookie: Boolean(req.headers.cookie) });
  if (req.url === '/?token=' + token) {
    res.writeHead(303, {
      Location: './',
      'Set-Cookie': 'dsh-auth-browser=authenticated; HttpOnly; Path=/; SameSite=Strict'
    });
    return res.end();
  }
  const authorized = String(req.headers.cookie || '').includes('dsh-auth-browser=authenticated');
  if (!authorized) {
    res.writeHead(401);
    return res.end('No signed cookie');
  }
  if (req.url === '/api/probe') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>DSH test app</title><div id="status">WAITING</div>' +
      '<script>fetch("/api/probe", { credentials: "same-origin" })' +
      '.then(r=>{document.getElementById("status").textContent = r.ok ? "CONNECTED" : "FAILED "+r.status})' +
      '.catch(()=>{document.getElementById("status").textContent = "NETWORK ERROR"})</script>');
  }
  res.writeHead(404);
  res.end();
}

const backend = http.createServer(mockHarness);
const { dir, key, cert } = certFiles();
const gateway = https.createServer({ key, cert }, (req, res) => {
  const proxy = http.request({
    host: '127.0.0.1', port: proxyPort, method: req.method,
    path: req.url, headers: req.headers
  }, upstream => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on('error', error => {
    res.writeHead(502);
    res.end(error.message);
  });
  req.pipe(proxy);
});
const external = https.createServer({ key, cert }, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><a id="open" href="' + targetOrigin + '/">Open DeepSeek Harness</a>');
});
let proxy;
let browser;

try {
  await listen(backend, mockPort);
  proxy = startProxy({ password, getToken: () => token,
    getPublicUrl: () => targetOrigin, port: proxyPort });
  await new Promise(resolve => proxy.once('listening', resolve));
  await listen(gateway, publicPort);
  await listen(external, externalPort);

  const paths = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium'
  ];
  const chrome = paths.find(p => p && existsSync(p));
  if (!chrome) throw new Error('No Chromium or Chrome browser installed on test runner');

  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server']
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    httpCredentials: { username: 'agent', password, send: 'always' }
  });
  const page = await context.newPage();
  const redirects = [];
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) redirects.push(frame.url());
  });

  await page.goto(externalOrigin + '/', { waitUntil: 'load' });
  await page.locator('#open').click();
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent === 'CONNECTED',
    null, { timeout: 15000 }
  );

  assert.ok(page.url().startsWith(targetOrigin + '/'));
  assert.ok(!page.url().includes('token='));
  assert.ok(redirects.length <= 8, 'Unexpected navigation loop: ' + JSON.stringify(redirects));
  assert.ok(events.some(e => e.path === '/?token=' + token));
  assert.ok(events.some(e => e.path === '/api/probe' && e.cookie));
  assert.ok(events.every(e => e.host === '127.0.0.1:3080'));
  console.log('BROWSER PASS: cross-site link -> same-site bootstrap -> Strict cookie -> DSH page -> authenticated API');
  await context.close();
} finally {
  if (browser) await browser.close();
  await close(external).catch(() => {});
  await close(gateway).catch(() => {});
  if (proxy) await close(proxy).catch(() => {});
  await close(backend).catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
