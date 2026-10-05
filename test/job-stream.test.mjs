import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const conversationId = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function fixture(t, options = {}) {
  const service = require('../dist/server.cjs').createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 3000, ...options });
  const ports = await service.start(); t.after(() => service.close()); const base = `http://127.0.0.1:${ports.httpPort}`;
  const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`); await once(ws, 'open'); t.after(() => ws.close());
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js'); const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'sse-test', version: '1' }); await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'))); t.after(() => client.close());
  const next = once(ws, 'message'); const waiting = []; ws.on('message', raw => waiting.push(JSON.parse(raw)));
  return { base, ws, client, ports, next, waiting, send: value => ws.send(JSON.stringify(value)) };
}
const nextRequest = async f => { for (let i = 0; i < 100 && !f.waiting.length; i++) await pause(5); return f.waiting[0]; };
const start = async (f, args) => { const result = await f.client.callTool({ name: 'localgpt_response_start', arguments: { input: 'Stream this', ...args } }); const request = JSON.parse((await f.next)[0]); return { job: result.structuredContent, request }; };
test('MCP response_get waits on SSE for at most the bounded interval and returns on completion', async t => {
  const f = await fixture(t); const { job, request } = await start(f); assert.equal(job.object, 'response_job');
  let returned = false; const result = f.client.callTool({ name: 'localgpt_response_get', arguments: { job_id: job.id, wait_ms: 2000 } }).then(r => (returned = true, r)); await pause(40); assert.equal(returned, false);
  f.send({ type: 'answer', requestId: request.requestId, text: 'Pushed completion' }); f.send({ type: 'stop', requestId: request.requestId, conversationId });
  const done = await result; assert.equal(done.structuredContent.status, 'completed'); assert.equal(done.structuredContent.result.output[0].content[0].text, 'Pushed completion');
});
test('MCP response_get rejects waits above 25000ms and wait_ms:0 returns an immediate snapshot', async t => {
  const f = await fixture(t); const { job } = await start(f);
  const over = await f.client.callTool({ name: 'localgpt_response_get', arguments: { job_id: job.id, wait_ms: 25001 } }).catch(e => ({ isError: true, e })); assert.equal(over.isError, true);
  const started = Date.now(); const snapshot = await f.client.callTool({ name: 'localgpt_response_get', arguments: { job_id: job.id, wait_ms: 0 } }); assert.equal(snapshot.structuredContent.status, 'in_progress'); assert.ok(Date.now() - started < 1000);
});
test('MCP response_get after an SSE interruption surfaces a non-resend error and the job remains pending', async t => {
  const f = await fixture(t); const { job } = await start(f); const { waitForResponseJob } = await import('../src/job-stream.ts');
  const stub = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: x\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'x' }) + '\n\n')); setTimeout(() => c.close(), 20); } }), { headers: { 'content-type': 'text/event-stream' } }) }); t.after(() => stub.stop(true));
  await assert.rejects(waitForResponseJob(`http://127.0.0.1:${stub.port}`, job.id, 1000), /job_stream_interrupted.*do not resend/);
  assert.equal((await (await fetch(`${f.base}/v1/response-jobs/${job.id}`)).json()).status, 'in_progress'); assert.equal((await (await fetch(f.base + '/health')).json()).busy, true);
});
test('SSE client rejects a stream for a different job id and non-SSE content', async () => {
  const { waitForResponseJob } = await import('../src/job-stream.ts'); const id = conversationId; const job = { object: 'response_job', id: '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4', status: 'in_progress', phase: 'processing', createdAt: 'a', updatedAt: 'a', lastActivityAt: 'a' };
  const stub = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => new URL(req.url).pathname.includes('json') ? Response.json({}) : new Response('data: ' + JSON.stringify({ type: 'response_job.updated', job }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
  try { await assert.rejects(waitForResponseJob(`http://127.0.0.1:${stub.port}`, id, 100), /job_stream_mismatch`?/); await assert.rejects(waitForResponseJob(`http://127.0.0.1:${stub.port}`, 'json', 100), /invalid_job_stream|uuid|Invalid/i); } finally { stub.stop(true); }
});
test('SSE parser preserves large valid events and split UTF8/CRLF boundaries', async () => {
  const { readSseEvents } = await import('../src/job-stream.ts'); const answer = 'あ'.repeat(2200000); const bytes = new TextEncoder().encode('data: ' + JSON.stringify({ type: 'x', text: answer }) + '\r\n\r\n'); let offset = 0;
  const stream = new ReadableStream({ pull(c) { if (offset >= bytes.length) { c.close(); return; } c.enqueue(bytes.slice(offset, offset + 65537)); offset += 65537; } }); const events = [];
  for await (const event of readSseEvents(new Response(stream))) events.push(event); assert.equal(events.length, 1); assert.equal(events[0].text, answer);
});
test('MCP respond: Pro routing and background:true return a receipt immediately; quick non-Pro waits and returns the completed answer', async t => {
  const f = await fixture(t); const { job } = await start(f); void job; f.send({ type: 'error', requestId: (await nextRequest(f)).requestId, code: 'chatgpt_generation_failed', message: 'x' }); await pause(30);
  const session = (await f.client.callTool({ name: 'localgpt_session_create', arguments: { model: 'gpt-6-pro' } })).structuredContent;
  f.waiting.length = 0; const pro = await f.client.callTool({ name: 'localgpt_respond', arguments: { session_id: session.id, input: 'Pro task' } });
  assert.equal(pro.structuredContent.object, 'response_job'); assert.equal(pro.structuredContent.status, 'in_progress'); f.send({ type: 'error', requestId: (await nextRequest(f)).requestId, code: 'chatgpt_generation_failed', message: 'x' }); await pause(30);
  f.waiting.length = 0; const forced = await f.client.callTool({ name: 'localgpt_respond', arguments: { input: 'Simple', model: 'gpt-6-instant', background: true } }); assert.equal(forced.structuredContent.object, 'response_job');
  f.send({ type: 'error', requestId: (await nextRequest(f)).requestId, code: 'chatgpt_generation_failed', message: 'x' }); await pause(30);
  f.waiting.length = 0; const quick = f.client.callTool({ name: 'localgpt_respond', arguments: { input: 'Quick', model: 'gpt-6-instant' } }); const quickRequest = await nextRequest(f);
  f.send({ type: 'answer', requestId: quickRequest.requestId, text: 'Quick reply' }); f.send({ type: 'stop', requestId: quickRequest.requestId, conversationId }); const done = await quick; assert.equal(done.structuredContent.output[0].content[0].text, 'Quick reply');
});
test('MCP tool surface includes start/get and instructions describe unknown recovery without remote cancel', async t => {
  const f = await fixture(t); const tools = (await f.client.listTools()).tools.map(x => x.name); assert.ok(tools.includes('localgpt_response_start')); assert.ok(tools.includes('localgpt_response_get')); assert.equal(tools.some(n => /cancel|stop/.test(n)), false);
  assert.match(f.client.getInstructions(), /do not resend|never resend|Do not automatically resend/i);
});
