import { test, installNativeEditing } from './test-support.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
const require = createRequire(import.meta.url);
const { createService } = require('../dist/server.cjs');

for (const userOnlyConversation of [false, true, 'empty-route', 'extension']) test(`built userscript completes HTTP/API-stream round trip${userOnlyConversation === 'extension' ? ' as a developer extension' : userOnlyConversation === 'empty-route' ? ' after asynchronous route navigation' : userOnlyConversation ? ' from a user-only previous conversation' : ''}`, { timeout: 10000 }, async t => {
  const token = (await readFile('.bridge-token', 'utf8')).trim();
  const service = createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 7000, bridgeToken: token });
  const { httpPort } = await service.start();
  const base = `http://127.0.0.1:${httpPort}`;
  const page = { window: new Window({ url: userOnlyConversation === 'empty-route' ? 'https://chatgpt.com/c/previous' : 'https://chatgpt.com/' }) };
  page.window.document.body.innerHTML = '<button aria-label="New chat">New chat</button><div role="textbox" contenteditable="true"></div><button aria-label="Send" disabled>Send</button>' + (userOnlyConversation === true ? '<div data-message-author-role="user">previous failed message</div>' : '');
  t.after(async () => { page.window.dispatchEvent(new page.window.Event('pagehide')); await page.window.happyDOM.abort(); page.window.close(); await service.close(); });
  await page.window.happyDOM.waitUntilComplete();
  // These are browser boundary doubles; the production bundle, schemas, server,
  // HTTP transport, editor changes and response handling are all exercised.
  page.window.WebSocket = class { constructor() { throw new Error('CSP blocked WebSocket'); } };
  page.window.GM_xmlhttpRequest = options => {
    const target = new URL(options.url);
    // An old server ignores opt-in native negotiation and sends legacy requests.
    const body=target.pathname==='/bridge/poll'?'{}':options.data;
    void fetch(`${base}${target.pathname}`, { method: options.method, headers: options.headers, body }).then(async response => options.onload({ status: response.status, responseText: await response.text() }), options.onerror);
  };
  installNativeEditing(page.window);
  const editor = page.window.document.querySelector('[role="textbox"]');
  const send = page.window.document.querySelector('button[aria-label="Send"]');
  let newChatClicked = false;
  page.window.document.querySelector('[aria-label="New chat"]').addEventListener('click', () => { newChatClicked = true; if (userOnlyConversation === 'empty-route') { setTimeout(() => page.window.history.pushState({}, '', '/'), 200); } for (const node of page.window.document.querySelectorAll('[data-message-author-role]')) node.remove(); });
  editor.addEventListener('input', () => { send.disabled = false; });
  const conversationId = '6ac07bb1-b2b4-43e8-8304-5424a5cf2ef3';
  const messageId = 'f5eadb59-b96e-4ef5-9342-2f49d62b3c6f';
  page.window.fetch = async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    const message = { id: '094c6dd5-45d0-4da3-bd50-a79ef778addb', author: { role: 'assistant' }, channel: 'final', recipient: 'all', content: { content_type: 'text', parts: ['Synthetic answer\nwith formatting'] }, status: 'finished_successfully', end_turn: true };
    return new Response(`data: ${JSON.stringify({ message, conversation_id: conversationId })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  let submitted;
  send.addEventListener('click', () => {
    assert.equal(page.window.location.pathname, '/');
    submitted = editor.textContent;
    editor.textContent = '';
    void page.window.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ messages: [{ id: messageId, author: { role: 'user' }, content: { content_type: 'text', parts: [submitted] } }] }) });
  });
  if (userOnlyConversation === 'extension') {
    let listener;
    const workerChrome = {
      runtime: { id: 'test-extension', onMessage: { addListener: fn => { listener = fn; } } },
      tabs: { update: async id => ({ id, windowId: 1 }) },
      windows: { update: async () => ({ id: 1 }) },
    };
    const localFetch = (url, options) => fetch(`${base}${new URL(url).pathname}`, {...options,...(new URL(url).pathname==='/bridge/poll'?{body:'{}'}:{})});
    new Function('chrome', 'fetch', 'importScripts', 'LOCALGPT_PAIRING_TOKEN', await readFile('dist/extension/background.js', 'utf8'))(workerChrome, localFetch, () => {}, token);
    page.window.chrome = { runtime: { sendMessage: message => new Promise(resolve => listener(message, { id: 'test-extension', url: 'https://chatgpt.com/', tab: { id: 1 }, frameId: 0 }, resolve)) } };
  }
  const globals = ['unsafeWindow', 'CustomEvent', 'chrome', 'window', 'document', 'location', 'HTMLTextAreaElement', 'WebSocket', 'GM_xmlhttpRequest', 'crypto', 'setTimeout', 'clearTimeout'];
  const values = globals.map(key => key === 'window' || key === 'unsafeWindow' ? page.window : typeof page.window[key] === 'function' && ['setTimeout', 'clearTimeout'].includes(key) ? page.window[key].bind(page.window) : page.window[key]);
  if (userOnlyConversation === 'extension') new Function('window', await readFile('dist/extension/page.js','utf8'))(page.window);
  new Function(...globals, await readFile(userOnlyConversation === 'extension' ? 'dist/extension/content.js' : 'dist/chatgpt-api.user.js', 'utf8'))(...values);
  for (let i = 0; i < 60; i++) {
    if ((await (await fetch(`${base}/health`)).json()).browserConnected) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const response = await fetch(`${base}/v1/${userOnlyConversation === 'extension' ? 'responses' : 'chat/completions'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(userOnlyConversation === 'extension' ? { input: 'Test input\nsecond line' } : { messages: [{ role: 'user', content: 'Test input\nsecond line' }] }) });
  assert.equal(response.status, 200);
  assert.equal(submitted, 'Test input\nsecond line');
  assert.equal(newChatClicked, userOnlyConversation === true || userOnlyConversation === 'empty-route');
  const result = await response.json();
  assert.equal(userOnlyConversation === 'extension' ? result.output[0].content[0].text : result.choices[0].message.content, 'Synthetic answer\nwith formatting');
});
