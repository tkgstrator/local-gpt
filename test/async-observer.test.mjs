import { test, installNativeEditing } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const target = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3', mid = 'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f', other = 'a5eadb59-b96e-4ef5-9342-2f49d62b3c60', asst = '094c6dd5-45d0-4da3-bd50-a79ef778addb';
const pause = ms => new Promise(r => setTimeout(r, ms));
const sse = lines => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(lines)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
const final = text => `event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: { conversation_id: target, message: { id: asst, author: { role: 'assistant' }, channel: 'final', recipient: 'all', content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', end_turn: true } }, c: 0 })}\n\ndata: [DONE]\n\n`;
const body = (text, id = mid) => JSON.stringify({ conversation_id: target, messages: [{ id, author: { role: 'user' }, content: { content_type: 'text', parts: [text] } }] });
function observer(t, response = () => sse(final('Native answer'))) {
  const page = new Window({ url: 'https://chatgpt.com/' }); t.after(() => page.close()); const calls = [];
  page.fetch = async (...args) => { calls.push(args); return response(); };
  require('../dist/page-observer.cjs').installPageObserver(page); const events = []; page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  const arm = detail => page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify(detail) }));
  return { page, events, arm, calls };
}
test('page observer streams only an armed send whose exact outgoing user text matches, with the user message identity', async t => {
  const o = observer(t); o.arm({ requestId: 'job1', text: 'Review this', backgroundJob: true });
  await o.page.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: body('Review this') }); await pause(50);
  assert.ok(o.events.length > 0); for (const e of o.events) { assert.equal(e.requestId, 'job1'); assert.equal(e.messageId, mid); }
  assert.equal(o.events.at(-1).kind, 'stop'); assert.equal(o.events.find(e => e.kind === 'answer').text, 'Native answer'); assert.equal(o.events.at(-1).conversationId, target);
});
test('manual sends in the same tab are ignored: different text, unarmed, or after the arm was consumed', async t => {
  const o = observer(t); await o.page.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: body('Unarmed manual') }); await pause(30); assert.equal(o.events.length, 0);
  o.arm({ requestId: 'job2', text: 'Expected text', backgroundJob: true });
  await o.page.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: body('Manual text typed by the user', other) }); await pause(30); assert.equal(o.events.length, 0);
  await o.page.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: body('Expected text') }); await pause(50); const count = o.events.length; assert.ok(count > 0);
  await o.page.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: body('Expected text', other) }); await pause(30); assert.equal(o.events.length, count); assert.equal(o.events.every(e => e.messageId === mid), true);
});
test('disarm cancels an armed send and unrelated routes never produce stream events', async t => {
  const o = observer(t); o.arm({ requestId: 'job3', text: 'Hello' }); o.page.dispatchEvent(new o.page.CustomEvent('localgpt:stream-disarm', { detail: 'job3' }));
  await o.page.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: body('Hello') }); await o.page.fetch('https://chatgpt.com/backend-api/other', { method: 'POST', body: body('Hello') }); await pause(30); assert.equal(o.events.length, 0);
});
test('page observer leaves the native response intact for ChatGPT and exports no headers or tokens', async t => {
  const o = observer(t); o.arm({ requestId: 'job4', text: 'Hi' }); const response = await o.page.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', headers: { Authorization: 'Bearer secret-token' }, body: body('Hi') });
  assert.match(await response.text(), /Native answer/); await pause(30); assert.equal(JSON.stringify(o.events).includes('secret-token'), false);
});
async function fixture(t, url = `https://chatgpt.com/c/${target}`) {
  const page = new Window({ url }); t.after(async () => { page.dispatchEvent(new page.Event('pagehide')); await page.happyDOM.abort(); page.close(); });
  page.document.body.innerHTML = '<div role="textbox" contenteditable="true"></div><button aria-label="Send">Send</button>'; await page.happyDOM.waitUntilComplete(); installNativeEditing(page);
  let queued = null, failBridge = false, rejectEvent = false; const events = [], order = [], attempts = [];
  page.chrome = { runtime: { sendMessage: async r => { if (r.path === 'event') attempts.push(r.data); if (failBridge && r.path === 'event') return { ok: false, error: 'Simulated disconnect' }; if (r.path === 'poll') { const request = queued; queued = null; return { ok: true, data: { request } }; } events.push(r.data); return { ok: true, data: { ok: true, accepted: rejectEvent !== r.data.requestId && r.data.type !== 'heartbeat' } }; } } };
  page.addEventListener('localgpt:stream-arm', () => order.push('arm')); page.document.querySelector('button').addEventListener('click', () => order.push('click'));
  const globals = ['chrome', 'window', 'document', 'location', 'HTMLTextAreaElement', 'WebSocket', 'CustomEvent', 'crypto', 'sessionStorage', 'setTimeout', 'clearTimeout'];
  new Function(...globals, await readFile('dist/extension/content.js', 'utf8'))(...globals.map(k => k === 'window' ? page : ['setTimeout', 'clearTimeout'].includes(k) ? page[k].bind(page) : page[k]));
  const emit = (id, event) => page.dispatchEvent(new page.CustomEvent('localgpt:response-stream', { detail: JSON.stringify({ requestId: id, messageId: mid, conversationId: target, ...event }) }));
  const find = (id, type) => events.find(e => e.requestId === id && e.type === type);
  return { page, events, order, attempts, queue: r => queued = r, setDisconnected: v => failBridge = v, setRejected: v => rejectEvent = v, emit, find, async until(check) { for (let i = 0; i < 250; i++) { const v = check(); if (v) return v; await pause(20); } throw Error('timeout'); } };
}
test('background dispatch arms the native stream BEFORE clicking send', async t => {
  const f = await fixture(t); f.queue({ type: 'request', requestId: 'order', text: 'Review', newChat: false, conversationId: target, backgroundJob: true }); await f.until(() => f.order.includes('click'));
  assert.deepEqual(f.order.slice(0, 2), ['arm', 'click']); f.emit('order', { kind: 'started' }); f.emit('order', { kind: 'answer', text: 'ok' }); f.emit('order', { kind: 'stop' }); await f.until(() => f.find('order', 'stop'));
});
test('background job ignores a settled DOM assistant answer and completes only from the native stop', async t => {
  const f = await fixture(t); f.page.document.querySelector('button').addEventListener('click', () => f.page.document.body.insertAdjacentHTML('beforeend', '<div data-message-author-role="assistant" data-message-id="dom-1"><div data-markdown-text-style="assistant-message">Interim DOM text while Pro still thinks</div></div>'));
  f.queue({ type: 'request', requestId: 'dom', text: 'Review', newChat: false, conversationId: target, backgroundJob: true }); await f.until(() => f.order.includes('click'));
  f.emit('dom', { kind: 'started' }); await pause(4000); assert.equal(f.find('dom', 'stop'), undefined); assert.equal(f.events.some(e => e.requestId === 'dom' && e.type === 'answer' && /DOM text/.test(e.text)), false); assert.equal(f.find('dom', 'error'), undefined);
  f.emit('dom', { kind: 'answer', text: 'Native final' }); f.emit('dom', { kind: 'stop' }); const stop = await f.until(() => f.find('dom', 'stop')); assert.equal(stop.conversationId, target); assert.equal(f.find('dom', 'answer').text, 'Native final');
});
test('background job with no observed native send stays unknown after dispatch, never completes from DOM, and does not time out', { timeout: 20000 }, async t => {
  const f = await fixture(t); f.page.document.querySelector('button').addEventListener('click', () => f.page.document.body.insertAdjacentHTML('beforeend', '<div data-message-author-role="assistant" data-message-id="dom-2">DOM only</div>'));
  f.queue({ type: 'request', requestId: 'unseen', text: 'Review', newChat: false, conversationId: target, backgroundJob: true, timeoutMs: 300 }); await f.until(() => f.find('unseen', 'progress'));
  await pause(1500); assert.equal(f.find('unseen', 'stop'), undefined); assert.equal(f.find('unseen', 'error'), undefined); assert.equal(f.find('unseen', 'progress').phase, 'unresponsive');
});
test('setup that never reaches dispatch fails definitively within the bounded setup deadline', { timeout: 20000 }, async t => {
  const f = await fixture(t); f.page.document.querySelector('[role="textbox"]').innerHTML = '<strong>Keep my rich draft</strong>'; f.queue({ type: 'request', requestId: 'setup', text: 'Review', newChat: false, conversationId: target, backgroundJob: true, timeoutMs: 300 });
  const error = await f.until(() => f.find('setup', 'error')); assert.equal(error.code, 'draft_unsupported'); assert.equal(f.order.includes('click'), false);
  const g = await fixture(t); g.page.document.querySelector('button').disabled = true; g.queue({ type: 'request', requestId: 'nosend', text: 'Review', newChat: false, conversationId: target, backgroundJob: true, timeoutMs: 300 });
  assert.equal((await g.until(() => g.find('nosend', 'error'))).code, 'browser_setup_timeout'); assert.equal(g.order.includes('click'), false);
});
test('background observer keeps partial text and reports unknown on interrupted/unsupported native stream errors without failing', async t => {
  const f = await fixture(t); f.queue({ type: 'request', requestId: 'unk', text: 'Review', newChat: false, conversationId: target, backgroundJob: true }); await f.until(() => f.order.includes('click'));
  f.emit('unk', { kind: 'started' }); f.emit('unk', { kind: 'answer', text: 'Safe partial' }); for (const code of ['response_stream_interrupted', 'unsupported_response_stream', 'response_incomplete']) f.emit('unk', { kind: 'error', code });
  await f.until(() => f.find('unk', 'answer')); await pause(200); assert.equal(f.find('unk', 'answer').text, 'Safe partial'); assert.equal(f.find('unk', 'error'), undefined); assert.ok(f.events.some(e => e.requestId === 'unk' && e.type === 'progress' && e.phase === 'unresponsive'));
});
test('only explicit native failed/cancelled errors stop a background job, as a definitive failure', async t => {
  for (const code of ['chatgpt_generation_failed', 'chatgpt_generation_cancelled']) {
    const f = await fixture(t); const id = 'x-' + code; f.queue({ type: 'request', requestId: id, text: 'Review', newChat: false, conversationId: target, backgroundJob: true }); await f.until(() => f.order.includes('click'));
    f.emit(id, { kind: 'started' }); f.emit(id, { kind: 'error', code }); assert.equal((await f.until(() => f.find(id, 'error'))).code, code);
  }
});
test('stream events with another request id or another message identity cannot complete the job', async t => {
  const f = await fixture(t); f.queue({ type: 'request', requestId: 'ident', text: 'Review', newChat: false, conversationId: target, backgroundJob: true }); await f.until(() => f.order.includes('click'));
  f.emit('different', { kind: 'answer', text: 'Foreign' }); f.emit('different', { kind: 'stop' }); f.emit('ident', { kind: 'started' });
  f.page.dispatchEvent(new f.page.CustomEvent('localgpt:response-stream', { detail: JSON.stringify({ requestId: 'ident', messageId: other, conversationId: target, kind: 'stop' }) }));
  await pause(300); assert.equal(f.find('ident', 'stop'), undefined); assert.equal(f.events.some(e => e.type === 'answer'), false);
});
test('background observer replays the latest answer and stop after a failed HTTP event and reconnect without redispatching', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.queue({ type: 'request', requestId: 'replay', text: 'Review', newChat: false, conversationId: target, backgroundJob: true, timeoutMs: 1000 }); await f.until(() => f.order.includes('click'));
  f.emit('replay', { kind: 'started' }); f.setDisconnected(true); f.emit('replay', { kind: 'answer', text: 'Recovered result' }); await pause(1100); f.emit('replay', { kind: 'stop' }); f.setDisconnected(false);
  await f.until(() => f.find('replay', 'stop')); assert.equal(f.find('replay', 'answer').text, 'Recovered result'); assert.equal(f.order.filter(x => x === 'click').length, 1); assert.equal(f.order.filter(x => x === 'arm').length, 1);
});

for (const [name, html, saved] of [
  ['decorated empty composer', '<p class="placeholder" data-placeholder="Ask anything"><br class="ProseMirror-trailingBreak"></p>', ''],
  ['plain decorated manual draft', '<p class="composer-paragraph" dir="auto">  My draft</p><p data-placeholder="Ask anything">next line</p>', '  My draft\nnext line'],
]) test('built extension safely dispatches with ' + name + ' and restores saved text', async t => {
  const f = await fixture(t); const editor=f.page.document.querySelector('[role="textbox"]'); editor.innerHTML=html;
  let storedAtClick;
  f.page.document.querySelector('button').addEventListener('click',()=>{storedAtClick=f.page.sessionStorage.getItem('localgpt:draft-backups:v1');editor.textContent='';});
  const id='draft-'+name; f.queue({type:'request',requestId:id,text:'Review',newChat:false,conversationId:target,backgroundJob:true}); await f.until(()=>f.order.includes('click'));
  if(saved) assert.equal(JSON.parse(storedAtClick)[0].text,saved); else assert.equal(storedAtClick,null);
  f.emit(id,{kind:'started'});f.emit(id,{kind:'answer',text:'Done'});f.emit(id,{kind:'stop'});await f.until(()=>f.find(id,'stop'));
  if(saved) { await f.until(()=>editor.textContent===saved); assert.deepEqual(JSON.parse(f.page.sessionStorage.getItem('localgpt:draft-backups:v1')),[]); }
  assert.equal(f.find(id,'error'),undefined);
});
test('built extension keeps saved draft recoverable and does not overwrite newer manual text after generation',async t=>{
  const f=await fixture(t), editor=f.page.document.querySelector('[role="textbox"]');editor.textContent='Saved draft';
  f.page.document.querySelector('button').addEventListener('click',()=>editor.textContent='Newer draft');
  f.queue({type:'request',requestId:'new-draft',text:'Review',newChat:false,conversationId:target,backgroundJob:true});await f.until(()=>f.order.includes('click'));
  f.emit('new-draft',{kind:'started'});f.emit('new-draft',{kind:'answer',text:'Done'});f.emit('new-draft',{kind:'stop'});await f.until(()=>f.find('new-draft','stop'));await pause(1200);
  assert.equal(editor.textContent,'Newer draft');assert.equal(JSON.parse(f.page.sessionStorage.getItem('localgpt:draft-backups:v1'))[0].text,'Saved draft');assert.equal(f.page.document.querySelector('#localgpt-saved-drafts').hidden,false);
});

test('native failure in the same tick as an answer preserves acknowledged partial text before reporting failure', async t => {
  const f = await fixture(t);
  const id = 'failed-partial';
  f.queue({type:'request',requestId:id,text:'Review',newChat:false,conversationId:target,backgroundJob:true});
  await f.until(() => f.order.includes('click'));
  f.emit(id, {kind:'started'});
  f.emit(id, {kind:'answer',text:'Safe partial before native failure'});
  f.emit(id, {kind:'error',code:'chatgpt_generation_failed'});
  await f.until(() => f.find(id, 'error'));
  assert.equal(f.find(id, 'answer')?.text, 'Safe partial before native failure');
  const answerIndex=f.events.findIndex(e=>e.requestId===id&&e.type==='answer');
  const errorIndex=f.events.findIndex(e=>e.requestId===id&&e.type==='error');
  assert.ok(answerIndex >= 0 && answerIndex < errorIndex);
});


test('known predispatch disconnect is retained and acknowledged after reconnect without clicking send', { timeout: 20000 }, async t => {
  const f = await fixture(t), id = 'setup-disconnect';
  f.page.document.querySelector('button').disabled = true;
  f.queue({ type: 'request', requestId: id, text: 'Review', newChat: false, conversationId: target, backgroundJob: true, timeoutMs: 5000 });
  await f.until(() => f.page.document.querySelector('[role="textbox"]').textContent === 'Review');
  f.setDisconnected(true);
  await f.until(() => f.attempts.find(e => e.requestId === id && e.type === 'error'));
  assert.equal(f.find(id, 'error'), undefined);
  assert.equal(f.order.includes('click'), false);
  f.setDisconnected(false);
  const error = await f.until(() => f.find(id, 'error'));
  assert.equal(error.code, 'setup_browser_disconnected');
  assert.equal(f.order.includes('click'), false);
  assert.ok(f.attempts.filter(e => e.requestId === id && e.type === 'error').length > 1);
});

test('explicit native failure is retained until acknowledged after reconnect without redispatching', { timeout: 20000 }, async t => {
  const f = await fixture(t), id = 'failure-reconnect';
  f.queue({ type: 'request', requestId: id, text: 'Review', newChat: false, conversationId: target, backgroundJob: true });
  await f.until(() => f.order.includes('click'));
  f.emit(id, { kind: 'started' });
  f.setDisconnected(true);
  f.emit(id, { kind: 'error', code: 'chatgpt_generation_failed' });
  await f.until(() => f.attempts.find(e => e.requestId === id && e.type === 'error'));
  assert.equal(f.find(id, 'error'), undefined);
  f.setDisconnected(false);
  assert.equal((await f.until(() => f.find(id, 'error'))).code, 'chatgpt_generation_failed');
  assert.equal(f.order.filter(x => x === 'click').length, 1);
  assert.equal(f.order.filter(x => x === 'arm').length, 1);
});

test('explicit server rejection releases a definitely unsent setup failure instead of wedging the tab', async t => {
 const f=await fixture(t),button=f.page.document.querySelector('button');button.disabled=true;
 f.queue({type:'request',requestId:'forgotten-setup',text:'Review',newChat:false,conversationId:target,backgroundJob:true,timeoutMs:10000});
 await f.until(()=>f.page.document.querySelector('[role="textbox"]').textContent==='Review');
 f.setDisconnected(true);await f.until(()=>f.attempts.some(e=>e.requestId==='forgotten-setup'&&e.type==='error'));
 f.setRejected('forgotten-setup');f.setDisconnected(false);await f.until(()=>f.find('forgotten-setup','error'));await pause(100);
 assert.equal(f.order.includes('click'),false);
 button.disabled=false;f.page.document.querySelector('[role="textbox"]').textContent='';
 f.queue({type:'request',requestId:'after-forgotten',text:'Next',newChat:false,conversationId:target,backgroundJob:true});
 await f.until(()=>f.order.includes('click'));f.emit('after-forgotten',{kind:'started'});f.emit('after-forgotten',{kind:'answer',text:'Done'});f.emit('after-forgotten',{kind:'stop'});await f.until(()=>f.find('after-forgotten','stop'));
});
