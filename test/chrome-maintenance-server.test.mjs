import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createService } = createRequire(import.meta.url)('../dist/server.cjs');
async function fixture(t, options = {}) {
  const service = createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 500, bridgeToken: 'key', pollingLeaseMs: 50, ...options });
  const { httpPort } = await service.start(); t.after(() => service.close());
  const base = `http://127.0.0.1:${httpPort}`;
  const post = (path, body = {}, id = '7:browser-a', documentId = 'doc-a', token = 'key') => fetch(base + '/bridge/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': token, 'X-Browser-Id': id, 'X-Chrome-Tab-Id': '7', 'X-Chrome-Document-Id': documentId }, body: JSON.stringify(body) });
  const maintenance = async body => { const response = await post('maintenance', body); assert.equal(response.status, 200, 'maintenance endpoint must handle authenticated probes'); return response.json(); };
  const health = async () => (await fetch(base + '/health')).json();
  return { post, maintenance, health, base };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
// Catch losing the selected document at polling expiry or making a watchdog probe a heartbeat.
test('maintenance retains the authorized selected document without renewing liveness', async t => {
  const f = await fixture(t); await f.post('poll'); await f.health(); await wait(100);
  const probe = await f.maintenance({ action: 'probe' });
  assert.deepEqual(probe.target, { browserId: '7:browser-a', tabId: 7, documentId: 'doc-a' });
  assert.equal((await f.health()).browserConnected, false);
  assert.equal((await f.health()).nativeReady, false);
  assert.equal((await f.post('maintenance', { action: 'probe' }, '7:browser-a', 'doc-a', 'bad')).status, 401);
});
// Catch reusing update leases that holder/new-lane polls release, and non-atomic admissions.
test('maintenance lease excludes admissions and survives holder and competing polls', async t => {
  const f = await fixture(t); await f.post('poll'); const { target } = await f.maintenance({ action: 'probe' });
  const lease = await f.maintenance({ action: 'acquire', target });
  assert.equal(lease.ready, true); assert.ok(lease.lease);
  await f.post('poll'); await f.post('poll', {}, '8:browser-b', 'doc-b');
  const admission = await fetch(f.base + '/v1/models'); assert.equal(admission.status, 409);
  assert.equal((await f.maintenance({ action: 'acquire', target })).ready, false);
  assert.equal((await f.maintenance({ action: 'cancel', target, lease: 'wrong' })).ready, false);
  await f.maintenance({ action: 'cancel', target, lease: lease.lease });
  assert.equal((await f.health()).updating, false);
});
// Catch stale-document reload authorization and leases valid beyond their bounded transaction.
test('maintenance rejects replaced documents and expired leases', async t => {
  const f = await fixture(t, { maintenanceLeaseMs: 60 }); await f.post('poll');
  const { target } = await f.maintenance({ action: 'probe' }); const first = await f.maintenance({ action: 'acquire', target });
  await f.post('poll', {}, '7:browser-a', 'doc-new');
  assert.equal((await f.maintenance({ action: 'validate', target, lease: first.lease })).ready, false);
  assert.equal((await f.maintenance({ action: 'acquire', target })).ready, false);
  const next = (await f.maintenance({ action: 'probe' })).target;
  const second = await f.maintenance({ action: 'acquire', target: next }); await wait(100);
  assert.equal((await f.maintenance({ action: 'validate', target: next, lease: second.lease })).ready, false);
});

for (const mode of ['native', 'legacy']) test(`restored unknown ${mode} work defers maintenance while ordinary bridge reconnects`, async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { createResponseJobStore } = await import('../src/response-jobs.ts');
  const dir = await mkdtemp(join(tmpdir(), 'maintenance-unknown-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createResponseJobStore({ dir }); const ids = [];
  for (let i = 0; i < 20; i++) { const job = store.create(); ids.push(job.id); store.context(job.id, { requestId: 'unknown-' + i, browserId: '7:browser-a', ...(mode === 'native' ? { mode: 'native', lifecycle: 'possible_dispatch', nativeUserMessageId: crypto.randomUUID() } : {}) }); }
  store.flush(); store.close();
  const f = await fixture(t, { responseJobsDir: dir });
  assert.equal((await f.post('poll')).status, 200);
  const probe = await f.maintenance({ action: 'probe' }); assert.equal(probe.deferred, 'work_in_progress');
  assert.deepEqual(await f.maintenance({ action: 'acquire', target: probe.target }), { ready: false, reason: 'work_in_progress' });
  for (const id of ids) { const job = await (await fetch(f.base + '/v1/response-jobs/' + id)).json(); assert.equal(job.status, 'in_progress'); assert.equal(job.phase, 'unresponsive'); }
  assert.equal((await f.post('event', { type: 'heartbeat' })).status, 200);
});

test('maintenance held after liveness expiry survives an unknown new lane poll', async t => {
  const f = await fixture(t); await f.post('poll'); await f.health(); await wait(100); await f.health();
  const { target } = await f.maintenance({ action: 'probe' }); const lease = await f.maintenance({ action: 'acquire', target });
  await f.post('poll', {}, '8:browser-b', 'doc-b');
  assert.equal((await f.maintenance({ action: 'validate', target, lease: lease.lease })).ready, true);
  assert.equal((await fetch(f.base + '/v1/models')).status, 409);
});

test('indeterminate final renderer commit retains exclusivity against competing admissions', async t => {
  const f = await fixture(t, { pollingLeaseMs: 5000 }); await f.post('poll');
  const { readFile } = await import('node:fs/promises'); let alarm; let finalResolve; let finalStarted = false; const storage = {};
  const chrome = { runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    alarms: { get: async () => undefined, create: () => undefined, onAlarm: { addListener: fn => alarm = fn } },
    storage: { local: { get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value) } },
    tabs: { get: async id => ({ id, url: 'https://chatgpt.com/' }), onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, sendMessage: async (_id, message, options) => {
      assert.equal(options.documentId, 'doc-a');
      if (message.type !== 'localgpt_maintenance_reload') return { safe: true, browserId: 'browser-a', startedAt: Date.now() - 7 * 60 * 60 * 1000 };
      // Renderer has authenticated the commit but its acknowledgement is delayed/lost.
      assert.equal((await f.maintenance({ action: 'validate', target: { browserId: '7:browser-a', tabId: 7, documentId: 'doc-a' }, lease: message.lease })).ready, true);
      finalStarted = true; return await new Promise(resolve => finalResolve = resolve);
    } } };
  const localFetch = (url, init) => fetch(String(url).replace('http://127.0.0.1:8766', f.base), init);
  new Function('chrome','fetch','importScripts','LOCALGPT_PAIRING_TOKEN', await readFile('dist/extension/background.js','utf8'))(chrome, localFetch, () => {}, 'key');
  alarm({ name: 'localgpt-connection-watchdog' });
  for (let i = 0; i < 50 && !finalStarted; i++) await wait(10);
  assert.equal(finalStarted, true); await wait(2150);
  assert.equal((await fetch(f.base + '/v1/models')).status, 409, 'unknown commit must keep its lease until expiry');
  finalResolve({ reloading: true });
});

test('a validated commit keeps exclusion after cancellation or navigation until its expiry', async t => {
  const f = await fixture(t); await f.post('poll'); const { target } = await f.maintenance({ action: 'probe' });
  const lease = await f.maintenance({ action: 'acquire', target });
  assert.equal((await f.maintenance({ action: 'validate', target, lease: lease.lease })).ready, true);
  await f.maintenance({ action: 'cancel', target, lease: lease.lease });
  assert.equal((await fetch(f.base + '/v1/models')).status, 409);
  await f.maintenance({ action: 'invalidate', target });
  assert.equal((await f.maintenance({ action: 'probe' })).target, null);
  assert.equal((await fetch(f.base + '/v1/models')).status, 409);
  await f.post('poll', {}, '7:browser-a', 'doc-new');
  assert.equal((await fetch(f.base + '/v1/models')).status, 409);
});

test('update drain transfers atomically to a document transaction that ordinary polls cannot release', async t => {
  const f = await fixture(t); await f.post('poll'); const { target } = await f.maintenance({ action: 'probe' });
  assert.equal((await (await f.post('update-ready', { version: '2.6.10' })).json()).ready, true);
  const transaction = await f.maintenance({ action: 'acquire', target }); assert.equal(transaction.ready, true);
  assert.equal((await f.maintenance({ action: 'validate', target, lease: transaction.lease })).ready, true);
  await f.post('poll'); await f.post('poll', {}, '8:browser-b', 'doc-b');
  assert.equal((await fetch(f.base + '/v1/models')).status, 409);
});
