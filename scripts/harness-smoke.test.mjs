import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarnessPatch } from './harness-config.mjs';

const home = mkdtempSync(join(tmpdir(), 'dsh-real-smoke-'));
const port = 13880;
const root = 'http://127.0.0.1:' + port + '/';
const log = [];
let child;
let timeout;

function sanitize(s) {
  return s.replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]').slice(0, 500);
}

try {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'cordis.patch.yml'), buildHarnessPatch(), { mode: 0o600 });
  child = spawn('npx', [
    '--yes', '@deepseek-ai/dsh@latest', 'web', '--no-open', '--port', String(port)
  ], {
    detached: true,
    env: {
      ...process.env,
      DSH_HOME: home,
      CUSTOM_API_KEY: 'smoke-test-placeholder-not-a-real-api-key',
      DSH_TELEMETRY_DISABLED: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const tokenizedUrl = await new Promise((resolve, reject) => {
    let pending = '';
    const capture = bytes => {
      pending += bytes.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        log.push(sanitize(line));
        if (log.length > 60) log.shift();
        const match = line.match(/dsh web:\s+(https?:\/\/[^\s]+)/);
        if (match) {
          try {
            const url = new URL(match[1]);
            if (url.searchParams.has('token')) return resolve(url.href);
          } catch {}
        }
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(
      'DeepSeek Harness exited before ready: ' + code + '/' + signal + '\n' + log.slice(-20).join('\n')
    )));
    timeout = setTimeout(() => reject(new Error(
      'DeepSeek Harness did not become ready in 150 seconds:\n' + log.slice(-20).join('\n')
    )), 150000);
  });
  clearTimeout(timeout);

  const issued = await fetch(tokenizedUrl, { redirect: 'manual' });
  assert.equal(issued.status, 303, 'Real Harness token exchange should redirect');
  assert.equal(issued.headers.get('location'), './');
  const cookie = issued.headers.get('set-cookie');
  assert.ok(cookie?.includes('SameSite=Strict'), 'Real Harness must mint a Strict signed session');
  const sessionCookie = cookie.split(';')[0];

  const index = await fetch(root, { headers: { Cookie: sessionCookie }, redirect: 'manual' });
  assert.equal(index.status, 200, 'Authenticated real Harness index page must return 200');
  assert.match(index.headers.get('content-type') || '', /html/i);
  console.log('REAL HARNESS PASS: npm latest starts with Muse Spark xhigh config, token exchange 303, authenticated Web UI HTTP 200.');
} catch (e) {
  console.error('REAL HARNESS SMOKE FAILURE:', e.message);
  process.exitCode = 1;
} finally {
  if (timeout) clearTimeout(timeout);
  if (child?.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  rmSync(home, { recursive: true, force: true });
}
