import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createService } = require('../dist/server.cjs');
async function fixture(t, extra = {}) {
  const service = createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 500, bridgeToken: 'update-key', ...extra });
  const { httpPort } = await service.start(); t.after(() => service.close());
  const base = `http://127.0.0.1:${httpPort}`;
  const bridge = (path, body, id = 'tab-a', key = 'update-key') => fetch(`${base}/bridge/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': key, 'X-Browser-Id': id }, body: JSON.stringify(body) });
  const health = async () => (await fetch(`${base}/health`)).json();
  const ready = async (id = 'tab-a', version = '2.4.14') => (await bridge('update-ready', { version }, id)).json();
  return { base, bridge, health, ready };
}
const chat = base => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });

test('update drain lease requires the pairing token and a valid version', async t => {
  const f = await fixture(t);
  assert.equal((await f.bridge('update-ready', { version: '2.4.14' }, 'tab-a', 'wrong')).status, 401);
  assert.equal((await f.bridge('update-ready', { version: 'latest' })).status, 400);
  assert.equal((await f.bridge('update-ready', { version: '2.4.14', extra: true })).status, 400);
  assert.equal((await f.health()).updating, false);
});

test('idle server grants a drain lease and refuses every browser operation while held', async t => {
  const f = await fixture(t);
  await f.bridge('poll', {});
  assert.deepEqual(await f.ready(), { ready: true });
  const h = await f.health();
  assert.equal(h.updating, true); assert.equal(h.availableBrowsers, 0);
  // Stored result metadata remains available while the browser is draining.
  assert.equal((await fetch(f.base + '/v1/sessions')).status, 200);
  assert.equal((await fetch(f.base + '/v1/response-jobs/00000000-0000-0000-0000-000000000000')).status, 404);
  for (const response of [
    await chat(f.base),
    await fetch(`${f.base}/v1/models`),
    await fetch(`${f.base}/v1/capabilities`),
    await fetch(`${f.base}/v1/response-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'hello' }) }),
  ]) {
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'browser_updating');
  }
  // Nothing was queued for the updating tab.
  assert.equal((await (await f.bridge('poll', {})).json()).request, null);
});

test('busy server refuses the drain lease', async t => {
  const f = await fixture(t, { timeoutMs: 2000 });
  await f.bridge('poll', {});
  const pending = chat(f.base);
  let request;
  for (let i = 0; i < 50 && !request; i++) { request = (await (await f.bridge('poll', {})).json()).request; if (!request) await new Promise(r => setTimeout(r, 10)); }
  assert.ok(request);
  assert.deepEqual(await f.ready(), { ready: false, reason: 'browser_busy' });
  assert.equal((await f.health()).updating, false);
  await f.bridge('event', { type: 'answer', requestId: request.requestId, text: 'done' });
  await f.bridge('event', { type: 'stop', requestId: request.requestId });
  assert.equal((await pending).status, 200);
});

test('queued but undelivered work also refuses the drain lease', async t => {
  const f = await fixture(t, { timeoutMs: 2000 });
  await f.bridge('poll', {});
  const pending = chat(f.base);
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await f.ready('tab-b')).ready, false);
  const request = (await (await f.bridge('poll', {})).json()).request;
  await f.bridge('event', { type: 'error', requestId: request.requestId, code: 'browser_busy', message: 'x' });
  await pending;
});

test('another already-connected tab polling does not release the lease; holder poll does', async t => {
  const f = await fixture(t);
  await f.bridge('poll', {}, 'tab-a'); await f.bridge('poll', {}, 'tab-b');
  assert.equal((await f.ready('tab-a')).ready, true);
  assert.equal((await (await f.bridge('poll', {}, 'tab-b')).json()).request, null);
  assert.equal((await f.health()).updating, true);
  assert.deepEqual(await f.ready('tab-b'), { ready: false, reason: 'browser_updating' });
  await f.bridge('poll', {}, 'tab-a');
  assert.equal((await f.health()).updating, false);
});

test('a newly connected tab releases the lease', async t => {
  const f = await fixture(t);
  await f.bridge('poll', {}, 'tab-a');
  assert.equal((await f.ready('tab-a')).ready, true);
  await f.bridge('poll', {}, 'tab-new');
  assert.equal((await f.health()).updating, false);
});

test('drain lease expires after a bounded interval', async t => {
  const f = await fixture(t, { updateLeaseMs: 60 });
  await f.bridge('poll', {});
  assert.equal((await f.ready()).ready, true);
  assert.equal((await f.health()).updating, true);
  await new Promise(r => setTimeout(r, 120));
  assert.equal((await f.health()).updating, false);
});
