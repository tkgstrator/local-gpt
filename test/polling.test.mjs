import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createService } = require('../dist/server.cjs');
async function fixture(t) {
  const service = createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 500, bridgeToken: 'test-local-key' });
  const ports = await service.start(); t.after(() => service.close());
  const base = `http://127.0.0.1:${ports.httpPort}`;
  const bridge = (path, body, key = 'test-local-key') => fetch(`${base}/bridge/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': key, 'X-Browser-Id': 'browser-one' }, body: JSON.stringify(body) });
  return { base, bridge };
}
test('HTTP bridge rejects incorrect pairing token', async t => {
  const { bridge } = await fixture(t);
  assert.equal((await bridge('poll', {}, 'wrong')).status, 401);
});
test('HTTP fallback carries the same request and answer without a page WebSocket', async t => {
  const { base, bridge } = await fixture(t);
  assert.equal((await bridge('poll', {})).status, 200);
  const response = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });
  let request;
  for (let i = 0; i < 30 && !request; i++) {
    request = (await (await bridge('poll', {})).json()).request;
    if (!request) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(request?.text, 'hello');
  assert.equal((await bridge('event', { type: 'answer', requestId: request.requestId, text: 'from polling' })).status, 200);
  await bridge('event', { type: 'stop', requestId: request.requestId });
  assert.equal((await (await response).json()).choices[0].message.content, 'from polling');
});

test('expired HTTP browser session fails pending request before a different browser takes over', async t => {
  const service = createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 1000, pollingLeaseMs: 40, bridgeToken: 'lease-test-key' });
  const { httpPort } = await service.start(); t.after(() => service.close());
  const base = `http://127.0.0.1:${httpPort}`;
  const poll = id => fetch(`${base}/bridge/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'lease-test-key', 'X-Browser-Id': id }, body: '{}' });
  await poll('first-browser');
  const response = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'private pending request' }] }) });
  await new Promise(resolve => setTimeout(resolve, 80));
  const next = await poll('second-browser');
  assert.equal((await next.json()).request, null);
  assert.equal((await response).status, 503);
});
