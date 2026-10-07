import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
const cidA = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
const cidB = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef4';
const userA = 'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
const userB = 'f5eadb59-b96e-4ef5-9342-2f49d62b3c60';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(read) {
  for (let i = 0; i < 250; i++) {
    const value = read();
    if (value) return value;
    await pause(20);
  }
  throw Error('Expected browser event did not arrive');
}
async function fixture(t, websocket = false) {
  const page = new Window({ url: 'https://chatgpt.com/' });
  const saved = new Map();
  for (const key of ['window', 'document', 'location', 'HTMLTextAreaElement', 'WebSocket', 'CustomEvent', 'sessionStorage', '__BRIDGE_TOKEN__']) {
    saved.set(key, globalThis[key]);
    globalThis[key] = key === 'window' ? page : key === '__BRIDGE_TOKEN__' ? 'test-token' : page[key];
  }
  t.after(async () => {
    page.dispatchEvent(new page.Event('pagehide'));
    await pause(10);
    await page.happyDOM.abort();
    page.close();
    for (const [key, value] of saved) globalThis[key] = value;
  });
  page.document.body.innerHTML = '<div role="textbox" contenteditable="true">Manual draft</div><button aria-label="Send">Send</button>';
  let clicks = 0;
  page.document.querySelector('button').onclick = () => clicks++;
  const queue = [], events = [], commands = [], dispatches = [], disarms = [], arms = [], timeline = [];
  let polls = 0, imageAccepted = true, identityAccepted = true, intentAccepted = true, terminalAccepted = true, acceptedFor = null, prepareError = null, update = null;
  const emit = (name, data) => page.dispatchEvent(new page.CustomEvent(name, { detail: JSON.stringify(data) }));
  page.addEventListener('localgpt:stream-disarm', event => disarms.push(event.detail));
  page.addEventListener('localgpt:stream-arm', event => { arms.push(JSON.parse(event.detail)); timeline.push('arm'); });
  page.addEventListener('localgpt:native-request', event => {
    const command = JSON.parse(event.detail);
    commands.push(command);
    if (command.action === 'probe') emit('localgpt:native-result', { requestId: command.requestId, kind: 'ready', ready: true });
    if (command.action === 'prepare') emit('localgpt:native-result', prepareError
      ? { requestId: command.requestId, kind: 'error', code: prepareError, preDispatch: true }
      : { requestId: command.requestId, kind: 'prepared', nativeUserMessageId: command.nativeUserMessageId });
    if (command.action === 'dispatch') { dispatches.push(command); timeline.push('dispatch'); }
  });
  const accepted = data => acceptedFor ? acceptedFor(data) : data.type === 'image' ? imageAccepted : data.type === 'native_identity' ? (typeof identityAccepted === 'function' ? identityAccepted(data) : identityAccepted) : data.type === 'native_intent' ? intentAccepted : data.type === 'stop' ? terminalAccepted : true;
  let socket;
  if (websocket) {
    globalThis.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() { socket = this; setTimeout(() => this.onopen?.(), 0); }
      send(raw) { const data = JSON.parse(raw); events.push(data); }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  }
  const { startBrowserApp } = await import('../src/browser-app.ts');
  startBrowserApp(websocket ? undefined : async (path, data) => {
    if (path === 'poll') { polls++; return { request: queue.shift() ?? null, ...(update ? { update } : {}) }; }
    if (path !== 'event') throw Error(`Unexpected mutation bridge call: ${path}`);
    events.push(data);
    if (data.type === 'native_intent' && accepted(data)) timeline.push('intent-ack');
    return { accepted: accepted(data) };
  });
  const deliver = data => websocket ? socket.onmessage({ data: JSON.stringify(data) }) : queue.push(data);
  return { page, queue, deliver, events, commands, dispatches, disarms, arms, timeline, emit,
    ack: (event, value) => deliver({ type: 'event_ack', requestId: event.requestId, eventId: event.eventId, accepted: value }),
    polls: () => polls, clicks: () => clicks,
    setImageAccepted: value => imageAccepted = value,
    setIdentityAccepted: value => identityAccepted = value,
    setIntentAccepted: value => intentAccepted = value,
    setTerminalAccepted: value => terminalAccepted = value,
    setAcceptedFor: value => acceptedFor = value,
    setPrepareError: value => prepareError = value,
    setUpdate: value => update = value,
  };
}
function request(id, cid = id === 'B' ? cidB : cidA) {
  return { type: 'request', requestId: id, text: 'Same text', newChat: false, conversationId: cid, native: true, nativeUserMessageId: id === 'B' ? userB : userA };
}
function stream(f, id, kind, extra = {}) {
  f.emit('localgpt:response-stream', { requestId: id, messageId: id === 'B' ? userB : userA,
    conversationId: id === 'B' ? cidB : cidA, nativeUserMessageId: id === 'B' ? userB : userA, kind, ...extra });
}
function identity(f, id) {
  f.emit('localgpt:native-result', { kind: 'identity', requestId: id,
    conversationId: id === 'B' ? cidB : cidA, nativeUserMessageId: id === 'B' ? userB : userA });
}
function complete(f, id, text) { identity(f, id); stream(f, id, 'answer', { text }); stream(f, id, 'stop', { terminalEvidence: true }); }
test('native A/B finish out of order, bypass manual drafts, and keep HTTP polling', async t => {
  const f = await fixture(t);
  f.deliver(request('A'));
  await wait(() => f.dispatches.length === 1);
  f.deliver(request('B'));
  await wait(() => f.dispatches.length === 2);
  assert.equal(f.clicks(), 0);
  assert.equal(f.page.document.querySelector('[role="textbox"]').textContent, 'Manual draft');
  assert.deepEqual(f.timeline, ['intent-ack', 'arm', 'dispatch', 'intent-ack', 'arm', 'dispatch']);
  assert.ok(f.polls() > 1);
  complete(f, 'B', 'B result');
  await wait(() => f.disarms.includes('B'));
  assert.deepEqual(f.disarms, ['B']);
  complete(f, 'A', 'A result');
  await wait(() => f.disarms.includes('A'));
  assert.deepEqual(f.events.filter(e => e.type === 'stop').map(e => [e.requestId, e.conversationId]), [['B', cidB], ['A', cidA]]);
  assert.deepEqual(f.events.filter(e => e.type === 'answer').map(e => [e.requestId, e.text]), [['B', 'B result'], ['A', 'A result']]);
  assert.deepEqual(f.events.filter(e => e.type === 'answer').map(e => e.nativeUserMessageId), [userB, userA]);
});
test('native image and progress delivery carry the same owner-bound user UUID', async t => {
  const f = await fixture(t);
  f.deliver(request('A'));
  await wait(() => f.dispatches.length === 1);
  identity(f, 'A');
  stream(f, 'A', 'progress', { phase: 'thinking' });
  stream(f, 'A', 'image_ref', { fileId: 'file_owned' });
  stream(f, 'A', 'image', { fileId: 'file_owned', imageData: { mimeType: 'image/png', data: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') } });
  stream(f, 'A', 'answer', { text: 'Image result' });
  stream(f, 'A', 'stop', { terminalEvidence: true });
  await wait(() => f.disarms.includes('A'));
  for (const type of ['image', 'progress', 'answer', 'stop']) {
    const event = f.events.find(e => e.type === type && e.requestId === 'A');
    assert.ok(event); assert.equal(event.nativeUserMessageId, userA);
  }
});
test('native contexts block legacy mutation, model UI, reload, and duplicate delivery', async t => {
  const f = await fixture(t);
  f.deliver(request('A'));
  await wait(() => f.dispatches.length === 1);
  f.deliver(request('A'));
  await pause(800);
  assert.equal(f.dispatches.length, 1);
  for (const operation of [
    { type: 'delete_conversation', conversationId: cidB },
    { type: 'move_conversation', conversationId: cidB, projectName: 'LocalGPT' },
    { type: 'dots', operation: { action: 'select', dotId: 'dot' } },
    { ...request('legacy'), native: false },
  ]) {
    f.deliver({ ...operation, requestId: `mutation-${operation.type}` });
    const error = await wait(() => f.events.find(e => e.requestId === `mutation-${operation.type}` && e.type === 'error'));
    assert.equal(error.code, 'browser_busy');
  }
  f.setUpdate({ version: '9.9.9' });
  await pause(800);
  assert.equal(f.disarms.length, 0);
  assert.equal(f.clicks(), 0);
});
test('identity ACK barrier holds output and terminal even when B can complete', async t => {
  const f = await fixture(t);
  f.deliver(request('A'));
  await wait(() => f.dispatches.length === 1);
  f.setIdentityAccepted(data => data.requestId !== 'A');
  complete(f, 'A', 'A result');
  await wait(() => f.events.some(e => e.type === 'native_identity'));
  await pause(1100);
  assert.equal(f.events.some(e => e.type === 'answer' || e.type === 'stop'), false);
  assert.equal(f.disarms.length, 0);
  f.deliver(request('B'));
  await wait(() => f.dispatches.length === 2);
  complete(f, 'B', 'B result');
  await wait(() => f.disarms.includes('B'));
  assert.deepEqual(f.disarms, ['B']);
  assert.equal(f.events.some(e => e.requestId === 'A' && (e.type === 'answer' || e.type === 'stop')), false);
  f.setIdentityAccepted(true);
  await wait(() => f.disarms.includes('A'));
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.events.filter(e => e.type === 'stop').length, 2);
});
test('exact correlated native HTTP refusal can terminate a new request without inventing a CID', async t => {
  const f = await fixture(t);
  f.deliver({ ...request('A'), newChat: true, conversationId: undefined });
  await wait(() => f.dispatches.length === 1);
  stream(f, 'A', 'error', { conversationId: null, code: 'chatgpt_http_error', terminalEvidence: true });
  await wait(() => f.disarms.includes('A'));
  const error = f.events.find(e => e.type === 'error' && e.requestId === 'A');
  assert.equal(error.terminalEvidence, true); assert.equal(error.nativeUserMessageId, userA);
  assert.equal(f.events.some(e => e.type === 'stop'), false);
});
test('generic native errors and unproven terminals retain ownership; exact terminal can recover', async t => {
  const f = await fixture(t);
  f.deliver(request('A'));
  await wait(() => f.dispatches.length === 1);
  f.emit('localgpt:native-result', { requestId: 'A', kind: 'error', nativeUserMessageId: userA, code: 'native_completion_unknown', preDispatch: false });
  stream(f, 'A', 'error', { code: 'chatgpt_api_error' });
  stream(f, 'A', 'answer', { text: 'Unproven result', nativeUserMessageId: userB });
  stream(f, 'A', 'stop', { terminalEvidence: true, nativeUserMessageId: userB });
  stream(f, 'A', 'stop');
  await pause(800);
  assert.equal(f.disarms.length, 0);
  assert.equal(f.events.some(e => e.type === 'stop' || e.type === 'error'), false);
  f.deliver(request('B'));
  await wait(() => f.dispatches.length === 2);
  complete(f, 'B', 'B result');
  await wait(() => f.disarms.includes('B'));
  complete(f, 'A', 'Recovered result');
  await wait(() => f.disarms.includes('A'));
  assert.equal(f.events.find(e => e.type === 'answer' && e.requestId === 'A').text, 'Recovered result');
});
test('prepare refusal ACKed false/null is retried until true; never arms or dispatches', async t => {
  const f = await fixture(t);
  f.setPrepareError('native_project_unavailable');
  f.setAcceptedFor(data => data.type === 'error' ? false : true);
  f.deliver(request('prepare-failure'));
  await wait(() => f.events.filter(e => e.requestId === 'prepare-failure' && e.type === 'error').length >= 2);
  assert.equal(f.disarms.length, 0);
  f.setAcceptedFor(null);
  await wait(() => f.disarms.includes('prepare-failure'));
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.arms.length, 0);
  assert.equal(f.clicks(), 0);
  assert.equal(f.page.document.querySelector('[role="textbox"]').textContent, 'Manual draft');
});
test('lost/false native_intent ACK replays identical receipt, then dispatches exactly once', async t => {
  const f = await fixture(t);
  f.setIntentAccepted(false);
  f.deliver(request('A'));
  await wait(() => f.events.filter(e => e.type === 'native_intent').length >= 2);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.arms.length, 0);
  assert.equal(f.events.some(e => e.type === 'error'), false);
  f.setIntentAccepted(true);
  await wait(() => f.dispatches.length === 1);
  await pause(1500);
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.arms.length, 1);
  const intents = f.events.filter(e => e.type === 'native_intent');
  assert.ok(intents.every(e => JSON.stringify(e) === JSON.stringify(intents[0])));
  assert.equal(f.events.some(e => e.type === 'error'), false);
});
test('websocket: intent receipt is replayed after lost ACK, then dispatches once', async t => {
  const f = await fixture(t, true);
  f.deliver(request('A'));
  const first = await wait(() => f.events.find(e => e.type === 'native_intent'));
  f.ack(first, false);
  const second = await wait(() => f.events.filter(e => e.type === 'native_intent')[1]);
  assert.equal(f.dispatches.length, 0);
  const { eventId: firstId, ...firstReceipt } = first;
  const { eventId: secondId, ...secondReceipt } = second;
  assert.notEqual(firstId, secondId);
  assert.deepEqual(firstReceipt, secondReceipt);
  f.ack(second, true);
  await wait(() => f.dispatches.length === 1);
  await pause(1200);
  assert.equal(f.dispatches.length, 1);
});
test('websocket: destroyed before ACK never dispatches', async t => {
  const f = await fixture(t, true);
  f.setIntentAccepted(false);
  f.deliver(request('A'));
  await wait(() => f.events.filter(e => e.type === 'native_intent').length >= 1);
  f.page.dispatchEvent(new f.page.Event('pagehide'));
  await pause(1500);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.arms.length, 0);
});
test('early busy refusal is retried until true ACK', async t => {
  const f = await fixture(t, true);
  f.page.document.querySelector('[role="textbox"]').remove();
  f.deliver({ type: 'request', requestId: 'busy-holder', text: 'Waiting for an editor', newChat: false, backgroundJob: true, timeoutMs: 10000 });
  f.deliver(request('A'));
  const errs = () => f.events.filter(e => e.requestId === 'A' && e.type === 'error');
  const first = await wait(() => errs()[0]);
  assert.equal(first.code, 'browser_busy');
  f.ack(first, false);
  const second = await wait(() => errs()[1]);
  f.ack(second, true);
  await pause(1200);
  const n = errs().length;
  f.deliver(request('A'));
  await pause(1200);
  assert.equal(errs().length, n);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.arms.length, 0);
  f.page.dispatchEvent(new f.page.Event('pagehide'));
  await wait(() => f.disarms.includes('busy-holder'));
});
test('terminal ACK replay does not redispatch and completed request delivery is ignored', async t => {
  const f = await fixture(t);
  f.setTerminalAccepted(false);
  f.deliver(request('A'));
  await wait(() => f.dispatches.length === 1);
  complete(f, 'A', 'result');
  await wait(() => f.events.filter(e => e.type === 'stop').length >= 2);
  assert.equal(f.disarms.length, 0);
  f.setTerminalAccepted(true);
  await wait(() => f.disarms.includes('A'));
  f.deliver(request('A'));
  await pause(800);
  assert.equal(f.dispatches.length, 1);
});
test('readiness probe advertises checked page capability without touching UI', async t => {
  const f = await fixture(t);
  f.deliver({ type: 'native_readiness', requestId: 'probe' });
  const ready = await wait(() => f.events.find(e => e.type === 'native_ready'));
  assert.equal(ready.protocol, 1);
  assert.equal(ready.ready, true);
  assert.deepEqual(f.commands.map(e => e.action), ['probe']);
  assert.equal(f.clicks(), 0);
});
test('interleaved native images stay request-owned and missing A image does not block B', async t => {
  const f = await fixture(t);
  f.deliver(request('A'));
  await wait(() => f.dispatches.length === 1);
  f.deliver(request('B'));
  await wait(() => f.dispatches.length === 2);
  identity(f, 'A'); identity(f, 'B');
  stream(f, 'A', 'image_ref', { fileId: 'file_A' });
  stream(f, 'B', 'image_ref', { fileId: 'file_B' });
  stream(f, 'A', 'stop', { terminalEvidence: true });
  // A foreign image cannot satisfy A's reference or be forwarded under B.
  stream(f, 'B', 'image', { fileId: 'file_A', downloadUrl: 'https://images.oaiusercontent.com/A' });
  stream(f, 'B', 'image', { fileId: 'file_B', downloadUrl: 'https://images.oaiusercontent.com/B' });
  stream(f, 'B', 'stop', { terminalEvidence: true });
  await wait(() => f.disarms.includes('B'));
  assert.deepEqual(f.disarms, ['B']);
  stream(f, 'A', 'image', { fileId: 'file_A', downloadUrl: 'https://images.oaiusercontent.com/A' });
  await wait(() => f.disarms.includes('A'));
  assert.deepEqual(f.events.filter(e => e.type === 'image').map(e => [e.requestId, e.conversationId, e.fileId]), [['B', cidB, 'file_B'], ['A', cidA, 'file_A']]);
});
test('new native chat uses adopted server identity, never the visible route', async t => {
  const f = await fixture(t);
  f.page.location.href = `https://chatgpt.com/c/${cidB}`;
  const newRequest = { ...request('A'), newChat: true };
  delete newRequest.conversationId;
  f.deliver(newRequest);
  await wait(() => f.dispatches.length === 1);
  f.emit('localgpt:native-result', { requestId: 'A', kind: 'identity', nativeUserMessageId: userA, clientThreadId: 'local-client-thread' });
  stream(f, 'A', 'answer', { text: 'new chat answer' });
  stream(f, 'A', 'stop', { terminalEvidence: true });
  await wait(() => f.disarms.includes('A'));
  assert.equal(f.events.find(e => e.type === 'stop').conversationId, cidA);
  assert.equal(f.page.location.pathname, `/c/${cidB}`);
  assert.equal(f.clicks(), 0);
});
test('WebSocket ACK ownership is request-keyed, not the legacy active slot', async t => {
  const f = await fixture(t, true);
  f.deliver(request('A'));
  const intent = await wait(() => f.events.find(e => e.type === 'native_intent'));
  f.deliver({ type: 'event_ack', requestId: 'foreign', eventId: intent.eventId, accepted: true });
  await pause(100);
  assert.equal(f.dispatches.length, 0);
  f.deliver({ type: 'event_ack', requestId: 'A', eventId: intent.eventId, accepted: true });
  await wait(() => f.dispatches.length === 1);
  complete(f, 'A', 'result');
  const receipt = await wait(() => f.events.find(e => e.type === 'native_identity'));
  f.deliver({ type: 'event_ack', requestId: 'foreign', eventId: receipt.eventId, accepted: true });
  await pause(100);
  assert.equal(f.events.some(e => e.type === 'answer'), false);
  f.deliver({ type: 'event_ack', requestId: 'A', eventId: receipt.eventId, accepted: true });
  const answer = await wait(() => f.events.find(e => e.type === 'answer'));
  f.deliver({ type: 'event_ack', requestId: 'A', eventId: answer.eventId, accepted: true });
  const stop = await wait(() => f.events.find(e => e.type === 'stop'));
  f.deliver({ type: 'event_ack', requestId: 'A', eventId: stop.eventId, accepted: true });
  await wait(() => f.disarms.includes('A'));
});

test('native partial visible answer is forwarded before terminal completion',async t=>{
 const f=await fixture(t);f.deliver(request('A'));await wait(()=>f.dispatches.length===1);
 identity(f,'A');stream(f,'A','answer',{text:'Partial answer'});
 await wait(()=>f.events.some(e=>e.type==='answer'&&e.text==='Partial answer'));
 assert.equal(f.events.some(e=>e.type==='stop'),false);
 stream(f,'A','stop',{terminalEvidence:true});await wait(()=>f.disarms.includes('A'));
});

test('proven page journal refusal completes without SDK invocation even after intent',async t=>{
 const f=await fixture(t);f.deliver(request('A'));await wait(()=>f.dispatches.length===1)
 f.emit('localgpt:native-result',{kind:'dispatch_refused',requestId:'A',nativeUserMessageId:userA,code:'native_journal_failed',message:'Not invoked'})
 await wait(()=>f.events.some(e=>e.type==='native_dispatch_refused'&&e.requestId==='A'))
 await wait(()=>f.disarms.includes('A'))
})
test('proven final assistant failure releases despite an unresolved image reference',async t=>{
 const f=await fixture(t);f.deliver(request('A'));await wait(()=>f.dispatches.length===1);identity(f,'A')
 stream(f,'A','image_ref',{fileId:'file_missing'});stream(f,'A','error',{terminalEvidence:true,code:'chatgpt_generation_failed'})
 await wait(()=>f.events.some(e=>e.type==='error'&&e.terminalEvidence&&e.requestId==='A'))
 await wait(()=>f.disarms.includes('A'))
})

test('terminal error waits for buffered image ACK but not for unresolved references',async t=>{
 const f=await fixture(t);f.deliver(request('A'));await wait(()=>f.dispatches.length===1);identity(f,'A');f.setImageAccepted(false)
 stream(f,'A','image_ref',{fileId:'file_buffered'});stream(f,'A','image',{fileId:'file_buffered',imageData:{mimeType:'image/png',data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')}})
 stream(f,'A','error',{terminalEvidence:true,code:'chatgpt_generation_failed'});await pause(200)
 assert.equal(f.events.some(e=>e.type==='error'&&e.terminalEvidence),false);assert.equal(f.disarms.includes('A'),false)
 f.setImageAccepted(true);await wait(()=>f.events.some(e=>e.type==='error'&&e.terminalEvidence));await wait(()=>f.disarms.includes('A'))
})
