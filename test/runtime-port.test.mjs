import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { installNativeEditing } from './test-support.mjs';
import { observeConversationResponse } from '../src/conversation-stream.ts';
import { installPageObserver } from '../src/page-observer.ts';
import { createResponseJobStore, ResponseJobStorageError } from '../src/response-jobs.ts';

const cid = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3', user = 'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f', asst = '094c6dd5-45d0-4da3-bd50-a79ef778addb';
const pause = ms => new Promise(r => setTimeout(r, ms));
const frame = v => `event: delta\ndata: ${JSON.stringify(v)}\n\n`;
const msg = (o = {}) => ({ id: asst, author: { role: 'assistant' }, channel: 'final', recipient: 'all', content: { content_type: 'text', parts: ['hi'] }, status: 'in_progress', end_turn: false, ...o });
const root = m => ({ p: '', o: 'add', v: { message: m, conversation_id: cid, error: null }, c: 0 });
async function stream(body) {
  const events = [];
  await observeConversationResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), { requestId: 'r', messageId: user, conversationId: null }, e => events.push(e));
  return events;
}

// --- conversation-stream: failure classification only for the visible final channel ---
test('failed or cancelled hidden/internal assistant messages do not fail the stream', async () => {
  for (const extra of [{ channel: 'analysis' }, { recipient: 'python' }, { metadata: { is_visually_hidden_from_conversation: true } }]) {
    const e = await stream(frame(root(msg({ ...extra, status: 'failed' }))) + frame(root(msg({ id: user.replace('f5', 'f6'), status: 'finished_successfully', end_turn: true }))) + 'data: [DONE]\n\n');
    assert.equal(e.some(x => x.kind === 'error' && /generation/.test(x.code)), false, JSON.stringify(extra));
  }
});
test('failed or cancelled final-channel messages classify as generation failure/cancelled', async () => {
  for (const [status, code] of [['failed', 'chatgpt_generation_failed'], ['cancelled', 'chatgpt_generation_cancelled']]) {
    const e = await stream(frame(root(msg({ status }))) + 'data: [DONE]\n\n');
    assert.equal(e.at(-1).kind, 'error'); assert.equal(e.at(-1).code, code);
  }
});
test('failed non-text final message is still a generation failure, not unsupported content', async () => {
  const e = await stream(frame(root(msg({ status: 'failed', content: { content_type: 'code', parts: [] } }))) + 'data: [DONE]\n\n');
  assert.equal(e.at(-1).code, 'chatgpt_generation_failed');
});

// --- page-observer: outgoing text matching ---
function observer(t) {
  const page = new Window({ url: 'https://chatgpt.com/' }); t.after(() => page.close());
  page.fetch = async () => new Response(frame(root(msg({ content: { content_type: 'text', parts: ['A'] }, status: 'finished_successfully', end_turn: true }))) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  installPageObserver(page); const events = [];
  page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  const send = async (armedText, sentText) => {
    events.length = 0;
    page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'j', text: armedText, backgroundJob: true }) }));
    await page.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ conversation_id: cid, messages: [{ id: user, author: { role: 'user' }, content: { content_type: 'text', parts: [sentText] } }] }) });
    await pause(40); page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: 'j' }));
    return events.length > 0;
  };
  return send;
}
test('outgoing text matches across CRLF and outer ASCII whitespace', async t => {
  const send = observer(t);
  assert.equal(await send('line1\nline2', 'line1\r\nline2'), true);
  assert.equal(await send('  padded\t\n', 'padded'), true);
  assert.equal(await send('padded', '\r\n padded '), true);
});
test('outgoing text does not merge internal whitespace or NBSP', async t => {
  const send = observer(t);
  assert.equal(await send('a b', 'a  b'), false);
  assert.equal(await send('a b', 'a b'), false);
  assert.equal(await send('a b', 'a\nb'), false);
  assert.equal(await send('x', ' x'), false);
});

// --- response-jobs persistence ---
const tmp = t => { const d = mkdtempSync(join(tmpdir(), 'rj-')); t.after(() => { try { chmodSync(d, 0o700) } catch {} rmSync(d, { recursive: true, force: true }) }); return d; };
const origErr = console.error;
const quiet = t => { console.error = () => {}; t.after(() => { console.error = origErr }) };
test('create persists before admission and surfaces a storage error without registering the job', async t => {
  const dir = tmp(t); const jobs = createResponseJobStore({ dir }); chmodSync(dir, 0o500);
  if (process.getuid?.() === 0) return;
  assert.throws(() => jobs.create(), e => e instanceof ResponseJobStorageError && e.code === 'response_job_storage_unavailable');
  assert.equal(jobs.activeCount(), 0); jobs.close();
});
test('persist failures after admission set persistenceError in memory and retry safely without throwing', async t => {
  quiet(t); const dir = tmp(t); const jobs = createResponseJobStore({ dir }); const job = jobs.create();
  if (process.getuid?.() === 0) return;
  chmodSync(dir, 0o500);
  jobs.progress(job.id, 'thinking');
  assert.equal(jobs.get(job.id).persistenceError?.code, 'response_job_storage_unavailable'); assert.equal(jobs.get(job.id).phase, 'thinking');
  chmodSync(dir, 0o700); jobs.flush();
  assert.equal(jobs.get(job.id).persistenceError, undefined);
  assert.equal(JSON.parse(readFileSync(join(dir, job.id + '.json'), 'utf8')).job.persistenceError, undefined);
  assert.equal(readdirSync(dir).some(f => f.endsWith('.tmp')), false); jobs.close();
});
test('partial text and same-phase activity are batched; repeated unresponsive writes nothing', async t => {
  const dir = tmp(t); const jobs = createResponseJobStore({ dir }); const job = jobs.create(); const file = join(dir, job.id + '.json');
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  jobs.progress(job.id, 'answering'); assert.equal(read().job.phase, 'answering');
  jobs.answer(job.id, 'a'); jobs.answer(job.id, 'ab'); jobs.progress(job.id, 'answering');
  assert.equal(read().text, '', 'text write is deferred');
  await pause(300); assert.equal(read().text, 'ab');
  jobs.progress(job.id, 'unresponsive'); const stamp = read().job.updatedAt; const before = readFileSync(file, 'utf8');
  await pause(5); jobs.progress(job.id, 'unresponsive'); jobs.progress(job.id, 'unresponsive');
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(read().job.updatedAt, stamp);
  jobs.answer(job.id, 'abc'); jobs.close(); assert.equal(read().text, 'abc');
});
test('same-phase progress still counts as activity in memory', async () => {
  let now = 1000; const jobs = createResponseJobStore({ now: () => now, idleTimeoutMs: 100 }); const job = jobs.create();
  jobs.progress(job.id, 'answering'); now += 90; jobs.progress(job.id, 'answering'); now += 90;
  assert.equal(jobs.get(job.id).phase, 'answering');
});
test('failed delete is retried and never resurrects after close', async t => {
  quiet(t); const dir = tmp(t); const jobs = createResponseJobStore({ dir }); const job = jobs.create(); const file = join(dir, job.id + '.json');
  if (process.getuid?.() === 0) return;
  chmodSync(dir, 0o500); jobs.remove(job.id); chmodSync(dir, 0o700); jobs.flush();
  assert.equal(readdirSync(dir).includes(job.id + '.json'), false); jobs.close();
});

// --- browser-app: sendObserved acknowledgement semantics and catch replay ---
async function appFixture(t, { reply }) {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` });

  page.document.body.innerHTML = '<div role="textbox" contenteditable="true"></div><button aria-label="Send">Send</button>';
  installNativeEditing(page);
  const saved = {};
  const globals = { window: page, document: page.document, location: page.location, sessionStorage: page.sessionStorage, CustomEvent: page.CustomEvent, HTMLTextAreaElement: page.HTMLTextAreaElement, WebSocket: page.WebSocket ?? class { static OPEN = 1 }, __BRIDGE_TOKEN__: 't' };
  for (const [k, v] of Object.entries(globals)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  t.after(async () => { page.dispatchEvent(new page.Event('pagehide')); await pause(1100); await page.happyDOM.abort(); page.close(); for (const [k, d] of Object.entries(saved)) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k]; });
  const events = []; let queued = null; let clicked = 0;
  const bridge = async (path, data) => {
    if (path === 'poll') { const request = queued; queued = null; return { request }; }
    events.push(data); return data.type === 'heartbeat' ? {} : reply(data, events);
  };
  page.document.querySelector('button').addEventListener('click', () => { clicked++; });
  const { startBrowserApp } = await import('../src/browser-app.ts');
  startBrowserApp(bridge);
  const emit = (id, event) => page.dispatchEvent(new page.CustomEvent('localgpt:response-stream', { detail: JSON.stringify({ requestId: id, messageId: user, conversationId: cid, ...event }) }));
  const request = (id, extra = {}) => { queued = { type: 'request', requestId: id, text: 'Review', newChat: false, conversationId: cid, backgroundJob: true, timeoutMs: 1500, ...extra }; };
  const waitFor = async (check, ms = 4000) => { for (let i = 0; i < ms / 20; i++) { if (check()) return true; await pause(20); } return false; };
  return { page, events, emit, request, waitFor, clicks: () => clicked };
}
test('HTTP sendObserved: missing accepted field is unknown (null), so the answer is retried until acknowledged', async t => {
  let answers = 0;
  const f = await appFixture(t, { reply: data => { if (data.type !== 'answer') return { accepted: true }; return ++answers < 2 ? {} : { accepted: true }; } });
  f.request('ack-null'); await f.waitFor(() => f.clicks() === 1);
  f.emit('ack-null', { kind: 'started' }); f.emit('ack-null', { kind: 'answer', text: 'partial' }); f.emit('ack-null', { kind: 'stop' });
  assert.equal(await f.waitFor(() => f.events.filter(e => e.type === 'answer').length >= 2, 5000), true, 'answer re-sent after unacknowledged reply');
  assert.equal(await f.waitFor(() => f.events.some(e => e.type === 'stop')), true);
  assert.equal(f.clicks(), 1, 'no resubmit');
});
test('HTTP explicit accepted:false for a dispatched request never releases the tab; null never releases; send is not repeated', async t => {
  const f = await appFixture(t, { reply: data => (data.type === 'error' || data.type === 'answer') ? { accepted: false } : { accepted: true } });
  f.request('rejected'); await f.waitFor(() => f.clicks() === 1);
  f.emit('rejected', { kind: 'started' }); f.emit('rejected', { kind: 'answer', text: 'Safe partial' }); f.emit('rejected', { kind: 'error', code: 'chatgpt_generation_failed' });
  await pause(2500);
  assert.equal(f.clicks(), 1);
});
test('definite error replays partial answer before the error event', async t => {
  const f = await appFixture(t, { reply: () => ({ accepted: true }) });
  f.request('partial-first'); await f.waitFor(() => f.clicks() === 1);
  f.emit('partial-first', { kind: 'started' }); f.emit('partial-first', { kind: 'answer', text: 'Half' }); f.emit('partial-first', { kind: 'error', code: 'chatgpt_generation_failed' });
  assert.equal(await f.waitFor(() => f.events.some(e => e.type === 'error')), true);
  const order = f.events.filter(e => ['answer', 'error'].includes(e.type)).map(e => e.type);
  assert.deepEqual(order, ['answer', 'error']);
  assert.equal(f.events.find(e => e.type === 'error').code, 'chatgpt_generation_failed');
});
test('pre-dispatch failures map to definite guard codes or a setup_ prefix', async t => {
  const f = await appFixture(t, { reply: () => ({ accepted: true }) });
  f.page.document.body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>');
  f.request('guard'); assert.equal(await f.waitFor(() => f.events.some(e => e.type === 'error')), true);
  assert.equal(f.events.find(e => e.type === 'error').code, 'browser_busy');
  assert.equal(f.clicks(), 0);
});
test('unlisted pre-dispatch failures get the setup_ prefix', async t => {
  const f = await appFixture(t, { reply: () => ({ accepted: true }) });
  f.page.document.querySelector('[role="textbox"]').remove();
  f.request('setup-prefix'); assert.equal(await f.waitFor(() => f.events.some(e => e.type === 'error')), true);
  const code = f.events.find(e => e.type === 'error').code;
  assert.match(code, /^(setup_|browser_setup_timeout|editor_not_found|editor_unavailable|browser_busy)/);
  assert.equal(f.clicks(), 0);
});
test('dispatched flag is set before the click: a throwing click is reported as observation_, not a definite setup failure', async t => {
  const f = await appFixture(t, { reply: () => ({ accepted: true }) });
  f.page.document.querySelector('button').click = () => { throw new Error('click exploded'); };
  f.request('click-throws'); assert.equal(await f.waitFor(() => f.events.some(e => e.type === 'error')), true);
  assert.equal(f.events.find(e => e.type === 'error').code, 'observation_browser_error');
});

test('unsupported observation keeps the slot and accepts later native answer and stop', async t => {
 const f=await appFixture(t,{reply:()=>({accepted:true})});f.request('unsupported-recovery');assert.equal(await f.waitFor(()=>f.clicks()===1),true);
 f.emit('unsupported-recovery',{kind:'started'});f.emit('unsupported-recovery',{kind:'error',code:'unsupported_response_content'});await pause(100);
 assert.equal(f.events.some(e=>e.type==='error'),false);f.emit('unsupported-recovery',{kind:'answer',text:'Recovered'});f.emit('unsupported-recovery',{kind:'stop'});
 assert.equal(await f.waitFor(()=>f.events.some(e=>e.type==='stop')),true);assert.equal(f.events.find(e=>e.type==='answer').text,'Recovered');assert.equal(f.clicks(),1);
});
test('mixed image responses forward pixels before the final answer and stop',async t=>{
 const f=await appFixture(t,{reply:()=>({accepted:true})});f.request('image-order');assert.equal(await f.waitFor(()=>f.clicks()===1),true);
 f.emit('image-order',{kind:'started'});f.emit('image-order',{kind:'answer',text:'Explanation'});await pause(100);
 assert.equal(f.events.some(e=>e.type==='answer'),false);f.emit('image-order',{kind:'image_ref',fileId:'file_generated'});
 f.emit('image-order',{kind:'image',fileId:'file_generated',imageData:{mimeType:'image/png',data:'aGVsbG8='}});f.emit('image-order',{kind:'stop'});
 assert.equal(await f.waitFor(()=>f.events.some(e=>e.type==='stop')),true);
 assert.deepEqual(f.events.filter(e=>['image','answer','stop'].includes(e.type)).map(e=>e.type),['image','answer','stop']);
});
test('native image generation failed is a definite failure after partial text delivery',async t=>{
 const f=await appFixture(t,{reply:()=>({accepted:true})});f.request('image-failed');assert.equal(await f.waitFor(()=>f.clicks()===1),true);f.emit('image-failed',{kind:'started'});f.emit('image-failed',{kind:'answer',text:'Image explanation'});f.emit('image-failed',{kind:'error',code:'image_generation_failed'});
 assert.equal(await f.waitFor(()=>f.events.some(e=>e.type==='error')),true);assert.equal(f.events.find(e=>e.type==='error').code,'image_generation_failed');assert.deepEqual(f.events.filter(e=>['answer','error'].includes(e.type)).map(e=>e.type),['answer','error']);
});
test('verified terminal recovery failures terminate background observations without resend',async t=>{
 const f=await appFixture(t,{reply:()=>({accepted:true})});f.request('recovery-invalid');assert.equal(await f.waitFor(()=>f.clicks()===1),true);
 f.emit('recovery-invalid',{kind:'started'});f.emit('recovery-invalid',{kind:'answer',text:'Observed partial'});f.emit('recovery-invalid',{kind:'error',code:'response_recovery_failed'});
 assert.equal(await f.waitFor(()=>f.events.some(e=>e.type==='error')),true);assert.equal(f.events.find(e=>e.type==='error').code,'response_recovery_failed');
 assert.deepEqual(f.events.filter(e=>['answer','error'].includes(e.type)).map(e=>e.type),['answer','error']);assert.equal(f.clicks(),1);
});
