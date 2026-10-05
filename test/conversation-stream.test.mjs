import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const id = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3', user = 'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f', assistant = '094c6dd5-45d0-4da3-bd50-a79ef778addb';
const frame = (v, event = 'delta') => `event: ${event}\r\ndata: ${JSON.stringify(v)}\r\n\r\n`;
const message = (channel = 'final', role = 'assistant', recipient = 'all') => ({ id: assistant, author: { role }, channel, recipient, content: { content_type: 'text', parts: [''] }, status: 'in_progress', end_turn: false });
const root = m => ({ p: '', o: 'add', v: { message: m, conversation_id: id, error: null }, c: 0 });
const finish = { p: '', o: 'patch', v: [{ p: '/message/status', o: 'replace', v: 'finished_successfully' }, { p: '/message/end_turn', o: 'replace', v: true }] };
const pause = ms => new Promise(r => setTimeout(r, ms));
async function observe(body, status = 200, options) {
  const { observeConversationResponse } = require('../dist/conversation-stream.cjs'); const events = []; const bytes = new TextEncoder().encode(body); let n = 0;
  const response = new Response(new ReadableStream({ pull(c) { if (n === bytes.length) c.close(); else c.enqueue(bytes.slice(n, n += Math.min(3, bytes.length - n))); } }), { status, headers: { 'content-type': 'text/event-stream' } });
  await observeConversationResponse(response, { requestId: 'job', messageId: user, conversationId: null }, e => events.push(e), options); return events;
}
test('SSE v1 reconstructs split UTF8, inherited deltas and batch patches with explicit completion', async () => {
  const e = await observe(frame('v1', 'delta_encoding') + frame(root(message())) + frame({ p: '/message/content/parts/0', o: 'append', v: '日本' }) + frame({ v: '語' }) + frame(finish) + 'data: [DONE]\r\n\r\n');
  assert.deepEqual(e.filter(x => x.kind === 'answer').map(x => x.text), ['日本', '日本語']); assert.equal(e.at(-1).kind, 'stop'); assert.equal(e.at(-1).conversationId, id); assert.equal(e.at(-1).messageId, user);
});
test('hidden thinking, tool and system messages never become response text', async () => {
  for (const m of [message('analysis'), message('final', 'tool'), message('final', 'assistant', 'python'), { ...message(), metadata: { is_visually_hidden_from_conversation: true } }]) {
    const e = await observe(frame(root(m)) + frame({ p: '/message/content/parts/0', o: 'append', v: 'private' }) + frame(finish) + 'data: [DONE]\n\n'); assert.equal(e.some(x => x.kind === 'answer'), false); assert.equal(e.at(-1).kind, 'error');
  }
});
test('truncated streams, API errors, unknown encoding and HTTP errors never report completion', async () => {
  const inputs = [frame(root(message())) + frame({ p: '/message/content/parts/0', o: 'append', v: 'partial' }), frame({ error: { message: 'secret', code: 'failed' } }, 'message'), frame('v2', 'delta_encoding'), frame(root(message())) + 'data: [DONE]\n\n'];
  for (const body of inputs) { const e = await observe(body); assert.equal(e.at(-1).kind, 'error'); assert.equal(e.some(x => x.kind === 'stop'), false); assert.equal(JSON.stringify(e).includes('secret'), false); }
  assert.equal((await observe('', 429)).at(-1).code, 'chatgpt_http_error');
});
test('prototype-changing paths fail safely without mutating global objects', async () => { const e = await observe(frame(root(message())) + frame({ p: '/__proto__/polluted', o: 'add', v: true })); assert.equal(e.at(-1).kind, 'error'); assert.equal({}.polluted, undefined); });
test('native reasoning progress exposes phase without leaking thinking text', async () => {
  const reasoning = { ...message('analysis'), content: { content_type: 'text', parts: ['Private reasoning never export'] } }, final = { ...message('final'), content: { content_type: 'text', parts: ['Final only'] }, status: 'finished_successfully', end_turn: true };
  const events = await observe(frame(root(reasoning)) + frame(root(final)) + 'data: [DONE]\n\n'); assert.ok(events.some(e => e.kind === 'progress' && e.phase === 'thinking')); assert.ok(events.some(e => e.kind === 'progress' && e.phase === 'answering')); assert.equal(JSON.stringify(events).includes('Private reasoning'), false); assert.equal(events.at(-1).kind, 'stop');
});
test('explicit native failed and cancelled statuses are distinct from silence and timeouts', async () => {
  for (const [status, code] of [['cancelled', 'chatgpt_generation_cancelled'], ['failed', 'chatgpt_generation_failed']]) { const e = await observe(frame(root({ ...message('analysis'), status })) + 'data: [DONE]\n\n'); assert.equal(e.at(-1).kind, 'error'); assert.equal(e.at(-1).code, code); }
});
test('idle native stream becomes unresponsive without ending, and recovers on activity', async () => {
  const { observeConversationResponse } = await import('../src/conversation-stream.ts'); let controller; const events = [];
  const response = new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } });
  const observing = observeConversationResponse(response, { requestId: 'idle', messageId: user, conversationId: null }, e => events.push(e), { timeoutMs: 300, idleTimeoutMs: 20 });
  controller.enqueue(new TextEncoder().encode(frame(root(message('analysis'))))); await pause(50); assert.ok(events.some(e => e.kind === 'progress' && e.phase === 'unresponsive')); assert.equal(events.some(e => e.kind === 'error'), false);
  controller.enqueue(new TextEncoder().encode(frame(root({ ...message(), content: { content_type: 'text', parts: ['Recovered'] }, status: 'finished_successfully', end_turn: true })) + 'data: [DONE]\n\n')); controller.close(); await observing; assert.equal(events.at(-1).kind, 'stop');
});
test('background observation has no wall deadline; a synchronous observation does', async () => {
  const { observeConversationResponse } = await import('../src/conversation-stream.ts'); const run = async backgroundJob => { let controller; const events = []; const response = new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'text/event-stream' } });
    const observing = observeConversationResponse(response, { requestId: 'r', messageId: user, conversationId: id }, e => events.push(e), { backgroundJob, timeoutMs: 20, idleTimeoutMs: 1000 }); await pause(60); const timedOut = events.some(e => e.kind === 'error' && e.code === 'response_stream_timeout');
    try { controller.enqueue(new TextEncoder().encode(frame(root({ ...message(), content: { content_type: 'text', parts: ['Late'] }, status: 'finished_successfully', end_turn: true })) + 'data: [DONE]\n\n')); controller.close(); } catch {} await observing; return { timedOut, events }; };
  const background = await run(true); assert.equal(background.timedOut, false); assert.equal(background.events.at(-1).kind, 'stop'); assert.equal((await run(false)).timedOut, true);
});
test('arm schema and stream events carry no project or image fields', async () => {
  const { StreamArmSchema, StreamEventSchema } = await import('../src/conversation-stream.ts'); assert.equal(StreamArmSchema.safeParse({ requestId: 'r', text: 't', projectId: 'p' }).success, false); assert.equal(StreamEventSchema.safeParse({ requestId: 'r', messageId: user, conversationId: null, kind: 'image' }).success, false);
});
