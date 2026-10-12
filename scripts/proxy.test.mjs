import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedBrowserOrigin } from './proxy.mjs';

const address = 'https://bright-storm-d2a60b95.tunnl.gg';

function allow(method, path, headers = {}) {
  return isAllowedBrowserOrigin({ method, url: path, headers }, address);
}

test('external link to the app root is allowed as a top-level GET navigation', () => {
  assert.equal(allow('GET', '/', {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document'
  }), true);
});

test('external redirect containing an Origin header can navigate only to app entrypoint', () => {
  const headers = {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    origin: 'https://tunnl.gg'
  };
  assert.equal(allow('GET', '/', headers), true);
  assert.equal(allow('GET', '/index.html', headers), true);
  assert.equal(allow('GET', '/api/remote.mux', headers), false);
});

test('cross-site API GET and POST remain blocked', () => {
  assert.equal(allow('GET', '/api/health', { 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(allow('POST', '/api/remote', {
    'sec-fetch-site': 'cross-site',
    origin: 'https://evil.example'
  }), false);
  assert.equal(allow('POST', '/', {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document'
  }), false);
});

test('cross-site iframe, object and WebSocket connections remain blocked', () => {
  assert.equal(allow('GET', '/', {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'iframe'
  }), false);
  assert.equal(allow('GET', '/', {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'object'
  }), false);
  assert.equal(allow('GET', '/api/remote.mux', {
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'websocket',
    origin: 'https://evil.example'
  }), false);
});

test('same-origin requests and browser WebSockets remain allowed', () => {
  assert.equal(allow('POST', '/api/remote', {
    'sec-fetch-site': 'same-origin',
    origin: address
  }), true);
  assert.equal(allow('GET', '/api/remote.mux', {
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'websocket',
    origin: address
  }), true);
  assert.equal(allow('GET', '/', {
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document'
  }), true);
});

test('a mismatched, null, or malformed Origin is rejected on API requests', () => {
  assert.equal(allow('POST', '/api/remote', { origin: 'https://evil.example' }), false);
  assert.equal(allow('POST', '/api/remote', { origin: 'null' }), false);
  assert.equal(allow('POST', '/api/remote', { origin: '%wrong' }), false);
});

test('same-origin requests do not need an Origin header', () => {
  assert.equal(allow('GET', '/assets/app.js', { 'sec-fetch-site': 'same-origin' }), true);
});
