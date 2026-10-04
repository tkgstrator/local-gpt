import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

async function fixture(t, timeoutMs = 200) {
  const { createService } = require('../dist/server.cjs');
  const service = createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs });
  const ports = await service.start();
  t.after(() => service.close());
  const base = `http://127.0.0.1:${ports.httpPort}`;
  const post = (body = { messages: [{ role: 'user', content: 'hello' }] }) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);
    await once(ws, 'open');
    return ws;
  };
  return { base, post, connect };
}

test('unconnected browser returns 503 instead of a successful assistant answer', async t => {
  const response = process.env.BASELINE_URL
    ? await fetch(`${process.env.BASELINE_URL}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'local test' }] }) })
    : await (await fixture(t)).post();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'browser_disconnected');
});

if (!process.env.BASELINE_URL) {
  test('invalid HTTP input is rejected before contacting browser', async t => {
    const { post } = await fixture(t);
    assert.equal((await post({ messages: [{ role: 'user', content: 42 }] })).status, 400);
  });
  test('real WebSocket answer is correlated by id and preserves formatting', async t => {
    const { post, connect } = await fixture(t);
    const ws = await connect();
    ws.on('message', raw => {
      const request = JSON.parse(raw);
      ws.send(JSON.stringify({ type: 'answer', requestId: 'unrelated', text: 'wrong' }));
      ws.send(JSON.stringify({ type: 'answer', requestId: request.requestId, text: 'line one\nline two' }));
      ws.send(JSON.stringify({ type: 'stop', requestId: request.requestId }));
    });
    const response = await post();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'line one\nline two');
  });
  test('browser timeout returns 504', async t => {
    const { post, connect } = await fixture(t, 40);
    await connect();
    const response = await post();
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'browser_timeout');
  });
  test('malformed browser data fails pending request without crashing server', async t => {
    const { post, connect, base } = await fixture(t);
    const ws = await connect();
    ws.on('message', () => ws.send('{broken'));
    const response = await post();
    assert.equal(response.status, 502);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
  test('concurrent HTTP requests cannot mix answers', async t => {
    const { post, connect } = await fixture(t);
    const ws = await connect();
    const requestReceived = once(ws, 'message');
    const first = post();
    const [raw] = await requestReceived;
    assert.equal((await post()).status, 409);
    const { requestId } = JSON.parse(raw);
    ws.send(JSON.stringify({ type: 'answer', requestId, text: 'first only' }));
    ws.send(JSON.stringify({ type: 'stop', requestId }));
    assert.equal((await (await first).json()).choices[0].message.content, 'first only');
  });
  test('browser disconnect ends pending request', async t => {
    const { post, connect } = await fixture(t);
    const ws = await connect();
    ws.on('message', () => ws.close());
    assert.equal((await post()).status, 503);
  });
  test('browser DOM error reaches caller as an error', async t => {
    const { post, connect } = await fixture(t);
    const ws = await connect();
    ws.on('message', raw => ws.send(JSON.stringify({ type: 'error', requestId: JSON.parse(raw).requestId, code: 'editor_not_found', message: 'Input editor not found' })));
    const response = await post();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'editor_not_found');
  });
  test('stream returns content deltas and DONE once', async t => {
    const { post, connect } = await fixture(t);
    const ws = await connect();
    ws.on('message', raw => {
      const { requestId } = JSON.parse(raw);
      ws.send(JSON.stringify({ type: 'answer', requestId, text: 'hi' }));
      ws.send(JSON.stringify({ type: 'answer', requestId, text: 'hi there' }));
      ws.send(JSON.stringify({ type: 'stop', requestId }));
    });
    const response = await post({ messages: [{ role: 'user', content: 'hello' }], stream: true });
    const body = await response.text();
    assert.match(body, /"content":"hi"/);
    assert.match(body, /"content":" there"/);
    assert.equal(body.split('[DONE]').length - 1, 1);
  });
}

if (!process.env.BASELINE_URL) test('empty or whitespace user content returns 400 immediately', async t => {
  const { post, connect } = await fixture(t);
  await connect();
  for (const content of ['', '   ']) assert.equal((await post({ messages: [{ role: 'user', content }] })).status, 400);
});
