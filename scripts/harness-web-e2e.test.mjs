import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { buildHarnessPatch } from './harness-config.mjs';
import { startProxy } from './proxy.mjs';

const home = mkdtempSync(join(tmpdir(), 'dsh-full-e2e-'));
const sslDir = mkdtempSync(join(tmpdir(), 'dsh-full-ssl-'));
const backendPort = 3080;
const proxyPort = 13881;
const edgePort = 19443;
const externalPort = 19444;
const externalOrigin = 'https://localhost:' + externalPort;
const publicOrigin = 'https://127.0.0.1:' + edgePort;
const password = 'full-browser-integration-12345';
let harness;
let proxy;
let edge;
let external;
let browser;
let timer;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
}
function close(server) {
  return server ? new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
    setTimeout(resolve, 750).unref();
  }) : Promise.resolve();
}
function generateTls() {
  const keyPath = join(sslDir, 'key.pem');
  const certPath = join(sslDir, 'cert.pem');
  const proc = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'pipe' });
  if (proc.status !== 0) throw new Error('Cannot generate ephemeral test TLS certificates');
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}
function waitForDshUrl(processHandle) {
  return new Promise((resolve, reject) => {
    let pending = '';
    const recent = [];
    const capture = chunk => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        recent.push(line.replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]').slice(0, 400));
        if (recent.length > 35) recent.shift();
        const match = line.match(/dsh web:\s+(https?:\/\/[^\s]+)/);
        if (match) {
          const url = new URL(match[1]);
          if (url.searchParams.has('token')) resolve(url);
        }
      }
    };
    processHandle.stdout.on('data', capture);
    processHandle.stderr.on('data', capture);
    processHandle.once('error', reject);
    processHandle.once('exit', code => reject(new Error(
      'Harness exited with ' + code + ' before ready:\n' + recent.slice(-15).join('\n')
    )));
    timer = setTimeout(() => reject(new Error(
      'Harness startup timed out:\n' + recent.slice(-15).join('\n')
    )), 150000);
  });
}

try {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'cordis.patch.yml'), buildHarnessPatch(), { mode: 0o600 });
  harness = spawn('npx', [
    '--yes', '@deepseek-ai/dsh@latest', 'web', '--no-open',
    '--port', String(backendPort)
  ], {
    detached: true,
    env: {
      ...process.env,
      DSH_HOME: home,
      CUSTOM_API_KEY: 'test-key-without-network-provider-calls',
      DSH_TELEMETRY_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const loginUrl = await waitForDshUrl(harness);
  clearTimeout(timer);

  const secret = loginUrl.searchParams.get('token');
  assert.ok(secret, 'Real Harness should announce one startup token');
  proxy = startProxy({
    password,
    getToken: () => secret,
    getPublicUrl: () => publicOrigin,
    port: proxyPort
  });
  await new Promise(resolve => proxy.once('listening', resolve));

  const tls = generateTls();
  edge = https.createServer(tls, (req, res) => {
    const upstream = http.request({
      host: '127.0.0.1', port: proxyPort, path: req.url,
      method: req.method, headers: req.headers
    }, response => {
      res.writeHead(response.statusCode || 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('Temporary upstream failure'); });
    req.pipe(upstream);
  });
  external = https.createServer(tls, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<a id="enter" href="' + publicOrigin + '/">Open coding agent</a>');
  });
  await listen(edge, edgePort);
  await listen(external, externalPort);

  const chrome = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium'
  ].find(path => path && existsSync(path));
  if (!chrome) throw new Error('Chrome/Chromium not installed on CI runner');

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
  const visited = [];
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) visited.push(frame.url());
  });
  await page.goto(externalOrigin + '/', { waitUntil: 'load' });
  await page.locator('#enter').click();

  await page.waitForFunction(() =>
    document.querySelector('#root')?.children.length > 0 ||
    document.querySelector('#app')?.children.length > 0 ||
    (typeof window.__DSH_BOOT__ !== 'undefined' && document.body?.textContent?.trim().length > 50),
  null, { timeout: 30000 });

  const mainFrameUrl = page.url();
  assert.ok(mainFrameUrl.startsWith(publicOrigin), 'Unexpected final origin: ' + mainFrameUrl);
  assert.ok(!mainFrameUrl.includes('token='), 'Browser URL exposed bootstrap secret');
  assert.ok(visited.length <= 10, 'Unexpected page-navigation loop: ' + visited.length);
  const session = (await context.cookies(publicOrigin)).find(x => x.name.startsWith('dsh-auth-'));
  assert.ok(session, 'Real Harness signed cookie was not retained by Chrome');

  const health = await page.evaluate(async () => {
    const result = await fetch('/api/remote.mux', { method: 'GET' });
    return result.status;
  });
  assert.notEqual(health, 401, 'Real Harness API rejects signed cookie');
  assert.notEqual(health, 403, 'Real Harness API refuses proxy Host/Origin');
  console.log('REAL BROWSER + REAL DSH PASS: Cross-site link, TLS edge, Basic password, Strict session cookie, UI bootstrap, authenticated API (' + health + ').');
  await context.close();
} catch (error) {
  console.error('REAL BROWSER + REAL DSH FAILURE:', error.message);
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  if (browser) await browser.close();
  await Promise.all([close(external), close(edge), close(proxy)]);
  if (harness?.pid) {
    try { process.kill(-harness.pid, 'SIGTERM'); } catch {}
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  rmSync(home, { recursive: true, force: true });
  rmSync(sslDir, { recursive: true, force: true });
}
