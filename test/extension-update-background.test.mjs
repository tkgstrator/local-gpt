import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Drive the built service worker with a fake chrome runtime, packaged build-info.json and local server.
async function fixture({ buildInfo = { version: '2.4.14' }, manifest = '2.4.13', server = {} } = {}) {
  let listener;
  const state = { reloads: 0, buildInfo, buildInfoFetches: [], serverCalls: [], job: null, ready: { ready: true } };
  const chrome = {
    runtime: {
      id: 'our-id',
      onMessage: { addListener: fn => { listener = fn; } },
      getURL: path => `chrome-extension://our-id/${path}`,
      getManifest: () => ({ version: manifest }),
      reload: () => { state.reloads++; },
    },
    tabs: { update: async (id) => ({ id, windowId: 1 }) },
    windows: { update: async () => {} },
  };
  const fetch = async (url, init = {}) => {
    if (String(url).startsWith('chrome-extension://')) {
      state.buildInfoFetches.push({ url: String(url), cache: init.cache });
      if (state.buildInfo instanceof Error) throw state.buildInfo;
      return new Response(typeof state.buildInfo === 'string' ? state.buildInfo : JSON.stringify(state.buildInfo));
    }
    const path = new URL(url).pathname;
    state.serverCalls.push({ path, body: JSON.parse(init.body), headers: init.headers });
    if (path === '/bridge/poll') return Response.json({ request: state.job });
    if (path === '/bridge/update-ready') return Response.json(state.ready);
    return Response.json({ ok: true, accepted: true });
  };
  const source = await readFile('dist/extension/background.js', 'utf8');
  new Function('chrome', 'fetch', 'importScripts', 'LOCALGPT_PAIRING_TOKEN', source)(chrome, fetch, () => {}, 'fixture-token');
  const sender = { id: 'our-id', url: 'https://chatgpt.com/', tab: { id: 7 }, frameId: 0 };
  const send = (path, data = {}, from = sender) => new Promise(resolve => listener({ type: 'bridge_request', path, browserId: 'tab1', data }, from, resolve));
  return { state, send, sender };
}
const settle = () => new Promise(r => setTimeout(r, 400));

test('idle poll carries update metadata read from packaged build-info without cache', async () => {
  const f = await fixture();
  const response = await f.send('poll');
  assert.equal(response.ok, true);
  assert.equal(response.data.request, null);
  assert.deepEqual(response.data.update, { version: '2.4.14' });
  assert.deepEqual(f.state.buildInfoFetches, [{ url: 'chrome-extension://our-id/build-info.json', cache: 'no-store' }]);
});

test('poll delivering a queued request never carries update metadata', async () => {
  const f = await fixture();
  f.state.job = { type: 'request', requestId: 'job1', text: 'Hello', newChat: true };
  const response = await f.send('poll');
  assert.equal(response.data.request.requestId, 'job1');
  assert.equal('update' in response.data, false);
});

test('unavailable, malformed or matching build-info simply skips update metadata', async () => {
  for (const buildInfo of [new Error('missing'), 'not json', { version: 'latest' }, { version: '2.4.13' }, { other: 1 }]) {
    const f = await fixture({ buildInfo });
    const response = await f.send('poll');
    assert.equal(response.ok, true, String(buildInfo));
    assert.equal(response.data.request, null);
    assert.equal('update' in response.data, false, JSON.stringify(String(buildInfo)));
  }
});

test('runtime reload requires a fresh server drain lease for the same tab and version', async () => {
  const f = await fixture();
  // No lease yet.
  assert.equal((await f.send('reload', { version: '2.4.14' })).ok, false);
  await settle(); assert.equal(f.state.reloads, 0);
  // Server refuses the lease.
  f.state.ready = { ready: false, reason: 'browser_busy' };
  assert.deepEqual((await f.send('update-ready', { version: '2.4.14' })).data, { ready: false, reason: 'browser_busy' });
  assert.equal((await f.send('reload', { version: '2.4.14' })).ok, false);
  // Server grants it; the forwarded call is authenticated with the pairing token.
  f.state.ready = { ready: true };
  assert.deepEqual((await f.send('update-ready', { version: '2.4.14' })).data, { ready: true });
  const forwarded = f.state.serverCalls.at(-1);
  assert.equal(forwarded.path, '/bridge/update-ready');
  // Same pairing header as ordinary polls; compared without printing the key.
  await f.send('poll');
  const pollKey = f.state.serverCalls.findLast(c => c.path === '/bridge/poll').headers['X-Bridge-Token'];
  assert.ok(typeof pollKey === 'string' && pollKey.length > 0 && forwarded.headers['X-Bridge-Token'] === pollKey, 'update-ready must carry the pairing key');
  assert.deepEqual(forwarded.body, { version: '2.4.14' });
  // Another tab or another version cannot use this lease.
  assert.equal((await f.send('reload', { version: '2.4.14' }, { ...f.sender, tab: { id: 8 } })).ok, false);
  assert.equal((await f.send('reload', { version: '2.4.15' })).ok, false);
  await settle(); assert.equal(f.state.reloads, 0);
  assert.equal((await f.send('reload', { version: '2.4.14' })).ok, true);
  await settle(); assert.equal(f.state.reloads, 1);
});

test('reload is refused from unauthorized senders and when files on disk changed again', async () => {
  const f = await fixture();
  assert.equal((await f.send('update-ready', { version: '2.4.14' }, { ...f.sender, url: 'https://example.com/' })).ok, false);
  assert.equal(f.state.serverCalls.length, 0);
  await f.send('update-ready', { version: '2.4.14' });
  assert.equal((await f.send('reload', { version: '2.4.14' }, { ...f.sender, frameId: 3 })).ok, false);
  f.state.buildInfo = { version: '2.4.15' };
  assert.equal((await f.send('reload', { version: '2.4.14' })).ok, false);
  await settle(); assert.equal(f.state.reloads, 0);
});

test('old content script messages still work against the new background', async () => {
  const f = await fixture({ buildInfo: { version: '2.4.13' } });
  assert.deepEqual((await f.send('poll')).data, { request: null });
  assert.equal((await f.send('event', { type: 'heartbeat' })).ok, true);
});
