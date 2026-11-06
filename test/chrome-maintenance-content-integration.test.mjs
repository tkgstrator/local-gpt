import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
const { createService } = createRequire(import.meta.url)('../dist/server.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, message, limit = 3000) => {
  for (let elapsed = 0; elapsed < limit; elapsed += 20) { const value = await predicate(); if (value) return value; await wait(20); }
  assert.fail(message);
};
const EXTENSION_ID = 'test-extension';
const SENDER = { id: EXTENSION_ID, url: 'https://chatgpt.com/', tab: { id: 7 }, frameId: 0, documentId: 'doc-a' };

// Production content -> production background -> production loopback server; only Chrome/page boundaries are doubles.
async function fixture(t) {
  const token = (await readFile('.bridge-token', 'utf8')).trim();
  const service = createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 500, bridgeToken: token });
  const { httpPort } = await service.start();
  const base = `http://127.0.0.1:${httpPort}`;
  const window = new Window({ url: 'https://chatgpt.com/' });
  window.document.body.innerHTML = '<button aria-label="New chat">New chat</button><div role="textbox" contenteditable="true"></div><button aria-label="Send" disabled>Send</button>';
  t.after(async () => { window.dispatchEvent(new window.Event('pagehide')); await window.happyDOM.abort(); window.close(); await service.close(); });
  await window.happyDOM.waitUntilComplete();

  const state = { failMaintenance: false, polls: 0, reloads: 0, maintenance: [] };
  const localFetch = async (url, init) => {
    const text = String(url);
    if (text.startsWith('chrome-extension://')) return Response.json({ version: '2.6.12' }); // never newer: no automatic update
    const path = new URL(text).pathname;
    if (path === '/bridge/maintenance') {
      state.maintenance.push(JSON.parse(init.body).action);
      if (state.failMaintenance) throw new TypeError('simulated maintenance transport failure');
    }
    if (path === '/bridge/poll-open' || path === '/bridge/poll-v2') state.polls++;
    return fetch(base + path, init);
  };
  let backgroundListener, contentListener; const storage = {};
  const backgroundChrome = {
    runtime: { id: EXTENSION_ID, getURL: file => 'chrome-extension://test/' + file, getManifest: () => ({ version: '2.6.12' }), reload() { throw new Error('background must not reload the extension'); },
      onMessage: { addListener: fn => { backgroundListener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
    alarms: { get: async () => undefined, create() {}, onAlarm: { addListener() {} } }, // never fired: probing/acquiring is manual
    storage: { local: { get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value) } },
    tabs: { get: async id => ({ id, url: 'https://chatgpt.com/' }), sendMessage: async () => { throw new Error('watchdog is not exercised'); }, onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
  };
  new Function('chrome', 'fetch', 'importScripts', 'LOCALGPT_PAIRING_TOKEN', await readFile('dist/extension/background.js', 'utf8'))(backgroundChrome, localFetch, () => {}, token);
  assert.equal(typeof backgroundListener, 'function');
  window.chrome = { runtime: { id: EXTENSION_ID,
    sendMessage: message => new Promise(resolve => backgroundListener(message, SENDER, resolve)),
    onMessage: { addListener: fn => { contentListener = fn; } } } };
  const location = new Proxy(window.location, { get: (target, key) => key === 'reload' ? () => { state.reloads++; } : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
  const globals = ['unsafeWindow', 'CustomEvent', 'chrome', 'window', 'document', 'location', 'HTMLTextAreaElement', 'sessionStorage', 'crypto', 'setTimeout', 'clearTimeout'];
  const values = globals.map(key => key === 'window' || key === 'unsafeWindow' ? window : key === 'location' ? location : ['setTimeout', 'clearTimeout'].includes(key) ? window[key].bind(window) : window[key]);
  new Function(...globals, await readFile('dist/extension/content.js', 'utf8'))(...values);
  assert.equal(typeof contentListener, 'function');

  const headers = { 'Content-Type': 'application/json', 'X-Bridge-Token': token };
  const post = async (path, body, extra = {}) => fetch(`${base}/bridge/${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const maintenance = async body => { const response = await post('maintenance', body); assert.equal(response.status, 200); return response.json(); };
  const send = message => new Promise(resolve => { contentListener(message, { id: EXTENSION_ID }, resolve); });
  const target = await until(async () => (await maintenance({ action: 'probe' })).target, 'real content polling never selected a document');
  assert.deepEqual({ tabId: target.tabId, documentId: target.documentId }, { tabId: 7, documentId: 'doc-a' });
  const browserId = target.browserId.slice('7:'.length);
  assert.match(browserId, /\S/);
  const safety = await send({ type: 'localgpt_maintenance_safety', browserId });
  assert.deepEqual({ browserId: safety.browserId, safe: safety.safe }, { browserId, safe: true });
  const acquire = async () => { const grant = await maintenance({ action: 'acquire', target }); assert.equal(grant.ready, true); return grant; };
  const reload = grant => send({ type: 'localgpt_maintenance_reload', browserId, lease: grant.lease, expiresAt: grant.expiresAt });
  const pollsKeepGoing = async () => { const before = state.polls; await until(() => state.polls > before, 'content stopped polling'); };
  return { state, target, maintenance, post, acquire, reload, pollsKeepGoing };
}

test('exact validated lease reloads the content document once and stops polling', async t => {
  const f = await fixture(t); const grant = await f.acquire();
  assert.deepEqual(await f.reload(grant), { reloading: true });
  assert.equal(f.state.reloads, 1); assert.ok(f.state.maintenance.includes('validate'));
  await wait(800); const settled = f.state.polls; await wait(800);
  assert.equal(f.state.polls, settled, 'stopped content must not poll again'); assert.equal(f.state.reloads, 1);
});

const refusals = {
  invalidated: (f, grant) => f.maintenance({ action: 'invalidate', target: f.target }),
  replaced: async f => {
    const headers = { 'X-Browser-Id': f.target.browserId, 'X-Chrome-Tab-Id': '7', 'X-Chrome-Document-Id': 'doc-new' };
    const streamId = crypto.randomUUID(), activation = Date.now() + 1000;
    const opened = await (await f.post('poll-open', { protocol: 1, streamId, activation }, headers)).json();
    assert.equal(opened.error, undefined);
    const read = await (await f.post('poll-v2', { protocol: 1, streamId, activation, epoch: opened.epoch, sequence: 1 }, headers)).json();
    assert.equal(read.error, undefined);
    assert.equal((await f.maintenance({ action: 'probe' })).target.documentId, 'doc-new');
  },
  cancelled: (f, grant) => f.maintenance({ action: 'cancel', target: f.target, lease: grant.lease }),
};
for (const [name, invalidate] of Object.entries(refusals)) test(`${name} unvalidated lease is refused by the real server without reload or polling stop`, async t => {
  const f = await fixture(t); const grant = await f.acquire(); await invalidate(f, grant);
  assert.deepEqual(await f.reload(grant), { reloading: false });
  assert.equal(f.state.reloads, 0); assert.ok(f.state.maintenance.includes('validate'));
  await f.pollsKeepGoing();
});

test('validation transport failure refuses reload and keeps polling', async t => {
  const f = await fixture(t); const grant = await f.acquire(); f.state.failMaintenance = true;
  const validations = f.state.maintenance.filter(action => action === 'validate').length;
  assert.deepEqual(await f.reload(grant), { reloading: false });
  f.state.failMaintenance = false;
  assert.equal(f.state.maintenance.filter(action => action === 'validate').length, validations + 1, 'validation was attempted through the background');
  assert.equal(f.state.reloads, 0); await f.pollsKeepGoing();
  await f.maintenance({ action: 'cancel', target: f.target, lease: grant.lease });
});
