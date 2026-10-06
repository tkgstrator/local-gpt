import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, rm, stat, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const conversationId = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
const pause = ms => new Promise(r => setTimeout(r, ms));
const tempDir = async t => { const dir = await mkdtemp(join(tmpdir(), 'localgpt-jobs-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

async function setup(t, options = {}, browserId = 'tab-main') {
  const service = require('../dist/server.cjs').createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 2000, ...options });
  const ports = await service.start(); t.after(() => service.close());
  const base = `http://127.0.0.1:${ports.httpPort}`;
  const connect = async id => { const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?browserId=${id}`); await once(ws, 'open'); return ws; };
  const ws = await connect(browserId);
  const post = (path, body, signal) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const get = async id => await (await fetch(base + '/v1/response-jobs/' + id)).json();
  const health = async () => await (await fetch(base + '/health')).json();
  const until = async (id, check) => { for (let i = 0; i < 200; i++) { const value = await get(id); if (check(value)) return value; await pause(5); } throw Error('No job state'); };
  const start = async (input = 'Review') => { const next = once(ws, 'message'); const response = await post('/v1/response-jobs', { input }); const job = await response.json(); const request = JSON.parse((await next)[0]); return { response, job, request }; };
  const send = value => ws.send(JSON.stringify(value));
  return { service, ports, base, ws, connect, post, get, health, until, start, send };
}

// --- store ---
test('job store is bounded, expires completed results and never evicts or expires pending jobs', async () => {
  const { createResponseJobStore } = await import('../src/response-jobs.ts'); let now = 1000;
  const jobs = createResponseJobStore({ maxJobs: 2, ttlMs: 100, now: () => now });
  const active = jobs.create(), completed = jobs.create(); assert.throws(() => jobs.create(), /capacity/i);
  jobs.complete(completed.id, { object: 'response', status: 'completed' }); now += 101;
  assert.equal(jobs.get(completed.id), null); assert.equal(jobs.get(active.id).status, 'in_progress'); assert.ok(jobs.create().id);
});
test('job store reports inactivity as unknown, never failure, and recovers on native activity', async () => {
  const { createResponseJobStore } = await import('../src/response-jobs.ts'); let now = 1000;
  const jobs = createResponseJobStore({ now: () => now, idleTimeoutMs: 100 }); const job = jobs.create();
  now += 101; const stalled = jobs.get(job.id); assert.equal(stalled.status, 'in_progress'); assert.equal(stalled.phase, 'unresponsive'); assert.match(stalled.message, /unknown/i);
  jobs.progress(job.id, 'thinking'); assert.equal(jobs.get(job.id).phase, 'thinking'); assert.equal(jobs.get(job.id).message, undefined);
});
test('durable store uses private modes, strips instructions, persists partial text and restores pending as unknown', async t => {
  const dir = await tempDir(t); const { createResponseJobStore } = await import('../src/response-jobs.ts'); let now = 1000;
  const store = createResponseJobStore({ dir, now: () => now, ttlMs: 100 }); const pending = store.create(), done = store.create();
  store.context(pending.id, { requestId: 'r', browserId: 'owner' }); store.answer(pending.id, 'Partial'); store.complete(done.id, { instructions: 'private-instruction-sentinel', output: 'Final' }); store.flush();
  assert.equal(store.get(done.id).result.instructions, 'private-instruction-sentinel');
  const files = await readdir(dir); assert.equal(files.length, 2);
  assert.equal((await stat(dir)).mode & 0o777, 0o700); for (const file of files) assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(dir, done.id + '.json'), 'utf8')).includes('private-instruction-sentinel'), false);
  const restored = createResponseJobStore({ dir, now: () => now, ttlMs: 100 });
  assert.equal(restored.get(done.id).result.output, 'Final'); assert.equal(restored.get(pending.id).status, 'in_progress'); assert.equal(restored.get(pending.id).phase, 'unresponsive');
  assert.match(restored.get(pending.id).message, /resend/i); assert.equal(restored.text(pending.id), 'Partial'); assert.equal(restored.activeCount(), 1);
  now += 101; assert.equal(restored.get(done.id), null); assert.equal((await readdir(dir)).length, 1); assert.equal(restored.get(pending.id).status, 'in_progress');
});
test('durable store flushes the latest partial text even when writes are coalesced', async t => {
  const dir = await tempDir(t); const { createResponseJobStore } = await import('../src/response-jobs.ts');
  const store = createResponseJobStore({ dir }); const job = store.create(); store.answer(job.id, 'one'); store.answer(job.id, 'one two'); store.flush();
  assert.equal(createResponseJobStore({ dir }).text(job.id), 'one two');
});
test('durable store refuses a corrupt or mismatched record instead of dropping a pending job', async t => {
  const dir = await tempDir(t); const { createResponseJobStore } = await import('../src/response-jobs.ts'); const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, conversationId + '.json'), '{broken'); assert.throws(() => createResponseJobStore({ dir }));
});

// --- server ---
test('POST returns 202 immediately, survives client disconnect and holds the global slot', async t => {
  const { post, get, health, until, start, send, base } = await setup(t); const controller = new AbortController();
  const { response, job, request } = await start(); assert.equal(response.status, 202);
  assert.equal(job.object, 'response_job'); assert.equal(job.status, 'in_progress'); assert.equal(job.result, undefined); assert.equal(request.backgroundJob, true); assert.equal(request.timeoutMs, 2000);
  const blocked = await post('/v1/response-jobs', { input: 'Do not switch' }); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error.code, 'browser_busy');
  const poll = await fetch(base + '/v1/response-jobs/' + job.id, { signal: controller.signal }); await poll.json(); controller.abort(); assert.equal((await health()).busy, true);
  send({ type: 'progress', requestId: request.requestId, phase: 'thinking', secret: 'hidden chain of thought' }); const thinking = await until(job.id, j => j.phase === 'thinking'); assert.equal(JSON.stringify(thinking).includes('hidden'), false);
  send({ type: 'progress', requestId: request.requestId, phase: 'unresponsive' }); const stalled = await until(job.id, j => j.phase === 'unresponsive'); assert.equal(stalled.status, 'in_progress'); assert.equal(stalled.lastActivityAt, thinking.lastActivityAt); assert.equal((await health()).busy, true);
  send({ type: 'answer', requestId: request.requestId, text: 'Reviewed' }); send({ type: 'stop', requestId: request.requestId, conversationId });
  const done = await until(job.id, j => j.status === 'completed'); assert.equal(done.result.output[0].content[0].text, 'Reviewed'); assert.equal((await health()).busy, false);
  assert.equal((await get(job.id)).result.id, done.result.id);
});
test('async job outlives a short synchronous deadline and rejects streaming requests', async t => {
  const { post, get, health, start } = await setup(t, { timeoutMs: 60 }); const { job } = await start();
  await pause(150); const pending = await get(job.id); assert.equal(pending.status, 'in_progress'); assert.equal(pending.result, undefined); assert.equal((await health()).busy, true);
  assert.equal((await post('/v1/response-jobs', { input: 'x', stream: true })).status, 400);
});
test('ordinary synchronous responses keep their wall-clock deadline', async t => {
  const { post, ws } = await setup(t, { timeoutMs: 80 }); const next = once(ws, 'message');
  const reply = await post('/v1/responses', { input: 'Quick' }); await next; assert.equal(reply.status, 504);
});
test('browser disconnect keeps partial text and the slot, never resends, and a reconnect can finish the job', async t => {
  const { post, get, health, until, start, ws, ports, base } = await setup(t, { timeoutMs: 60 }, 'owner'); const { job, request } = await start();
  ws.send(JSON.stringify({ type: 'answer', requestId: request.requestId, text: 'Partial answer' })); await until(job.id, j => j.phase === 'answering');
  ws.close(); await once(ws, 'close'); const stalled = await until(job.id, j => j.phase === 'unresponsive'); assert.equal(stalled.status, 'in_progress'); assert.equal((await health()).busy, true);
  assert.equal((await post('/v1/response-jobs', { input: 'Different' })).status, 409);
  const again = new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?browserId=owner`); await once(again, 'open'); const resent = []; again.on('message', raw => resent.push(JSON.parse(raw))); await pause(50); assert.equal(resent.length, 0);
  const text = await (await fetch(`${base}/v1/response-jobs/${job.id}/events?wait_ms=10`)).text(); assert.match(text, /Partial answer/);
  again.send(JSON.stringify({ type: 'answer', requestId: request.requestId, text: 'Recovered answer' })); again.send(JSON.stringify({ type: 'stop', requestId: request.requestId, conversationId }));
  assert.equal((await until(job.id, j => j.status === 'completed')).result.output[0].content[0].text, 'Recovered answer'); assert.equal((await get(job.id)).status, 'completed');
});
test('ambiguous native stream errors preserve the job, partial text and reservation; explicit failure ends it', async t => {
  const { get, health, until, start, send, post } = await setup(t); const { job, request } = await start();
  for (const code of ['response_stream_interrupted', 'observation_response_stream_interrupted', 'unsupported_response_stream', 'browser_timeout']) {
    send({ type: 'answer', requestId: request.requestId, text: 'Partial' }); send({ type: 'error', requestId: request.requestId, code, message: 'Connection lost' }); await pause(30);
    const state = await get(job.id); assert.equal(state.status, 'in_progress', code); assert.equal(state.phase, 'unresponsive', code); assert.equal((await health()).busy, true);
  }
  assert.equal((await post('/v1/response-jobs', { input: 'No duplicate' })).status, 409);
  send({ type: 'error', requestId: request.requestId, code: 'chatgpt_generation_cancelled', message: 'Native task cancelled' });
  const failed = await until(job.id, j => j.status === 'failed'); assert.equal(failed.error.code, 'chatgpt_generation_cancelled'); assert.equal((await health()).busy, false);
});
test('explicit failures before dispatch fail the job and release the slot', async t => {
  const { health, until, start, send } = await setup(t); const { job, request } = await start();
  send({ type: 'error', requestId: request.requestId, code: 'composer_not_empty', message: 'Draft present' }); assert.equal((await until(job.id, j => j.status === 'failed')).error.code, 'composer_not_empty'); assert.equal((await health()).busy, false);
});
test('simultaneous job starts admit exactly once', async t => {
  const { post, ws, send, until } = await setup(t); const requests = []; ws.on('message', raw => requests.push(JSON.parse(raw)));
  const replies = await Promise.all([post('/v1/response-jobs', { input: 'A' }), post('/v1/response-jobs', { input: 'B' })]); assert.deepEqual(replies.map(r => r.status).sort(), [202, 409]);
  await pause(30); assert.equal(requests.length, 1); const job = await replies.find(r => r.status === 202).json();
  send({ type: 'error', requestId: requests[0].requestId, code: 'chatgpt_generation_failed', message: 'x' }); await until(job.id, j => j.status === 'failed');
});
test('events endpoint is bounded to 60000ms, replays state and survives subscriber close', async t => {
  const { base, health, start, send } = await setup(t); const { job, request } = await start();
  for (const wait of ['0', '60001', 'abc']) assert.equal((await fetch(`${base}/v1/response-jobs/${job.id}/events?wait_ms=${wait}`)).status, 400);
  assert.equal((await fetch(`${base}/v1/response-jobs/${conversationId}/events?wait_ms=10`)).status, 404);
  const controller = new AbortController(); const r = await fetch(`${base}/v1/response-jobs/${job.id}/events?wait_ms=60000`, { signal: controller.signal }); assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /response_job.updated/);
  send({ type: 'answer', requestId: request.requestId, text: 'First' }); let text = ''; while (!text.includes('First')) text += new TextDecoder().decode((await reader.read()).value);
  controller.abort(); assert.equal((await health()).busy, true);
  const reconnect = await (await fetch(`${base}/v1/response-jobs/${job.id}/events?wait_ms=20`)).text(); assert.match(reconnect, /First/); assert.match(reconnect, /wait_finished/); assert.match(reconnect, /in_progress/);
  send({ type: 'stop', requestId: request.requestId, conversationId }); const done = await (await fetch(`${base}/v1/response-jobs/${job.id}/events?wait_ms=1000`)).text(); assert.match(done, /completed/); assert.doesNotMatch(done, /wait_finished/);
});
test('websocket observer events are acknowledged only for the admitted request and HTTP events report acceptance', async t => {
  const service = require('../dist/server.cjs').createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 100, bridgeToken: 'ack' }); const ports = await service.start(); t.after(() => service.close());
  const socket = new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?token=ack&browserId=ack-tab`); await once(socket, 'open'); const next = once(socket, 'message');
  await fetch(`http://127.0.0.1:${ports.httpPort}/v1/response-jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'Observe' }) }); const request = JSON.parse((await next)[0]);
  const ack = once(socket, 'message'); socket.send(JSON.stringify({ type: 'answer', requestId: request.requestId, eventId: 'event1', text: 'Observed' })); const received = JSON.parse((await ack)[0]);
  assert.deepEqual([received.type, received.requestId, received.eventId, received.accepted], ['event_ack', request.requestId, 'event1', true]);
  const rejected = once(socket, 'message'); socket.send(JSON.stringify({ type: 'answer', requestId: 'unadmitted', eventId: 'event2', text: 'Unknown' })); assert.equal(JSON.parse((await rejected)[0]).accepted, false);
  const bridge = event => fetch(`http://127.0.0.1:${ports.httpPort}/bridge/event`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'ack', 'X-Browser-Id': 'http-tab' }, body: JSON.stringify(event) });
  assert.equal((await (await bridge({ type: 'answer', requestId: 'unadmitted', text: 'x' })).json()).accepted, false);
});
test('HTTP bridge event reports acceptance for the shared lane owner', async t => {
  const service = require('../dist/server.cjs').createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 1000, bridgeToken: 'http-ack' }); const ports = await service.start(); t.after(() => service.close());
  const base = `http://127.0.0.1:${ports.httpPort}`; const bridge = async (path, body) => (await fetch(`${base}/bridge/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'http-ack', 'X-Browser-Id': 'http-owner' }, body: JSON.stringify(body) })).json();
  await bridge('poll', {}); await fetch(base + '/v1/response-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'Observe' }) });
  let request; for (let i = 0; i < 30 && !request; i++) { request = (await bridge('poll', {})).request; await pause(5); } assert.equal(request.backgroundJob, true);
  assert.equal((await bridge('event', { type: 'answer', requestId: request.requestId, text: 'Seen' })).accepted, true); assert.equal((await bridge('event', { type: 'answer', requestId: 'other', text: 'Seen' })).accepted, false);
});
test('undelivered queued HTTP job fails definitively when the lease expires instead of reserving the slot forever', async t => {
  const service = require('../dist/server.cjs').createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 1000, pollingLeaseMs: 40, bridgeToken: 'lease' }); const ports = await service.start(); t.after(() => service.close());
  const base = `http://127.0.0.1:${ports.httpPort}`; await fetch(`${base}/bridge/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'lease', 'X-Browser-Id': 'gone' }, body: '{}' });
  const job = await (await fetch(base + '/v1/response-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'Never delivered' }) })).json();
  let state; for (let i = 0; i < 100; i++) { state = await (await fetch(`${base}/v1/response-jobs/${job.id}`)).json(); if (state.status === 'failed') break; await pause(10); }
  assert.equal(state.status, 'failed'); assert.equal(state.error.code, 'browser_undelivered'); assert.equal((await (await fetch(base + '/health')).json()).busy, false);
});
test('restarted service reserves the browser slot for restored unknown work and serves terminal records', async t => {
  const dir = await tempDir(t); const { createResponseJobStore } = await import('../src/response-jobs.ts'); const stored = createResponseJobStore({ dir });
  const pending = stored.create(), done = stored.create(); stored.context(pending.id, { requestId: 'r', browserId: 'owner' }); stored.answer(pending.id, 'Partial result'); stored.complete(done.id, { output: 'Final' }); stored.flush();
  const { base, post, ws } = await setup(t, { responseJobsDir: dir }); const messages = []; ws.on('message', raw => messages.push(raw));
  assert.equal((await (await fetch(base + '/health')).json()).busy, true); assert.equal((await (await fetch(base + '/v1/response-jobs/' + done.id)).json()).result.output, 'Final');
  const current = await (await fetch(base + '/v1/response-jobs/' + pending.id)).json(); assert.equal(current.status, 'in_progress'); assert.equal(current.phase, 'unresponsive'); assert.equal(current.context.browserId, 'owner');
  assert.match(await (await fetch(`${base}/v1/response-jobs/${pending.id}/events?wait_ms=10`)).text(), /Partial result/);
  for (const path of ['/v1/response-jobs', '/v1/responses', '/v1/chat/completions']) { const r = await post(path, path === '/v1/chat/completions' ? { messages: [{ role: 'user', content: 'x' }] } : { input: 'Do not duplicate' }); assert.equal(r.status, 409, path); }
  assert.equal((await fetch(base + '/v1/models')).status, 409); await pause(30); assert.equal(messages.length, 0);
});
test('private job records are written under the configured directory only and omit prompts', async t => {
  const dir = await tempDir(t); const { start, send, until } = await setup(t, { responseJobsDir: dir }); const { job, request } = await start('prompt-sentinel-text');
  send({ type: 'answer', requestId: request.requestId, text: 'Answer text' }); await until(job.id, j => j.phase === 'answering'); await pause(20);
  const record = await readFile(join(dir, job.id + '.json'), 'utf8'); assert.equal(record.includes('prompt-sentinel-text'), false); assert.equal((await stat(join(dir, job.id + '.json'))).mode & 0o777, 0o600);
});

test('storage failure before creation leaves no ghost job and recovers capacity', async t => {
  const dir = await tempDir(t);
  const { writeFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { createResponseJobStore } = await import('../src/response-jobs.ts');
  const store = createResponseJobStore({ dir, maxJobs: 1 });
  rmSync(dir, { recursive: true }); writeFileSync(dir, 'blocked');
  assert.throws(() => store.create(), e => e.code === 'response_job_storage_unavailable');
  assert.equal(store.activeCount(), 0);
  rmSync(dir); mkdirSync(dir);
  assert.equal(store.create().status, 'in_progress');
});

test('admitted storage failures keep progress and results, notify readers, and flush the latest state after recovery', async t => {
  const dir = await tempDir(t);
  const { writeFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { createResponseJobStore } = await import('../src/response-jobs.ts');
  const store = createResponseJobStore({ dir });
  const pending = store.create(), completed = store.create();
  const events = []; store.subscribe(completed.id, event => events.push(event));
  rmSync(dir, { recursive: true }); writeFileSync(dir, 'blocked');
  assert.doesNotThrow(() => store.context(pending.id, { requestId: 'r', browserId: 'owner' }));
  assert.doesNotThrow(() => store.progress(pending.id, 'thinking'));
  store.answer(pending.id, 'Partial retained');
  assert.doesNotThrow(() => store.complete(completed.id, { output: 'Final retained', instructions: 'private-instructions' }));
  assert.doesNotThrow(() => store.flush());
  assert.equal(store.get(pending.id).status, 'in_progress');
  assert.equal(store.get(pending.id).persistenceError.code, 'response_job_storage_unavailable');
  assert.equal(store.get(completed.id).status, 'completed');
  assert.equal(store.get(completed.id).result.output, 'Final retained');
  assert.equal(events.at(-1).job.persistenceError.code, 'response_job_storage_unavailable');
  rmSync(dir); mkdirSync(dir);
  store.flush();
  assert.equal(store.get(completed.id).persistenceError, undefined);
  assert.equal(events.at(-1).job.persistenceError, undefined);
  const restarted = createResponseJobStore({ dir });
  assert.equal(restarted.text(pending.id), 'Partial retained');
  assert.equal(restarted.get(completed.id).result.output, 'Final retained');
  assert.equal(restarted.get(completed.id).result.instructions, null);
  assert.equal(store.get(completed.id).result.instructions, 'private-instructions');
});

test('initial HTTP storage failure reports storage rather than capacity and never dispatches', async t => {
  const dir = await tempDir(t);
  const { writeFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { post, ws, health, start } = await setup(t, { responseJobsDir: dir });
  const dispatched = []; ws.on('message', raw => dispatched.push(raw));
  rmSync(dir, { recursive: true }); writeFileSync(dir, 'blocked');
  const rejected = await post('/v1/response-jobs', { input: 'Do not dispatch' });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.code, 'response_job_storage_unavailable');
  assert.equal((await health()).busy, false);
  await pause(20); assert.equal(dispatched.length, 0);
  rmSync(dir); mkdirSync(dir);
  assert.equal((await start()).response.status, 202);
});

test('HTTP readers stay alive and expose completed results when storage fails after admission', async t => {
  const dir = await tempDir(t);
  const { writeFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { start, send, until, get, base, health } = await setup(t, { responseJobsDir: dir });
  const { job, request } = await start();
  rmSync(dir, { recursive: true }); writeFileSync(dir, 'blocked');
  send({ type: 'progress', requestId: request.requestId, phase: 'thinking' });
  const thinking = await until(job.id, j => j.phase === 'thinking');
  assert.equal(thinking.persistenceError.code, 'response_job_storage_unavailable');
  send({ type: 'answer', requestId: request.requestId, text: 'Recovered answer' });
  send({ type: 'stop', requestId: request.requestId, conversationId });
  const done = await until(job.id, j => j.status === 'completed');
  assert.equal(done.result.output[0].content[0].text, 'Recovered answer');
  assert.equal(done.persistenceError.code, 'response_job_storage_unavailable');
  assert.match(await (await fetch(`${base}/v1/response-jobs/${job.id}/events?wait_ms=10`)).text(), /response_job_storage_unavailable/);
  assert.equal((await health()).busy, false);
  rmSync(dir); mkdirSync(dir);
  await until(job.id, j => !j.persistenceError);
  assert.equal((await get(job.id)).result.output[0].content[0].text, 'Recovered answer');
});

test('oversized durable result warns without losing the in-memory result or failing remote generation', async t => {
  const dir = await tempDir(t);
  const { createResponseJobStore } = await import('../src/response-jobs.ts');
  const store = createResponseJobStore({ dir, maxRecordBytes: 1024 }); t.after(() => store.close());
  const job = store.create();
  const output = 'x'.repeat(2048);
  assert.doesNotThrow(() => store.complete(job.id, { output }));
  assert.equal(store.get(job.id).status, 'completed');
  assert.equal(store.get(job.id).result.output, output);
  assert.equal(store.get(job.id).persistenceError.code, 'response_job_storage_unavailable');
  assert.equal(createResponseJobStore({ dir }).get(job.id).status, 'in_progress');
  assert.equal((await readdir(dir)).some(file => file.endsWith('.tmp')), false);
});

test('failed expiry cleanup cannot break readers and retries deletion after storage recovery', async t => {
  const dir = await tempDir(t);
  const { writeFileSync, rmSync, mkdirSync } = await import('node:fs');
  const { createResponseJobStore } = await import('../src/response-jobs.ts'); let now = 1000;
  const store = createResponseJobStore({ dir, ttlMs: 10, now: () => now });
  const job = store.create(); store.complete(job.id, { output: 'finished' });
  rmSync(dir, { recursive: true }); writeFileSync(dir, 'blocked'); now += 20;
  assert.equal(store.get(job.id), null);
  assert.equal(store.activeCount(), 0);
  rmSync(dir); mkdirSync(dir);
  writeFileSync(join(dir, job.id + '.json'), JSON.stringify({ job: { ...job, status: 'completed', phase: 'completed' }, text: '' }));
  assert.doesNotThrow(() => store.flush());
  assert.deepEqual(await readdir(dir), []);
});

test('unchanged answer phase batches disk writes and preserves newest activity while real phases persist immediately', async t => {
  const dir = await tempDir(t); const { createResponseJobStore } = await import('../src/response-jobs.ts'); let now=1000;
  const store=createResponseJobStore({dir, now:()=>now});t.after(()=>store.close());const job=store.create(),file=join(dir,job.id+'.json');
  now=1100;store.progress(job.id,'answering');const before=await readFile(file,'utf8');const updates=[];store.subscribe(job.id,event=>updates.push(event));
  for(let i=0;i<20;i++){now++;store.answer(job.id,'x'.repeat(i+1));store.progress(job.id,'answering');}
  assert.equal(await readFile(file,'utf8'),before,'per-token unchanged phase must not write the full record');
  assert.equal(store.get(job.id).lastActivityAt,new Date(now).toISOString());assert.equal(updates.filter(e=>e.type==='response_job.updated').length,0);
  store.flush();const latest=JSON.parse(await readFile(file,'utf8'));assert.equal(latest.text,'x'.repeat(20));assert.equal(latest.job.lastActivityAt,new Date(now).toISOString());
  now++;store.progress(job.id,'thinking');assert.equal(JSON.parse(await readFile(file,'utf8')).job.phase,'thinking');
  store.answer(job.id,'last text');store.complete(job.id,{object:'response',status:'completed',answer:'Final'});assert.equal(JSON.parse(await readFile(file,'utf8')).job.status,'completed');
});
test('repeated unknown progress is not new activity and produces no writes or duplicate status notifications',async t=>{
  const dir=await tempDir(t);const{createResponseJobStore}=await import('../src/response-jobs.ts');let now=1000;const store=createResponseJobStore({dir,now:()=>now});t.after(()=>store.close());const job=store.create(),file=join(dir,job.id+'.json');
  now=2000;store.progress(job.id,'unresponsive');const first=store.get(job.id),saved=await readFile(file,'utf8'),updates=[];store.subscribe(job.id,event=>updates.push(event));
  for(let i=0;i<20;i++){now++;store.progress(job.id,'unresponsive');}
  assert.equal(await readFile(file,'utf8'),saved);assert.deepEqual(store.get(job.id),first);assert.equal(updates.length,0);
});

test('MCP automatically starts Pro session jobs and returns saved original pixels on completed polling', async t => {
  const dir = await tempDir(t); const { base, ws, send, until } = await setup(t, { imagesDir: dir });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'job-test', version: '1' }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes('localgpt_response_start')); assert.ok(tools.includes('localgpt_response_get'));
  const created = await client.callTool({ name: 'localgpt_session_create', arguments: { model: 'gpt-6-pro', projectName: null } });
  const next = once(ws, 'message');
  const started = await client.callTool({ name: 'localgpt_respond', arguments: { session_id: created.structuredContent.id, input: 'Generate a tiny image' } });
  assert.notEqual(started.isError, true); assert.equal(started.structuredContent.object, 'response_job'); assert.equal(started.structuredContent.status, 'in_progress'); assert.equal(started.content.some(content => content.type === 'image'), false);
  const request = JSON.parse((await next)[0]);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  send({ type: 'image', requestId: request.requestId, conversationId, fileId: 'file_generated', imageData: { mimeType: 'image/png', data: png } });
  send({ type: 'stop', requestId: request.requestId, conversationId });
  await until(started.structuredContent.id, job => job.status === 'completed');
  const completed = await client.callTool({ name: 'localgpt_response_get', arguments: { job_id: started.structuredContent.id } });
  assert.notEqual(completed.isError, true); assert.equal(completed.structuredContent.status, 'completed'); assert.equal(completed.content.find(content => content.type === 'image').data, png); assert.match(completed.structuredContent.result.images[0].path, /\.png$/);
  const again = once(ws, 'message');
  const forced = await client.callTool({ name: 'localgpt_respond', arguments: { input: 'Simple task', model: 'gpt-6-instant', background: true } });
  assert.equal(forced.structuredContent.object, 'response_job');
  const forcedRequest = JSON.parse((await again)[0]);
  send({ type: 'error', requestId: forcedRequest.requestId, code: 'chatgpt_generation_failed', message: 'Native stream stopped.' });
  await until(forced.structuredContent.id, job => job.status === 'failed');
});
