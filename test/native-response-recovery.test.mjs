import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { installPageObserver } from '../src/page-observer.ts';
import { conversationFinalText, conversationFinalOutput, readConversationGraph } from '../src/conversation-recovery.ts';

const cid = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
const user = 'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
const assistant = '094c6dd5-45d0-4da3-bd50-a79ef778addb';
const graph = () => ({
  conversation_id: cid, current_node: assistant, private_metadata: 'never-export',
  mapping: {
    [user]: { id: user, parent: null, children: [assistant], message: { id: user, author: { role: 'user' }, content: { content_type: 'text', parts: ['question'] } } },
    [assistant]: { id: assistant, parent: user, children: [], message: { id: assistant, author: { role: 'assistant' }, channel: 'final', recipient: 'all', status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: ['Recovered final'] }, metadata: { private: 'never-export' } } },
  },
});

test('conversation recovery follows only the current branch and its nearest outgoing user', () => {
  assert.equal(conversationFinalText(graph(), cid, user), 'Recovered final');
  for (const mutate of [
    g => { g.conversation_id = user; },
    g => { g.current_node = user; },
    g => { g.mapping[assistant].parent = null; },
    g => { g.mapping[assistant].parent = assistant; },
    g => { g.mapping[user].message.id = cid; },
    g => { g.mapping[user].message.author.role = 'system'; },
    g => {
      g.mapping[cid] = { id: cid, parent: user, message: { id: cid, author: { role: 'user' } } };
      g.mapping[assistant].parent = cid;
    },
  ]) {
    const value = graph(); mutate(value);
    assert.equal(conversationFinalText(value, cid, user), null);
  }
  const unrelated = graph();
  unrelated.mapping[cid] = { id: cid, parent: null, message: { id: cid, author: { role: 'assistant' }, status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: ['Wrong branch'] } } };
  assert.equal(conversationFinalText(unrelated, cid, user), 'Recovered final');
});

test('conversation recovery rejects internal, unfinished, cancelled and unsupported final content', () => {
  for (const mutate of [
    m => { m.channel = 'analysis'; },
    m => { m.recipient = 'python'; },
    m => { m.author.role = 'tool'; },
    m => { m.metadata.is_visually_hidden_from_conversation = true; },
    m => { m.status = 'in_progress'; },
    m => { m.status = 'failed'; },
    m => { m.status = 'cancelled'; },
    m => { m.end_turn = false; },
    m => { m.content.content_type = 'multimodal_text'; },
    m => { m.content.parts = [{ content_type: 'image_asset_pointer' }]; },
    m => { m.content.parts = ['  ']; },
  ]) {
    const value = graph(); mutate(value.mapping[assistant].message);
    assert.equal(conversationFinalText(value, cid, user), null);
  }
  const oversized = graph();
  for (let i = 0; i < 5000; i++) oversized.mapping[`node-${i}`] = {};
  assert.equal(conversationFinalText(oversized, cid, user), null);
});

test('conversation recovery rejects a malformed intervening message that could obscure a later user turn', () => {
  const value = graph();
  value.mapping[cid] = { id: cid, parent: user, message: { id: cid, author: {}, content: { content_type: 'text', parts: ['Unknown author'] } } };
  value.mapping[assistant].parent = cid;
  assert.equal(conversationFinalText(value, cid, user), null);
});

test('conversation recovery validates ancestry beyond the matched user through a proper root', () => {
  const cyclic = graph();
  cyclic.mapping[user].parent = assistant;
  assert.equal(conversationFinalText(cyclic, cid, user), null);
  for (const parent of [undefined, 12, 'missing-node']) {
    const malformed = graph(); malformed.mapping[user].parent = parent;
    assert.equal(conversationFinalText(malformed, cid, user), null);
  }
  const rooted = graph();
  rooted.mapping[user].parent = cid;
  rooted.mapping[cid] = { id: cid, parent: null, message: null };
  assert.equal(conversationFinalText(rooted, cid, user), 'Recovered final');
});

test('native graph reads reject oversized or malformed payloads', async () => {
  assert.equal(await readConversationGraph(new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '8000001' } })), null);
  assert.equal(await readConversationGraph(new Response('x'.repeat(8000001), { headers: { 'content-type': 'application/json' } })), null);
  assert.equal(await readConversationGraph(new Response('{', { headers: { 'content-type': 'application/json' } })), null);
  assert.equal(await readConversationGraph(new Response(JSON.stringify(graph()), { headers: { 'content-type': 'text/html' } })), null);
});

test('rejected native graph bodies finish cancellation and release their reader before returning', async () => {
  for (const init of [
    { status: 503, headers: { 'content-type': 'application/json' } },
    { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-type': 'application/json', 'content-length': '8000001' } },
  ]) {
    let open = true;
    const body = new ReadableStream({ cancel: async () => { await pause(10); open = false; } });
    const response = new Response(body, init);
    assert.equal(await readConversationGraph(response), null);
    assert.equal(open, false);
    assert.equal(body.locked, false);
  }
});

test('rejected native graph streams do not remain open when the next recovery GET starts', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let gets = 0, activeBodies = 0, maxActiveBodies = 0, cancelled = false;
  page.fetch = async (_input, init) => {
    if (init?.method === 'POST') return new Response('event: delta_encoding\ndata: "v2"\n\n', { headers: { 'content-type': 'text/event-stream' } });
    gets++; activeBodies++; maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
    const rejected = gets === 1;
    return new Response(new ReadableStream({
      start(controller) {
        if (!rejected) { controller.enqueue(new TextEncoder().encode(JSON.stringify(graph()))); controller.close(); activeBodies--; }
      },
      async cancel() { await pause(10); activeBodies--; cancelled = true; },
    }), { status: rejected ? 503 : 200, headers: { 'content-type': 'application/json' } });
  };
  installPageObserver(page); const events = [];
  page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'rejected-recovery', text: 'question', backgroundJob: true }) }));
  await page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }) });
  for (let i = 0; i < 120 && !events.some(e => e.kind === 'stop'); i++) await pause(50);
  assert.equal(events.at(-1)?.kind, 'stop'); assert.equal(gets, 2);
  assert.equal(maxActiveBodies, 1); assert.equal(activeBodies, 0); assert.equal(cancelled, true);
});

test('recovery uses a conversation observed in SSE even before the route changes', async t => {
  const page = new Window({ url: 'https://chatgpt.com/' }); t.after(() => page.close());
  const calls = [];
  page.fetch = async (input, init) => {
    calls.push(String(input));
    return init?.method === 'POST'
      ? new Response(`data: ${JSON.stringify({ conversation_id: cid })}\n\nevent: delta_encoding\ndata: "v2"\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(graph()), { headers: { 'content-type': 'application/json' } });
  };
  installPageObserver(page); const events = [];
  page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'observed-cid', text: 'question', backgroundJob: true }) }));
  await page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }) });
  for (let i = 0; i < 30 && !events.some(e => e.kind === 'stop'); i++) await pause(10);
  assert.equal(events.find(e => e.kind === 'answer')?.text, 'Recovered final');
  assert.equal(calls[1], `https://chatgpt.com/backend-api/conversation/${cid}`);
});

test('recovery accepts the exact project conversation route without an observed SSE CID', async t => {
  const page = new Window({ url: `https://chatgpt.com/g/g-p-6ac2076d66d081919fc3db8b4db4af71-localgpt/c/${cid}` });
  t.after(() => page.close());
  page.fetch = async (_input, init) => init?.method === 'POST'
    ? new Response('event: delta_encoding\ndata: "v2"\n\n', { headers: { 'content-type': 'text/event-stream' } })
    : new Response(JSON.stringify(graph()), { headers: { 'content-type': 'application/json' } });
  installPageObserver(page); const events = [];
  page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'project-route', text: 'question', backgroundJob: true }) }));
  await page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }) });
  for (let i = 0; i < 30 && !events.some(e => e.kind === 'stop'); i++) await pause(10);
  assert.equal(events.find(e => e.kind === 'answer')?.text, 'Recovered final');
  assert.equal(events.at(-1)?.kind, 'stop');
});

test('outgoing conversation IDs alone and definite failures never authorize a recovery GET', async t => {
  for (const [route, body] of [
    ['/', 'event: delta_encoding\ndata: "v2"\n\n'],
    [`/c/${cid}/suffix`, 'event: delta_encoding\ndata: "v2"\n\n'],
    [`/c/local-chatgpt%3A${cid}`, 'event: delta_encoding\ndata: "v2"\n\n'],
    [`/c/${user}`, 'event: delta_encoding\ndata: "v2"\n\n'],
    [`/c/${cid}`, `data: ${JSON.stringify({ conversation_id: cid, message: { ...graph().mapping[assistant].message, status: 'cancelled' } })}\n\n`],
  ]) {
    const page = new Window({ url: `https://chatgpt.com${route}` }); t.after(() => page.close());
    const calls = [];
    page.fetch = async input => { calls.push(String(input)); return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); };
    installPageObserver(page); const events = [];
    page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
    page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'no-recovery', text: 'question', backgroundJob: true }) }));
    await page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ conversation_id: cid, messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }) });
    await pause(30);
    assert.equal(calls.length, 1); assert.equal(events.some(e => e.kind === 'stop'), false);
    page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: 'no-recovery' }));
  }
});

test('native recovery refuses a foreign page origin even with an observed conversation ID', async t => {
  const page = new Window({ url: `https://example.com/c/${cid}` }); t.after(() => page.close());
  const calls = [];
  page.fetch = async (_input, init) => {
    calls.push(init?.method);
    return init?.method === 'POST'
      ? new Response(`data: ${JSON.stringify({ conversation_id: cid })}\n\nevent: delta_encoding\ndata: "v2"\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(graph()), { headers: { 'content-type': 'application/json' } });
  };
  installPageObserver(page); const events = [];
  page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'foreign-origin', text: 'question', backgroundJob: true }) }));
  await page.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }) });
  await pause(30);
  assert.deepEqual(calls, ['POST']);
  assert.equal(events.some(e => e.kind === 'stop'), false);
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: 'foreign-origin' }));
});

test('disarming during recovery drops a late native answer', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let finishGet; const calls = [];
  page.fetch = async (input, init) => {
    calls.push(String(input));
    if (init?.method === 'POST') return new Response('event: delta_encoding\ndata: "v2"\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Promise(resolve => { finishGet = () => resolve(new Response(JSON.stringify(graph()), { headers: { 'content-type': 'application/json' } })); });
  };
  installPageObserver(page); const events = [];
  page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'disarm-recovery', text: 'question', backgroundJob: true }) }));
  await page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }) });
  for (let i = 0; i < 30 && !finishGet; i++) await pause(10);
  assert.ok(finishGet); assert.equal(calls.length, 2);
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: 'disarm-recovery' }));
  finishGet(); await pause(30);
  assert.equal(events.some(e => e.kind === 'answer' || e.kind === 'stop'), false);
});

test('synchronous recovery drops answers arriving beyond the existing request deadline', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  page.fetch = async (_input, init) => {
    if (init?.method === 'POST') return new Response('event: delta_encoding\ndata: "v2"\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await pause(60);
    return new Response(JSON.stringify(graph()), { headers: { 'content-type': 'application/json' } });
  };
  installPageObserver(page); const events = [];
  page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'deadline-recovery', text: 'question', timeoutMs: 30 }) }));
  await page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }) });
  await pause(100);
  assert.equal(events.some(e => e.kind === 'answer' || e.kind === 'stop'), false);
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: 'deadline-recovery' }));
});

test('unfinished graph remains unresponsive and a later bounded GET recovers without overlap', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let gets = 0, posts = 0, inFlight = 0, maxInFlight = 0;
  page.fetch = async (_input, init) => {
    if (init?.method === 'POST') { posts++; return new Response('event: delta_encoding\ndata: "v2"\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
    gets++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await pause(10); inFlight--;
    const value = graph(); if (gets === 1) value.mapping[assistant].message.status = 'in_progress';
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  installPageObserver(page); const events = [];
  page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'poll-recovery', text: 'question', backgroundJob: true }) }));
  await page.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }) });
  await pause(50);
  assert.ok(events.some(e => e.kind === 'progress' && e.phase === 'unresponsive'));
  assert.equal(events.some(e => e.kind === 'stop'), false);
  for (let i = 0; i < 120 && !events.some(e => e.kind === 'stop'); i++) await pause(50);
  assert.equal(events.find(e => e.kind === 'answer')?.text, 'Recovered final');
  assert.equal(events.at(-1)?.kind, 'stop'); assert.equal(gets, 2); assert.equal(posts, 1); assert.equal(maxInFlight, 1);
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const toolId = 'dd690ddc-6113-49f4-ad2c-6ed90d193d1a';
const secondAssistant = '26fe0c08-9cf6-4b52-985e-36d368c27144';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const textMessage = (id, text, endTurn = true) => ({ id, author: { role: 'assistant' }, channel: 'final', recipient: 'all', status: 'finished_successfully', end_turn: endTurn, content: { content_type: 'text', parts: [text] } });
const imageMessage = (files = ['file_generated']) => ({ id: toolId, author: { role: 'tool' }, status: 'finished_successfully', metadata: { async_task_type: 'image_gen' }, content: { content_type: 'multimodal_text', parts: files.map(id => ({ content_type: 'image_asset_pointer', asset_pointer: `sediment://${id}` })) } });
function turnGraph(messages) {
  const result = graph(); result.mapping = { [user]: structuredClone(result.mapping[user]) };
  let parent = user;
  for (const message of messages) {
    result.mapping[parent].children = [message.id];
    result.mapping[message.id] = { id: message.id, parent, children: [], message };
    parent = message.id;
  }
  result.current_node = parent; return result;
}
const imageGraph = (files, text = '') => turnGraph([imageMessage(files), textMessage(assistant, text)]);
async function armRecovery(page, requestId = 'image-recovery', extra = {}) {
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId, text: 'question', backgroundJob: true, ...extra }) }));
  return page.fetch('/backend-api/f/conversation', { method: 'POST', headers: { Authorization: 'Bearer never-export', 'ChatGPT-Account-ID': 'private-account' }, body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }) });
}
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const brokenSse = () => new Response('event: delta_encoding\ndata: "v2"\n\n', { headers: { 'content-type': 'text/event-stream' } });
async function untilRecovery(events, predicate = () => events.some(e => e.kind === 'stop'), ms = 500) {
  for (let i = 0; i < ms / 10 && !predicate(); i++) await pause(10);
}

test('image-only recovery resolves generated refs through exact authenticated GET before one stop', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  const calls = [], events = [];
  page.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (init?.method === 'POST') return brokenSse();
    if (String(input).includes('/files/download/')) return jsonResponse({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_generated&sig=never-export', private: 'never-export' });
    if (String(input).includes('/estuary/content')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return jsonResponse(imageGraph());
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await untilRecovery(events);
  assert.deepEqual(events.filter(e => ['image_ref', 'image', 'stop'].includes(e.kind)).map(e => e.kind), ['image_ref', 'image', 'stop']);
  assert.equal(events.find(e => e.kind === 'image')?.imageData.data, png.toString('base64'));
  const metadata = calls.find(c => c.url.includes('/files/download/'));
  assert.equal(metadata?.url, `https://chatgpt.com/backend-api/files/download/file_generated?conversation_id=${cid}`);
  assert.equal(metadata?.init.method, 'GET'); assert.equal(metadata?.init.redirect, 'error');
  assert.equal(new Headers(metadata?.init.headers).get('authorization'), 'Bearer never-export');
  assert.equal(new Headers(metadata?.init.headers).get('chatgpt-account-id'), 'private-account');
  assert.equal(calls.filter(c => c.init?.method === 'POST').length, 1);
  assert.equal(events.filter(e => e.kind === 'stop').length, 1);
  assert.equal(JSON.stringify(events).includes('never-export'), false); assert.equal(JSON.stringify(events).includes('private-account'), false);
});

test('recovered mixed responses publish every ref and image before chronologically combined text and one stop', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  const value = turnGraph([textMessage(assistant, 'First', false), imageMessage(['file_first', 'file_second']), textMessage(secondAssistant, 'Second')]);
  const calls = [], events = [];
  page.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (init?.method === 'POST') return brokenSse();
    if (String(input).includes('/files/download/')) return jsonResponse({ download_url: `https://x.oaiusercontent.com/image/${String(input).includes('file_first') ? 'first' : 'second'}?sig=signed-cdn` });
    return jsonResponse(value);
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await untilRecovery(events);
  assert.deepEqual(events.filter(e => ['image_ref', 'image', 'answer', 'stop'].includes(e.kind)).map(e => e.kind), ['image_ref', 'image_ref', 'image', 'image', 'answer', 'stop']);
  assert.deepEqual(events.filter(e => e.kind === 'image').map(e => e.fileId), ['file_first', 'file_second']);
  assert.equal(events.find(e => e.kind === 'answer')?.text, 'First\n\nSecond');
  assert.ok(events.filter(e => e.kind === 'image').every(e => e.downloadUrl.startsWith('https://x.oaiusercontent.com/')));
  assert.equal(calls.filter(c => c.url.includes('/files/download/')).length, 2);
  assert.equal(calls.filter(c => c.init?.method === 'POST').length, 1); assert.equal(events.filter(e => e.kind === 'stop').length, 1);
});

test('graph output validation excludes unfinished, unsupported and unrelated image tasks', () => {
  assert.deepEqual(conversationFinalOutput(imageGraph(), cid, user), { text: '', fileIds: ['file_generated'] });
  for (const [index, mutate] of [
    g => { g.mapping[toolId].message.status = 'in_progress'; },
    g => { g.mapping[toolId].message.content.parts[0].asset_pointer = 'sediment://not-a-file'; },
    g => { g.mapping[toolId].message.content.parts[0].asset_pointer = 'https://example.com/file_generated'; },
    g => { g.mapping[toolId].message.content.parts = imageMessage(['file_1', 'file_2', 'file_3', 'file_4', 'file_5']).content.parts; },
    g => { g.mapping[assistant].message.end_turn = false; },
    g => { g.current_node = toolId; },
    g => { g.mapping[toolId].message.author.role = 'user'; },
    g => { delete g.mapping[toolId].message.metadata; g.mapping[toolId].message.author.name = 'python'; },
    g => { g.mapping[toolId].message.content.content_type = 'video'; },
    g => { g.mapping[toolId].parent = toolId; },
    g => { delete g.mapping[toolId]; },
    g => { g.mapping[assistant].parent = user; },
    g => { g.mapping[user].parent = toolId; g.mapping[toolId].parent = null; g.mapping[assistant].parent = user; },
  ].entries()) {
    const value = imageGraph(); mutate(value);
    assert.deepEqual(conversationFinalOutput(value, cid, user),
      [null, 'error', 'error', 'error', null, null, null, null, 'error', null, null, null, null][index] === 'error' ? { error: 'response_recovery_failed' } : null);
  }
  for (const status of ['failed', 'cancelled']) {
    const value = imageGraph(); value.mapping[toolId].message.status = status;
    assert.deepEqual(conversationFinalOutput(value, cid, user), { error: 'image_generation_failed' });
  }
});

test('graph output retains observed text prefixes, references and nodes and rejects unfinished earlier text', () => {
  const value = turnGraph([textMessage(assistant, 'First', false), imageMessage(), textMessage(secondAssistant, 'Second')]);
  assert.deepEqual(conversationFinalOutput(value, cid, user, { text: 'Fir', fileIds: ['file_generated'], messageIds: [assistant, toolId] }), { text: 'First\n\nSecond', fileIds: ['file_generated'] });
  for (const observed of [{ text: 'Different' }, { fileIds: ['file_missing'] }, { messageIds: [cid] }])
    assert.equal(conversationFinalOutput(value, cid, user, observed), null);
  value.mapping[assistant].message.status = 'in_progress';
  assert.equal(conversationFinalOutput(value, cid, user), null);
});

test('verified terminal graphs reject permanent assets and caps but keep uncertain snapshot mismatches pending', () => {
  const invalidPointer = imageGraph(); invalidPointer.mapping[toolId].message.content.parts[0].asset_pointer = 'sediment://invalid';
  const cases = [
    [invalidPointer, {}],
    [imageGraph(['file_1','file_2','file_3','file_4','file_5']), {}],
  ];
  for (const [value, observed] of cases) assert.deepEqual(conversationFinalOutput(value, cid, user, observed), { error: 'response_recovery_failed' });
  for (const observed of [{ text: 'Wrong' }, { fileIds: ['file_missing'] }, { messageIds: [cid] }])
    assert.equal(conversationFinalOutput(imageGraph(undefined, 'Final'), cid, user, observed), null);
  const pending = imageGraph(); pending.mapping[toolId].message.status = 'in_progress';
  assert.equal(conversationFinalOutput(pending, cid, user, { text: 'Wrong', messageIds: [cid] }), null);
  const stub = turnGraph([textMessage(secondAssistant, '', false), imageMessage(), textMessage(assistant, 'Final')]);
  stub.mapping[secondAssistant].message.status = 'in_progress';
  assert.equal(conversationFinalOutput(stub, cid, user), null);
});

test('finished malformed assistant content is a definite recovery failure', () => {
  const value = graph();
  value.mapping[assistant].message.content = { content_type: 'code', parts: ['terminal output'] };
  assert.deepEqual(conversationFinalOutput(value, cid, user), { error: 'response_recovery_failed' });
});

test('stale graph snapshots remain pending until observed downstream nodes refs and text are represented', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  const actual = turnGraph([textMessage(secondAssistant, 'Explanation', false), imageMessage(), textMessage(assistant, '')]);
  const stale = turnGraph([textMessage(assistant, 'Old snapshot')]);
  // A node may already exist as a sibling/downstream entry without being on current_node's ancestry.
  stale.mapping[secondAssistant] = actual.mapping[secondAssistant];
  const prior = { ...textMessage(secondAssistant, 'Expl', false), status: 'in_progress' };
  let graphGets = 0, posts = 0; const events = [];
  page.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      posts++;
      return new Response([prior, imageMessage()].map(message => `data: ${JSON.stringify({conversation_id:cid,message})}\n\n`).join('') + 'event: delta_encoding\ndata: "v2"\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    if (String(input).includes('/files/download/')) return jsonResponse({ download_url: 'https://x.oaiusercontent.com/image?sig=signed' });
    return jsonResponse(++graphGets === 1 ? stale : actual);
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await pause(50);
  assert.equal(events.some(e => e.kind === 'error' || e.kind === 'stop'), false);
  await untilRecovery(events, undefined, 6500);
  assert.equal(events.at(-1)?.kind, 'stop'); assert.equal(graphGets, 2); assert.equal(posts, 1);
  assert.deepEqual(events.filter(e => e.kind === 'answer').map(e => e.text), ['Expl', 'Explanation']);
  assert.equal(events.filter(e => e.kind === 'image_ref').length, 1); assert.equal(events.filter(e => e.kind === 'image').length, 1);
});

test('empty finished assistant wrappers never add separators in recovered text', () => {
  const mixed = turnGraph([textMessage(secondAssistant, 'Explanation', false), imageMessage(), textMessage(assistant, '')]);
  assert.deepEqual(conversationFinalOutput(mixed, cid, user), { text: 'Explanation', fileIds: ['file_generated'] });
  const earlyEmpty = turnGraph([textMessage(secondAssistant, '', false), textMessage(assistant, 'Answer')]);
  assert.deepEqual(conversationFinalOutput(earlyEmpty, cid, user), { text: 'Answer', fileIds: [] });
  assert.deepEqual(conversationFinalOutput(imageGraph(), cid, user), { text: '', fileIds: ['file_generated'] });
});

test('stream and recovery both ignore private context and missing-content assistant nodes', async () => {
  const { observeConversationResponse } = await import('../src/conversation-stream.ts');
  for (const content of [undefined, null, {content_type:'model_editable_context',model_set_context:'Private never-export'}]) for (const status of ['in_progress','failed','finished_successfully']) {
    const ignored = { ...textMessage(secondAssistant, '', false), content, status };
    const final = textMessage(assistant, 'Public final');
    const events = [], nodes = [];
    await observeConversationResponse(new Response([ignored,final].map(message => `data: ${JSON.stringify({conversation_id:cid,message})}\n\n`).join('') + 'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}), {requestId:'relevance',messageId:user,conversationId:null}, e=>events.push(e), {onOutputNode:id=>nodes.push(id)});
    assert.equal(events.at(-1)?.kind,'stop'); assert.deepEqual(nodes,[assistant]);
    assert.deepEqual(conversationFinalOutput(turnGraph([ignored,final]), cid, user), {text:'Public final',fileIds:[]});
    assert.equal(conversationFinalOutput(turnGraph([ignored,final]), cid, user, {messageIds:[secondAssistant]}), null);
    assert.equal(JSON.stringify(events).includes('Private never-export'),false);
  }
});

const recapMessage = (channel, over = {}) => {
  const m = { id: secondAssistant, author: { role: 'assistant' }, channel, recipient: 'all', status: 'finished_successfully', end_turn: false, content: { content_type: 'reasoning_recap', content: 'Private recap sentinel' }, ...over };
  if (channel === undefined) delete m.channel;
  return m;
};

test('stream and recovery exclude successful reasoning recap intermediates and export only the final', async () => {
  const { observeConversationResponse } = await import('../src/conversation-stream.ts');
  for (const channel of [null, undefined]) {
    const recap = recapMessage(channel);
    const final = textMessage(assistant, 'Public final');
    const events = [], nodes = [];
    await observeConversationResponse(new Response([recap, final].map(message => `data: ${JSON.stringify({conversation_id:cid,message})}\n\n`).join('') + 'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}), {requestId:'recap',messageId:user,conversationId:null}, e=>events.push(e), {onOutputNode:id=>nodes.push(id)});
    assert.equal(events.at(-1)?.kind,'stop'); assert.deepEqual(nodes,[assistant]);
    assert.deepEqual(events.filter(e=>e.kind==='answer').map(e=>e.text),['Public final']);
    assert.deepEqual(conversationFinalOutput(turnGraph([recap,final]), cid, user), {text:'Public final',fileIds:[]});
    assert.equal(conversationFinalOutput(turnGraph([recap,final]), cid, user, {messageIds:[secondAssistant]}), null);
    assert.equal(JSON.stringify(events).includes('Private recap sentinel'),false);
    assert.equal(JSON.stringify(conversationFinalOutput(turnGraph([recap,final]), cid, user)).includes('Private recap sentinel'),false);
  }
});

test('a reasoning recap alone is never recovered as a successful response', async () => {
  const { observeConversationResponse } = await import('../src/conversation-stream.ts');
  for (const channel of [null, undefined]) for (const end_turn of [false, true]) {
    const recap = recapMessage(channel, { id: assistant, end_turn });
    const events = [];
    await observeConversationResponse(new Response(`data: ${JSON.stringify({conversation_id:cid,message:recap})}\n\n` + 'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}), {requestId:'recap-only',messageId:user,conversationId:null}, e=>events.push(e));
    assert.equal(events.some(e=>e.kind==='stop'||e.kind==='answer'),false);
    assert.equal(conversationFinalOutput(turnGraph([recap]), cid, user), null);
    assert.equal(conversationFinalText(turnGraph([recap]), cid, user), null);
  }
});

test('a malformed actual final after a reasoning recap remains a recovery failure', () => {
  const final = { ...textMessage(assistant, ''), content: { content_type: 'code', parts: ['terminal output'] } };
  assert.deepEqual(conversationFinalOutput(turnGraph([recapMessage(null), final]), cid, user), { error: 'response_recovery_failed' });
});

test('four file-service images stay within the graph recovery cap', () => {
  const value = imageGraph(['file_first','file_second','file_third','file_fourth']);
  for (const part of value.mapping[toolId].message.content.parts) part.asset_pointer = part.asset_pointer.replace('sediment://', 'file-service://');
  assert.deepEqual(conversationFinalOutput(value, cid, user), { text: '', fileIds: ['file_first','file_second','file_third','file_fourth'] });
});

test('partial SSE refs and text recover mixed output without duplicate refs or extra separators', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  const value = turnGraph([textMessage(secondAssistant, 'Explanation', false), imageMessage(), textMessage(assistant, '')]);
  const partial = { ...textMessage(secondAssistant, 'Expl', false), status: 'in_progress' };
  const events = []; let posts = 0, metadataGets = 0;
  page.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      posts++;
      return new Response([partial, imageMessage()].map(message => `data: ${JSON.stringify({conversation_id:cid,message})}\n\n`).join('') + 'event: delta_encoding\ndata: "v2"\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    if (String(input).includes('/files/download/')) { metadataGets++; return jsonResponse({ download_url: 'https://x.oaiusercontent.com/image?sig=signed' }); }
    return jsonResponse(value);
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await untilRecovery(events);
  assert.equal(events.at(-1)?.kind, 'stop'); assert.equal(posts, 1); assert.equal(metadataGets, 1);
  assert.deepEqual(events.filter(e => e.kind === 'answer').map(e => e.text), ['Expl', 'Explanation']);
  assert.equal(events.filter(e => e.kind === 'image_ref').length, 1); assert.equal(events.filter(e => e.kind === 'image').length, 1);
  assert.equal(events.filter(e => e.kind === 'stop').length, 1);
  assert.ok(events.findIndex(e => e.kind === 'image') < events.findIndex(e => e.kind === 'answer' && e.text === 'Explanation'));
});

test('failed or cancelled recovered image tasks emit a definite error and never stop', async t => {
  for (const status of ['failed', 'cancelled']) {
    const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
    const value = imageGraph(); value.mapping[toolId].message.status = status;
    page.fetch = async (_input, init) => init?.method === 'POST' ? brokenSse() : jsonResponse(value);
    installPageObserver(page); const events = [];
    page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
    await armRecovery(page); await untilRecovery(events, () => events.some(e => e.kind === 'error'));
    assert.equal(events.at(-1)?.code, 'image_generation_failed'); assert.equal(events.some(e => e.kind === 'stop'), false);
  }
});

test('marked image failures with text content remain definite even before a later successful image task', () => {
  for (const status of ['failed', 'cancelled']) {
    const failed = { ...imageMessage(), status, content: { content_type: 'text', parts: ['Tool error'] } };
    const success = { ...imageMessage(['file_later']), id: cid };
    const value = turnGraph([failed, success, textMessage(assistant, 'Later final text')]);
    assert.deepEqual(conversationFinalOutput(value, cid, user), { error: 'image_generation_failed' });
  }
});

test('graph recovery rejects marked non-image parts beside a generated pointer without partial output', () => {
  for (const marker of ['generation','dalle']) {
    const value = imageGraph();
    value.mapping[toolId].message.content.parts.push({content_type:'text',text:'Private payload',metadata:{[marker]:{}}});
    assert.deepEqual(conversationFinalOutput(value, cid, user), {error:'response_recovery_failed'});
  }
});

test('expired owned estuary URLs refetch metadata before retrying image bytes', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let metadataGets = 0; const byteUrls = [], events = [];
  page.fetch = async (input, init) => {
    if (init?.method === 'POST') return brokenSse();
    if (String(input).includes('/files/download/')) {
      metadataGets++;
      return jsonResponse({ download_url: `https://chatgpt.com/backend-api/estuary/content?id=file_generated&token=${metadataGets === 1 ? 'expired' : 'fresh'}` });
    }
    if (String(input).includes('/estuary/content')) {
      byteUrls.push(String(input));
      return String(input).includes('expired') ? new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } }) : new Response(png, { headers: { 'content-type': 'image/png' } });
    }
    return jsonResponse(imageGraph());
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await untilRecovery(events, undefined, 6500);
  assert.equal(events.at(-1)?.kind, 'stop'); assert.equal(metadataGets, 2);
  assert.deepEqual(byteUrls.map(url => new URL(url).searchParams.get('token')), ['expired', 'fresh']);
  assert.equal(events.filter(e => e.kind === 'image').length, 1);
});

test('rejected passive clones finish observation without waiting for the native consumer', async () => {
  let producer; const original = new Response(new ReadableStream({ start(c) { producer = c; c.enqueue(new TextEncoder().encode('Native body')); } }), { status: 503, headers: { 'content-type': 'application/json' } });
  const clone = original.clone();
  const outcome = await Promise.race([readConversationGraph(clone, 100000, { awaitCancellation: false }), pause(50).then(() => 'blocked')]);
  producer.close(); assert.equal(await original.text(), 'Native body');
  assert.equal(outcome, null); assert.equal(clone.body.locked, false);
});

test('stalled passive metadata and byte observations have bounded waits before active recovery', { timeout: 22000 }, async t => {
  await Promise.all(['metadata', 'bytes'].map(async stage => {
    const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
    let releaseGraph, releaseNative, metadataGets = 0; const events = [];
    page.fetch = async (input, init) => {
      if (init?.method === 'POST') return brokenSse();
      if (String(input).includes('/files/download/')) {
        metadataGets++;
        if (stage === 'metadata' && metadataGets === 1) return new Promise(resolve => { releaseNative = () => resolve(jsonResponse({ download_url: 'https://x.oaiusercontent.com/late' })); });
        return jsonResponse({ download_url: 'https://x.oaiusercontent.com/image?sig=signed' });
      }
      if (String(input).includes('/estuary/content')) return new Response(new ReadableStream({ start(c) { c.enqueue(png); releaseNative = () => c.close(); } }), { headers: { 'content-type': 'image/png' } });
      return new Promise(resolve => { releaseGraph = () => resolve(jsonResponse(imageGraph())); });
    };
    installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
    await armRecovery(page); await untilRecovery(events, () => Boolean(releaseGraph));
    if (stage === 'metadata') void page.fetch(`/backend-api/files/download/file_generated?conversation_id=${cid}`);
    else await page.fetch('/backend-api/estuary/content?id=file_generated');
    await pause(20); releaseGraph(); await untilRecovery(events, undefined, 17000);
    releaseNative(); await pause(30);
    assert.equal(events.at(-1)?.kind, 'stop', stage);
    assert.equal(events.filter(e => e.kind === 'image').length, 1); assert.equal(events.filter(e => e.kind === 'stop').length, 1);
    assert.equal(metadataGets, stage === 'metadata' ? 2 : 1);
  }));
});

test('earlier SSE text refs and output nodes must survive on the recovered branch', async t => {
  for (const prior of [
    textMessage(assistant, 'Wrong prefix', false),
    imageMessage(['file_missing']),
    { ...imageMessage(), id: cid, status: 'in_progress' },
  ]) {
    const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
    const calls = [], events = [];
    page.fetch = async (input, init) => {
      calls.push(String(input));
      if (init?.method === 'POST') return new Response(`data: ${JSON.stringify({ conversation_id: cid, message: prior })}\n\nevent: delta_encoding\ndata: "v2"\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      return jsonResponse(imageGraph(undefined, 'Graph final'));
    };
    installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
    await armRecovery(page); await pause(60);
    assert.equal(events.some(e => e.kind === 'stop'), false);
    assert.equal(events.some(e => e.kind === 'answer' && e.text === 'Graph final'), false);
    assert.equal(calls.some(c => c.includes('/files/download/')), false);
    page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: 'image-recovery' }));
  }
});

test('transient image metadata failure retries GET without duplicate refs images or POST', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let metadataGets = 0, posts = 0; const events = [];
  page.fetch = async (input, init) => {
    if (init?.method === 'POST') { posts++; return brokenSse(); }
    if (String(input).includes('/files/download/')) {
      metadataGets++;
      return metadataGets === 1 ? new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }) : jsonResponse({ download_url: 'https://x.oaiusercontent.com/image?sig=signed' });
    }
    return jsonResponse(imageGraph());
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await untilRecovery(events, undefined, 6500);
  assert.equal(events.at(-1)?.kind, 'stop'); assert.equal(metadataGets, 2); assert.equal(posts, 1);
  for (const kind of ['image_ref', 'image', 'stop']) assert.equal(events.filter(e => e.kind === kind).length, 1);
});

test('disarming during metadata or byte GET suppresses every late image answer and stop', async t => {
  for (const blockedStage of ['metadata', 'bytes']) {
    const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
    let release; const events = [];
    page.fetch = async (input, init) => {
      if (init?.method === 'POST') return brokenSse();
      if (String(input).includes('/files/download/')) {
        const response = () => jsonResponse({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_generated&sig=never-export' });
        if (blockedStage === 'metadata') return new Promise(resolve => { release = () => resolve(response()); });
        return response();
      }
      if (String(input).includes('/estuary/content')) return new Promise(resolve => { release = () => resolve(new Response(png, { headers: { 'content-type': 'image/png' } })); });
      return jsonResponse(imageGraph(undefined, 'Final'));
    };
    installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
    await armRecovery(page); await untilRecovery(events, () => Boolean(release));
    assert.ok(release);
    page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: 'image-recovery' }));
    release(); await pause(50);
    assert.equal(events.some(e => ['image', 'answer', 'stop'].includes(e.kind)), false);
  }
});

test('passive metadata and bytes dedupe active recovery and keep native responses intact', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let releaseGraph; const calls = [], events = [];
  page.fetch = async (input, init) => {
    calls.push(String(input));
    if (init?.method === 'POST') return brokenSse();
    if (String(input).includes('/files/download/')) return jsonResponse({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_generated&sig=never-export' });
    if (String(input).includes('/estuary/content')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Promise(resolve => { releaseGraph = () => resolve(jsonResponse(imageGraph())); });
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await untilRecovery(events, () => Boolean(releaseGraph));
  const metadata = await page.fetch(`/backend-api/files/download/file_generated?conversation_id=${cid}`, { headers: { Authorization: 'Bearer never-export' } });
  assert.equal((await metadata.json()).download_url.includes('/estuary/content'), true);
  const bytes = await page.fetch('/backend-api/estuary/content?id=file_generated&sig=never-export');
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), png);
  await pause(30); releaseGraph(); await untilRecovery(events);
  assert.equal(events.at(-1)?.kind, 'stop'); assert.equal(events.filter(e => e.kind === 'image').length, 1);
  assert.equal(calls.filter(c => c.includes('/files/download/')).length, 1);
  assert.equal(calls.filter(c => c.includes('/estuary/content')).length, 1);
});

test('in-flight passive image bytes remain correlated and prevent an overlapping active byte GET', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let releaseGraph, finishBytes, byteGets = 0; const events = [];
  page.fetch = async (input, init) => {
    if (init?.method === 'POST') return brokenSse();
    if (String(input).includes('/files/download/')) return jsonResponse({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_generated' });
    if (String(input).includes('/estuary/content')) {
      byteGets++;
      if (byteGets > 1) return new Response(png, { headers: { 'content-type': 'image/png' } });
      return new Response(new ReadableStream({ start(c) { c.enqueue(png); finishBytes = () => c.close(); } }), { headers: { 'content-type': 'image/png' } });
    }
    return new Promise(resolve => { releaseGraph = () => resolve(jsonResponse(imageGraph())); });
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await untilRecovery(events, () => Boolean(releaseGraph));
  const native = await page.fetch('/backend-api/estuary/content?id=file_generated'); const reading = native.arrayBuffer();
  await pause(20); releaseGraph(); await pause(20);
  const metadata = await page.fetch(`/backend-api/files/download/file_generated?conversation_id=${cid}`);
  await metadata.json(); await pause(30);
  const observedByteGets = byteGets;
  finishBytes(); await reading; await untilRecovery(events);
  assert.equal(observedByteGets, 1);
  assert.equal(events.at(-1)?.kind, 'stop'); assert.equal(events.filter(e => e.kind === 'image').length, 1);
});

test('recovery refuses native download URLs with ambiguous duplicate image IDs', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  const calls = [], events = [];
  page.fetch = async (input, init) => {
    calls.push(String(input));
    if (init?.method === 'POST') return brokenSse();
    if (String(input).includes('/files/download/')) return jsonResponse({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_generated&id=file_wrong' });
    if (String(input).includes('/estuary/content')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return jsonResponse(imageGraph());
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await pause(60);
  assert.equal(calls.some(c => c.includes('/estuary/content')), false);
  assert.equal(events.some(e => e.kind === 'image' || e.kind === 'stop'), false);
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: 'image-recovery' }));
});

test('passive estuary responses with duplicate image IDs never populate the recovery byte cache', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let releaseGraph, metadataGets = 0; const events = [];
  page.fetch = async (input, init) => {
    if (init?.method === 'POST') return brokenSse();
    if (String(input).includes('/files/download/')) { metadataGets++; return jsonResponse({ download_url: 'https://x.oaiusercontent.com/image?sig=signed' }); }
    if (String(input).includes('/estuary/content')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Promise(resolve => { releaseGraph = () => resolve(jsonResponse(imageGraph())); });
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await untilRecovery(events, () => Boolean(releaseGraph));
  const native = await page.fetch('/backend-api/estuary/content?id=file_generated&id=file_wrong');
  assert.deepEqual(Buffer.from(await native.arrayBuffer()), png);
  await pause(20); releaseGraph(); await untilRecovery(events);
  assert.equal(events.at(-1)?.kind, 'stop'); assert.equal(metadataGets, 1);
  assert.equal(events.find(e => e.kind === 'image')?.imageData, undefined);
  assert.equal(events.find(e => e.kind === 'image')?.downloadUrl, 'https://x.oaiusercontent.com/image?sig=signed');
});

test('wrong-CID passive metadata cannot poison an exact-CID recovery download', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let releaseGraph; const calls = [], events = [];
  page.fetch = async (input, init) => {
    calls.push(String(input));
    if (init?.method === 'POST') return brokenSse();
    if (String(input).includes('/files/download/')) return jsonResponse({ download_url: 'https://x.oaiusercontent.com/image?sig=signed' });
    return new Promise(resolve => { releaseGraph = () => resolve(jsonResponse(imageGraph())); });
  };
  installPageObserver(page); page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  await armRecovery(page); await untilRecovery(events, () => Boolean(releaseGraph));
  const metadata = await page.fetch(`/backend-api/files/download/file_generated?conversation_id=${user}`); await metadata.json();
  await pause(20); releaseGraph(); await untilRecovery(events);
  assert.equal(events.at(-1)?.kind, 'stop');
  assert.equal(calls.filter(c => c.includes('/files/download/')).length, 2);
  assert.ok(calls.includes(`https://chatgpt.com/backend-api/files/download/file_generated?conversation_id=${cid}`));
});

test('disarming from the first published cached image suppresses the remaining batch', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` }); t.after(() => page.close());
  let releaseGraph; const events = [];
  page.fetch = async (input, init) => {
    if (init?.method === 'POST') return brokenSse();
    if (String(input).includes('/estuary/content')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Promise(resolve => { releaseGraph = () => resolve(jsonResponse(imageGraph(['file_first', 'file_second']))); });
  };
  installPageObserver(page);
  page.addEventListener('localgpt:response-stream', e => {
    const event = JSON.parse(e.detail); events.push(event);
    if (event.kind === 'image') page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: 'image-recovery' }));
  });
  await armRecovery(page); await untilRecovery(events, () => Boolean(releaseGraph));
  for (const fileId of ['file_first', 'file_second']) {
    const native = await page.fetch(`/backend-api/estuary/content?id=${fileId}`); await native.arrayBuffer();
  }
  await pause(20); releaseGraph(); await pause(60);
  assert.equal(events.filter(e => e.kind === 'image').length, 1);
  assert.equal(events.some(e => e.kind === 'answer' || e.kind === 'stop'), false);
});

test('failed native observation recovers the exact submitted turn through GET without resending', async t => {
  const page = new Window({ url: `https://chatgpt.com/c/${cid}` });
  t.after(() => page.close());
  const requests = [];
  page.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method, headers: init?.headers });
    if (init?.method === 'POST') return new Response('event: delta_encoding\ndata: "v2"\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify(graph()), { headers: { 'content-type': 'application/json' } });
  };
  installPageObserver(page);
  const events = [];
  page.addEventListener('localgpt:response-stream', e => events.push(JSON.parse(e.detail)));
  page.dispatchEvent(new page.CustomEvent('localgpt:stream-arm', { detail: JSON.stringify({ requestId: 'recovery', text: 'question', backgroundJob: true }) }));
  const response = await page.fetch('/backend-api/f/conversation', {
    method: 'POST', headers: { Authorization: 'Bearer never-export', 'ChatGPT-Account-ID': 'private-account' },
    body: JSON.stringify({ messages: [{ id: user, author: { role: 'user' }, content: { parts: ['question'] } }] }),
  });
  assert.equal(await response.text(), 'event: delta_encoding\ndata: "v2"\n\n');
  for (let i = 0; i < 30 && !events.some(e => e.kind === 'stop'); i++) await pause(10);
  assert.equal(events.find(e => e.kind === 'answer')?.text, 'Recovered final');
  assert.deepEqual(events.at(-1), { requestId: 'recovery', messageId: user, conversationId: cid, kind: 'stop' });
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(requests[1]?.url, `https://chatgpt.com/backend-api/conversation/${cid}`);
  assert.equal(requests[1]?.method, 'GET');
  assert.equal(new Headers(requests[1]?.headers).get('authorization'), 'Bearer never-export');
  assert.equal(JSON.stringify(events).includes('never-export'), false);
  assert.equal(JSON.stringify(events).includes('private-account'), false);
});
