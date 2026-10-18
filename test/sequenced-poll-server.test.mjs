import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createService } = createRequire(import.meta.url)('../dist/server.cjs');
const stream = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const wait = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, extra = {}) {
  const service = createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 150, bridgeToken: 'key', pollingLeaseMs: 70, ...extra });
  const { httpPort } = await service.start(); let closed = false; const close = async () => { if (!closed) { closed = true; await service.close(); } }; t.after(close);
  const base = `http://127.0.0.1:${httpPort}`;
  const post = (path, body, doc = 'doc-a') => fetch(base + '/bridge/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'key', 'X-Browser-Id': '7:browser-a', 'X-Chrome-Tab-Id': '7', 'X-Chrome-Document-Id': doc }, body: JSON.stringify(body) });
  const json = async (path, body, doc) => { const r = await post(path, body, doc); assert.equal(r.status, 200); return r.json(); };
  const opened = await json('poll-open', { protocol: 1, streamId: stream, activation: 1000 });
  const read = (sequence, data = {}, doc = 'doc-a') => json('poll-v2', { protocol: 1, epoch: opened.epoch, streamId: stream, activation: 1000, sequence, ...data }, doc);
  const health = async () => (await fetch(base + '/health')).json();
  return { base, post, json, opened, read, health, close };
}
test('poll handshake and rejected identities do not fabricate liveness or selected target', async t => {
  const f = await fixture(t); assert.equal((await f.health()).browserConnected, false);
  assert.equal((await f.json('maintenance', { action: 'probe' })).target, null);
  assert.equal((await f.read(2)).error, 'invalid_sequence'); assert.equal((await f.health()).browserConnected, false);
  assert.equal((await f.read(1, { epoch: other })).error, 'epoch_changed'); assert.equal((await f.health()).browserConnected, false);
  await f.read(1); assert.equal((await f.health()).browserConnected, true);
});
test('lost poll replies replay only live readiness and cannot dequeue the next logical request', async t => {
  const f = await fixture(t); const first = await f.read(1, { nativeProtocol: 1 });
  assert.equal(first.request.type, 'native_readiness');
  assert.deepEqual((await f.read(1, { nativeProtocol: 1 })).request, first.request);
  await f.read(2); assert.equal((await f.read(1)).error, 'stale_poll');
});
test('expired readiness and synchronous legacy owners retire their cached command', async t => {
  const f = await fixture(t); await f.read(1, { nativeProtocol: 1 }); await wait(140);
  assert.equal((await f.read(1)).request, null);
  const g = await fixture(t); await g.read(1);
  const completion = fetch(g.base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) });
  await wait(20); const command = await g.read(2); assert.equal(command.request.type, 'request');
  await completion; assert.equal((await g.read(2)).request, null);
  assert.equal((await g.read(1)).error, 'stale_poll');
});
test('fenced streams cannot renew a selected document or read after idle lane deletion', async t => {
  const f = await fixture(t); await f.read(1); await wait(140);
  await f.json('poll-open', { protocol: 1, streamId: other, activation: 2000 }, 'doc-b');
  assert.equal((await f.read(1)).error, 'stream_replaced'); assert.equal((await f.health()).browserConnected, false);
  assert.equal((await f.json('poll-open', { protocol: 1, streamId: stream, activation: 1000 })).error, 'inactive_document');
  assert.equal((await f.json('poll-v2', { protocol: 1, epoch: f.opened.epoch, streamId: other, activation: 2000, sequence: 1 }, 'doc-b')).request, null);
  assert.equal((await f.json('maintenance', { action: 'probe' })).target.documentId, 'doc-b');
});

async function runtime(f) {
  const { createExtensionTransport } = await import('../src/extension-transport.ts');
  const { handleBridgeMessage } = await import('../src/extension-handler.ts');
  const state = { base: f.base, offline: false, dropReply: false, calls: [] };
  const transport = createExtensionTransport(async request => {
    state.calls.push(request);
    if (state.offline) return { ok: false, error: 'temporary server outage' };
    const response = await handleBridgeMessage(request, { id: 'extension', url: 'https://chatgpt.com/', tab: { id: 7 }, documentId: 'doc-a', frameId: 0 }, { extensionId: 'extension', token: 'key' }, (url, init) => fetch(state.base + new URL(url).pathname, init));
    if (state.dropReply && request.path === 'poll-v2') { state.dropReply = false; return { ok: false, error: 'response lost after server dequeue' }; }
    return response;
  }, 1000);
  const read = () => transport('poll', { nativeProtocol: 1 }, 'browser-a');
  const event = body => transport('event', body, 'browser-a');
  return { state, transport, read, event };
}
async function unknownJobs(t, count = 21) {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { createResponseJobStore } = await import('../src/response-jobs.ts');
  const dir = await mkdtemp(join(tmpdir(), 'poll-unknown-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const jobs = createResponseJobStore({ dir }); const ids = [];
  for (let i = 0; i < count; i++) { const job = jobs.create(); ids.push(job.id); jobs.context(job.id, { requestId: 'old-' + i, browserId: '7:browser-a', mode: 'native', lifecycle: 'possible_dispatch', nativeUserMessageId: crypto.randomUUID() }); }
  jobs.flush(); jobs.close(); return { dir, ids };
}
test('transient outage and server restart recover polling with21unknown jobs without reload or clearing', async t => {
  const { dir, ids } = await unknownJobs(t); const f = await fixture(t, { responseJobsDir: dir, pollingLeaseMs: 5000 }); const r = await runtime(f);
  r.state.offline = true; await assert.rejects(r.read()); r.state.offline = false;
  const first = await r.read(); assert.equal(first.request.type, 'native_readiness');
  assert.equal((await f.health()).browserConnected, true); assert.equal((await f.health()).activeGenerations, 21);
  r.state.offline = true; await assert.rejects(r.read()); await f.close();
  const restarted = await fixture(t, { responseJobsDir: dir, pollingLeaseMs: 5000 }); r.state.base = restarted.base; r.state.offline = false;
  const next = await r.read(); assert.equal(next.request.type, 'native_readiness'); assert.notEqual(next.epoch, first.epoch);
  const probe = await restarted.json('maintenance', { action: 'probe' }); assert.equal(probe.target.documentId, 'doc-a'); assert.equal(probe.deferred, 'work_in_progress');
  for (const id of ids) { const job = await (await fetch(restarted.base + '/v1/response-jobs/' + id)).json(); assert.equal(job.status, 'in_progress'); assert.equal(job.phase, 'unresponsive'); }
  assert.equal(r.state.calls.some(c => c.path === 'reload'), false);
});
test('lost generation reply replays one live pre-intent command and never drains the next job', async t => {
  const { dir } = await unknownJobs(t, 0); const f = await fixture(t, { responseJobsDir: dir, pollingLeaseMs: 5000 }); const r = await runtime(f);
  const probe = (await r.read()).request; await r.event({ type: 'native_ready', requestId: probe.requestId, protocol: 1, ready: true });
  const start = async input => { const reply = await fetch(f.base + '/v1/response-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) }); assert.equal(reply.status, 202, await reply.clone().text()); return reply.json(); };
  const first = await start('first'); r.state.dropReply = true; await assert.rejects(r.read());
  const sent = r.state.calls.findLast(c => c.path === 'poll-v2').data;
  const second = await start('second'); const recovered = await r.read(); assert.equal(recovered.sequence, sent.sequence);
  const firstJob = await (await fetch(f.base + '/v1/response-jobs/' + first.id)).json(); assert.equal(recovered.request.requestId, firstJob.context.requestId);
  await r.event({ type: 'native_intent', requestId: recovered.request.requestId, nativeUserMessageId: recovered.request.nativeUserMessageId });
  assert.equal((await f.json('poll-v2', sent)).request, null, 'intent barrier prevents replay of an already-dispatched native owner');
  const next = await r.read(); const secondJob = await (await fetch(f.base + '/v1/response-jobs/' + second.id)).json(); assert.equal(next.request.requestId, secondJob.context.requestId);
  assert.equal((await f.json('poll-v2', sent)).error, 'stale_poll');
});
test('a delayed old open cannot steal target and BFCache reopens without replaying its retired read', async t => {
  const f = await fixture(t); await f.read(1, { nativeProtocol: 1 });
  await f.json('poll-open', { protocol: 1, streamId: other, activation: 2000 }, 'doc-b');
  await f.json('poll-v2', { protocol: 1, epoch: f.opened.epoch, streamId: other, activation: 2000, sequence: 1 }, 'doc-b');
  const late = await f.json('poll-open', { protocol: 1, streamId: '33333333-3333-4333-8333-333333333333', activation: 1500 }, 'old-first-doc'); assert.equal(late.error, 'inactive_document');
  assert.equal((await f.json('maintenance', { action: 'probe' })).target.documentId, 'doc-b');
  await f.json('poll-open', { protocol: 1, streamId: stream, activation: 3000 });
  assert.equal((await f.read(1, { activation: 1000 })).error, 'inactive_document');
  assert.equal((await f.read(1, { activation: 3000, reconcile: true })).request, null);
  assert.equal((await f.json('maintenance', { action: 'probe' })).target.documentId, 'doc-a');
});
test('maintenance exclusion retires a cached probe without admitting competing work', async t => {
  const f = await fixture(t); await f.read(1, { nativeProtocol: 1 });
  const { target } = await f.json('maintenance', { action: 'probe' });
  const lease = await f.json('maintenance', { action: 'acquire', target }); assert.equal(lease.ready, true);
  assert.equal((await f.read(1)).request, null);
  assert.equal((await fetch(f.base + '/v1/models')).status, 409);
  assert.equal((await f.read(9)).error, 'invalid_sequence');
  assert.equal((await f.json('maintenance', { action: 'validate', target, lease: lease.lease })).ready, true);
});
test('server restart after a lost native command preserves the unknown job and never redelivers it', async t => {
  const { dir } = await unknownJobs(t, 0); const f = await fixture(t, { responseJobsDir: dir, pollingLeaseMs: 5000 }); const r = await runtime(f);
  const probe = (await r.read()).request; await r.event({ type: 'native_ready', requestId: probe.requestId, protocol: 1, ready: true });
  const response = await fetch(f.base + '/v1/response-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'uncertain initial delivery' }) }); const job = await response.json(); assert.equal(response.status, 202);
  r.state.dropReply = true; await assert.rejects(r.read()); const previous = r.state.calls.at(-1).data;
  await f.close(); const restarted = await fixture(t, { responseJobsDir: dir, pollingLeaseMs: 5000 }); r.state.base = restarted.base;
  const next = await r.read(); assert.equal(next.request.type, 'native_readiness'); assert.notEqual(next.epoch, previous.epoch);
  const restored = await (await fetch(restarted.base + '/v1/response-jobs/' + job.id)).json(); assert.equal(restored.status, 'in_progress'); assert.equal(restored.phase, 'unresponsive');
  assert.equal((await restarted.health()).activeGenerations, 1);
  assert.equal((await restarted.json('poll-v2', previous)).error, 'epoch_changed');
});
test('an accepted replacement document must prove native readiness again before new admission', async t => {
  const f = await fixture(t, { pollingLeaseMs: 5000 }); const first = await f.read(1, { nativeProtocol: 1 });
  await f.json('event', { type: 'native_ready', requestId: first.request.requestId, protocol: 1, ready: true });
  assert.equal((await f.health()).nativeReady, true);
  await f.json('poll-open', { protocol: 1, streamId: other, activation: 2000 }, 'doc-b');
  const next = await f.json('poll-v2', { protocol: 1, epoch: f.opened.epoch, streamId: other, activation: 2000, sequence: 1, nativeProtocol: 1 }, 'doc-b');
  assert.equal(next.request?.type, 'native_readiness'); assert.equal((await f.health()).nativeReady, false);
});

for (const protectedCount of [0, 1]) test(`replacement tab polling restores maintenance selection without health calls (${protectedCount} reserved native jobs)`, async t => {
  const { dir, ids } = await unknownJobs(t, protectedCount); const f = await fixture(t, { responseJobsDir: dir });
  await f.read(1); const first = (await f.json('maintenance', { action: 'probe' })).target;
  await f.json('maintenance', { action: 'invalidate', target: first }); await wait(140);
  const postB = async (path, data) => {
    const response = await fetch(f.base + '/bridge/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'key', 'X-Browser-Id': '8:browser-b', 'X-Chrome-Tab-Id': '8', 'X-Chrome-Document-Id': 'doc-b' }, body: JSON.stringify(data) });
    assert.equal(response.status, 200); return response.json();
  };
  const opened = await postB('poll-open', { protocol: 1, streamId: other, activation: 2000 });
  await postB('poll-v2', { protocol: 1, epoch: opened.epoch, streamId: other, activation: 2000, sequence: 1 });
  const selected = await f.json('maintenance', { action: 'probe' });
  assert.deepEqual(selected.target, { browserId: '8:browser-b', tabId: 8, documentId: 'doc-b' }); assert.equal(selected.connected, true);
  assert.equal(selected.deferred, protectedCount ? 'work_in_progress' : null);
  for (const id of ids) { const job = await (await fetch(f.base + '/v1/response-jobs/' + id)).json(); assert.equal(job.status, 'in_progress'); assert.equal(job.phase, 'unresponsive'); }
});
test('SPA URL-only updates preserve the cached live probe and target; loading invalidates both', async t => {
  const f = await fixture(t, { pollingLeaseMs: 5000 }); const first = await f.read(1, { nativeProtocol: 1 });
  const { readFile } = await import('node:fs/promises'); let updated;
  const chrome = { runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    alarms: { get: async () => ({ periodInMinutes: 1 }), create: () => undefined, onAlarm: { addListener() {} } }, storage: { local: {} },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener: fn => updated = fn } } };
  const localFetch = (url, init) => fetch(String(url).replace('http://127.0.0.1:8766', f.base), init);
  new Function('chrome','fetch','importScripts','LOCALGPT_PAIRING_TOKEN', await readFile('dist/extension/background.js','utf8'))(chrome, localFetch, () => {}, 'key');
  updated(7, { url: 'https://chatgpt.com/c/same-document' }); await wait(30);
  assert.equal((await f.json('maintenance', { action: 'probe' })).target?.documentId, 'doc-a');
  assert.deepEqual((await f.read(1)).request, first.request, 'same-document routing cannot retire a live command');
  updated(7, { status: 'loading' }); await wait(30);
  assert.equal((await f.json('maintenance', { action: 'probe' })).target, null);
  assert.equal((await f.read(1)).request, null, 'the replaced document cannot recover a cached command');
});
