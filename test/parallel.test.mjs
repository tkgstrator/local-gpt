import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const cid = n => `6ac07bb1-b2b4-43e8-8304-5424a5cf2ef${n}`;
// ChatGPT tabs share account UI state: one existing tab owns all work and standby tabs receive nothing.
for (const mode of ['http', 'websocket']) test(`one shared ${mode} tab serializes sessions; standby tabs receive nothing and cannot answer`, async t => {
  const service = require('../dist/server.cjs').createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 3000, bridgeToken: 'parallel-test' });
  const ports = await service.start(); t.after(() => service.close()); const base = `http://127.0.0.1:${ports.httpPort}`;
  const create = async title => (await (await fetch(base + '/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) })).json()).id;
  const sessions = await Promise.all(['A', 'B'].map(create)); const received = new Map(), sockets = new Map();
  const bridge = async (id, path, body) => (await fetch(base + '/bridge/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'parallel-test', 'X-Browser-Id': id }, body: JSON.stringify(body) })).json();
  for (const id of ['tab-a', 'tab-b']) {
    if (mode === 'http') await bridge(id, 'poll', {});
    else { const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?token=parallel-test&browserId=${id}`); await once(ws, 'open'); ws.on('message', raw => received.set(id, JSON.parse(raw))); sockets.set(id, ws); }
  }
  const post = (session, input) => fetch(base + '/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: session, input }) });
  const next = async () => { for (let i = 0; i < 100; i++) { if (mode === 'http') for (const id of ['tab-a', 'tab-b']) { const r = (await bridge(id, 'poll', {})).request; if (r) received.set(id, r); } if (received.size) return [...received.entries()][0]; await new Promise(r => setTimeout(r, 10)); } throw Error('No request'); };
  const send = async (id, event) => mode === 'http' ? bridge(id, 'event', event) : sockets.get(id).send(JSON.stringify(event));
  const first = post(sessions[0], 'Topic A'); const [owner, a] = await next();
  for (const [session, input] of [[sessions[1], 'Topic B'], [sessions[0], 'Do not send twice']]) { const rejected = await post(session, input); assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error.code, 'browser_busy'); }
  const health = await (await fetch(base + '/health')).json(); assert.equal(health.browsers, 2); assert.equal(health.availableBrowsers, 0); assert.equal(health.sharedBrowserId, owner); assert.equal(received.size, 1);
  const standby = owner === 'tab-a' ? 'tab-b' : 'tab-a';
  await send(standby, { type: 'answer', requestId: a.requestId, text: 'Wrong tab answer' }); await send(standby, { type: 'stop', requestId: a.requestId, conversationId: cid(4) });
  await send(owner, { type: 'answer', requestId: a.requestId, text: 'Reply Topic A' }); await send(owner, { type: 'stop', requestId: a.requestId, conversationId: cid(3) });
  const body = await (await first).json(); assert.equal(body.session_id, sessions[0]); assert.equal(body.output[0].content[0].text, 'Reply Topic A'); received.clear();
  assert.equal((await (await fetch(base + '/health')).json()).availableBrowsers, 1);
  const second = post(sessions[1], 'Topic B'); const [bOwner, b] = await next(); assert.equal(bOwner, owner); assert.equal(b.text, 'Topic B');
  await send(bOwner, { type: 'answer', requestId: b.requestId, text: 'Reply Topic B' }); await send(bOwner, { type: 'stop', requestId: b.requestId, conversationId: cid(4) });
  assert.equal((await (await second).json()).output[0].content[0].text, 'Reply Topic B');
});
for (const mode of ['http', 'websocket']) test(`a standby ${mode} tab takes over only after the shared tab disconnects with nothing in flight`, async t => {
  const service = require('../dist/server.cjs').createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 1500, pollingLeaseMs: 100, bridgeToken: 'shared-tab' });
  const ports = await service.start(); t.after(() => service.close()); const base = `http://127.0.0.1:${ports.httpPort}`;
  const bridge = async (id, path, body) => (await fetch(base + '/bridge/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'shared-tab', 'X-Browser-Id': id }, body: JSON.stringify(body) })).json();
  const sockets = new Map(), received = new Map();
  const connect = async id => { if (mode === 'http') await bridge(id, 'poll', {}); else { const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}/?token=shared-tab&browserId=${id}`); await once(ws, 'open'); ws.on('message', raw => received.set(id, JSON.parse(raw))); sockets.set(id, ws); } };
  const health = async () => (await fetch(base + '/health')).json();
  await connect('tab-a'); await connect('tab-b'); assert.equal((await health()).sharedBrowserId, 'tab-a');
  const responding = fetch(base + '/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'Hold' }) });
  let request; for (let i = 0; i < 100 && !request; i++) { if (mode === 'http') request = (await bridge('tab-a', 'poll', {})).request; else request = received.get('tab-a'); await new Promise(r => setTimeout(r, 5)); }
  assert.ok(request); assert.equal(received.has('tab-b'), false); assert.equal((await health()).sharedBrowserId, 'tab-a');
  const send = async event => mode === 'http' ? bridge('tab-a', 'event', event) : sockets.get('tab-a').send(JSON.stringify(event));
  await send({ type: 'answer', requestId: request.requestId, text: 'Done' }); await send({ type: 'stop', requestId: request.requestId, conversationId: cid(3) }); assert.equal((await responding).status, 200);
  if (mode === 'http') { for (let i = 0; i < 30; i++) { await bridge('tab-b', 'poll', {}); await new Promise(r => setTimeout(r, 20)); } } else { const closed = once(sockets.get('tab-a'), 'close'); sockets.get('tab-a').close(); await closed; }
  for (let i = 0; i < 50 && (await health()).sharedBrowserId !== 'tab-b'; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal((await health()).sharedBrowserId, 'tab-b');
});
