import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProxy } from './proxy.mjs';
import { buildHarnessPatch } from './harness-config.mjs';

const minutes = Number(process.env.SESSION_MINUTES || 330);
const interval = Number(process.env.SNAPSHOT_INTERVAL_MINUTES || 20);
const password = process.env.HARNESS_ACCESS_PASSWORD;
const identity = process.env.TUNNL_IDENTITY_FILE;
const apiKey = process.env.CUSTOM_API_KEY;
const image = process.env.ENV_IMAGE;
const container = 'deepseek-environment';
let webToken = '';
let url = '';
let harness;
let tunnel;
let stopping = false;
let reconnects = 0;
let snapshotPromise;

if (!password || password.length < 16 || !identity || !apiKey || !image) {
  throw new Error('Missing required Actions secrets or ENV_IMAGE. Password must be 16+ characters.');
}
if (!Number.isInteger(minutes) || minutes < 10 || minutes > 330) {
  throw new Error('SESSION_MINUTES must be 10-330');
}
if (!Number.isInteger(interval) || interval < 5 || interval > 120) {
  throw new Error('SNAPSHOT_INTERVAL_MINUTES must be 5-120');
}

const temp = mkdtempSync(join(tmpdir(), 'dsh-container-start-'));
const patchFile = join(temp, 'cordis.patch.yml');
writeFileSync(patchFile, buildHarnessPatch(), { mode: 0o600 });
try {
  // Only nonsecret model metadata is copied. Never docker cp SSH keys, web
  // passwords or the API key into the snapshotable container filesystem.
  execFileSync('docker', ['cp', patchFile, container + ':/state/dsh/cordis.patch.yml'], {
    timeout: 30000, stdio: 'pipe'
  });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const proxy = startProxy({ password, getToken: () => webToken, getPublicUrl: () => url });

function lines(stream, handler) {
  let pending = '';
  stream.on('data', chunk => {
    pending += chunk.toString('utf8');
    const all = pending.split(/\r?\n/);
    pending = all.pop() || '';
    for (const entry of all) handler(entry);
    if (pending.length > 30000) pending = pending.slice(-2000);
  });
}
function safe(line) {
  // Model secrets and transient one-time browser tokens cannot appear in CI logs.
  return line.replaceAll(apiKey, '[REDACTED]')
    .replaceAll(password, '[REDACTED]')
    .replace(/([?&]token=)[^&\s]+/gi, '$1[REDACTED]').slice(0, 1200);
}
function runCommand(program, argv, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    lines(child.stdout, line => { if (line) console.log(safe(line)); });
    lines(child.stderr, line => { if (line) console.error(safe(line)); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(program + ' exited ' + code)));
  });
}

async function saveSnapshot() {
  if (snapshotPromise) return snapshotPromise;
  snapshotPromise = runCommand('bash', ['scripts/environment-checkpoint.sh'])
    .then(() => console.log('Environment snapshot uploaded; uncommitted /workspace and installed apps preserved.'))
    .catch(error => {
      console.error('SNAPSHOT FAILED: ' + error.message);
      throw error;
    })
    .finally(() => { snapshotPromise = undefined; });
  return snapshotPromise;
}

const timer = setInterval(() => {
  void saveSnapshot().catch(() => {
    console.error('Snapshot upload failed; prior GHCR image remains the restore point.');
  });
}, interval * 60_000);

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  console.log('Ending interactive session. Saving entire container writable filesystem...');
  try {
    // If a periodic upload was in progress, wait for it, then take a fresh
    // snapshot to capture changes made during that upload.
    if (snapshotPromise) await snapshotPromise;
    await saveSnapshot();
    if (process.env.RUNNER_TEMP) {
      writeFileSync(join(process.env.RUNNER_TEMP, 'environment-final-saved.ok'), 'saved\n');
    }
  } catch {
    exitCode = 1;
    console.error('Final snapshot failed. Previous successful GHCR checkpoint remains available.');
  } finally {
    harness?.kill('SIGTERM');
    tunnel?.kill('SIGTERM');
    proxy.close();
    process.exitCode = exitCode;
    // Allow the Docker CLI and SSH to release process handles, then finish.
    setTimeout(() => process.exit(process.exitCode), 5000).unref();
  }
}

process.on('SIGINT', () => { void stop(1); });
process.on('SIGTERM', () => { void stop(1); });
setTimeout(() => { void stop(); }, minutes * 60_000);

// Runtime package installation occurs INSIDE the persistent container, so
// the installed npm package will be present after the next successful commit.
console.log('Updating DeepSeek Harness npm latest inside persistent container...');
try {
  await runCommand('docker', ['exec', container, 'npm', 'install', '-g', '@deepseek-ai/dsh@latest']);
  await runCommand('docker', ['exec', container, 'dsh', 'web', '--help']);
} catch (error) {
  console.error('Failed to install DeepSeek Harness inside the container:', error.message);
  await stop(1);
}

function startHarness(publicUrl) {
  if (harness || stopping) return;
  console.log('Launching persisted DeepSeek Harness at ' + publicUrl);
  // 'docker exec -e NAME' imports NAME from the docker CLI environment at
  // execution time. Unlike docker run -e VALUE, it never stores the API key
  // in the container/image Config.Env committed to GHCR.
  harness = spawn('docker', [
    'exec', '-i', '-e', 'CUSTOM_API_KEY',
    '-e', 'DSH_HOME=/state/dsh',
    '-e', 'DSH_TELEMETRY_DISABLED=1',
    '-w', '/workspace', container,
    'dsh', 'web', '--no-open', '--port', '3080'
  ], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  function output(line) {
    const match = line.match(/dsh web:\s+(https?:\/\/[^\s]+)/);
    if (match) {
      try {
        const token = new URL(match[1]).searchParams.get('token');
        if (token) {
          webToken = token;
          console.log('Harness ready; Web bootstrap credential hidden from logs.');
          return;
        }
      } catch {}
    }
    if (line) console.log(safe(line));
  }
  lines(harness.stdout, output);
  lines(harness.stderr, output);
  harness.once('error', error => {
    console.error('Containerized Harness process error: ' + error.message);
    void stop(1);
  });
  harness.once('exit', code => {
    if (!stopping) {
      console.error('Containerized Harness exited unexpectedly: ' + code);
      void stop(1);
    }
  });
}

function startTunnel() {
  if (stopping) return;
  tunnel = spawn('ssh', [
    '-n', '-T', '-i', identity, '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', '80:localhost:3081', 'stable@proxy.tunnl.gg', 'output=json'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  function read(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.event !== 'tunnel' || typeof event.url !== 'string') return;
    try {
      const address = new URL(event.url);
      if (address.protocol !== 'https:' || !address.hostname.endsWith('.tunnl.gg')) {
        throw new Error('Unexpected tunnel address');
      }
      if (url && url !== address.origin) throw new Error('Stable hostname unexpectedly changed');
      url = address.origin;
      console.log('Stable tunnl.gg URL: ' + url);
      startHarness(url);
    } catch (error) {
      console.error('Tunnel verification failure: ' + error.message);
      void stop(1);
    }
  }
  lines(tunnel.stdout, read);
  lines(tunnel.stderr, read);
  tunnel.once('error', error => {
    console.error('SSH tunnel error: ' + error.message);
    void stop(1);
  });
  tunnel.once('exit', code => {
    if (stopping) return;
    if (++reconnects > 5) {
      console.error('Tunnel disconnected repeatedly; keeping last successful snapshot.');
      return void stop(1);
    }
    console.warn('tunnl.gg disconnected with code ' + code + '; reconnecting with original key.');
    setTimeout(startTunnel, 3000).unref();
  });
}
if (!stopping) startTunnel();
