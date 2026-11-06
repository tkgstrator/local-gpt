import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Drive the built service worker with a fake chrome runtime, packaged build-info.json and local server.
async function fixture({ buildInfo = { version: '2.4.14' }, manifest = '2.4.13', server = {}, holdTimers = false } = {}) {
  let listener;
  const state = { reloads: 0, buildInfo, buildInfoFetches: [], serverCalls: [], job: null, ready: { ready: true, expiresAt: Date.now() + 15000 }, holdTimers, timers: [], now: null };
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
    if (path === '/bridge/maintenance') { const body = JSON.parse(init.body); const o = state.maintenance?.(body); if (o !== undefined) return Response.json(o); return Response.json({ ready: true, lease: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 8000 }); }
    if (path === '/bridge/poll' || path === '/bridge/poll-v2') return Response.json({ request: state.job });
    if (path === '/bridge/update-ready') return Response.json(state.ready);
    return Response.json({ ok: true, accepted: true });
  };
  const source = await readFile('dist/extension/background.js', 'utf8');
  const NativeDate = Date;
  class Clock extends NativeDate { static now() { return state.now ?? NativeDate.now(); } }
  const schedule = (callback, delay, ...args) => state.holdTimers && delay === 200 ? state.timers.push(() => callback(...args)) : setTimeout(callback, delay, ...args);
  new Function('chrome', 'fetch', 'importScripts', 'LOCALGPT_PAIRING_TOKEN', 'Date', 'setTimeout', source)(chrome, fetch, () => {}, 'fixture-token', Clock, schedule);
  const sender = { id: 'our-id', url: 'https://chatgpt.com/', tab: { id: 7 }, frameId: 0, documentId: 'doc-a' };
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
  f.state.ready = { ready: true, expiresAt: Date.now() + 15000 };
  const granted = (await f.send('update-ready', { version: '2.4.14' })).data;
  assert.equal(granted.ready, true); assert.ok(Number.isFinite(granted.expiresAt) && granted.expiresAt > Date.now() && granted.expiresAt - Date.now() <= 60_000, 'ready response carries bounded future expiry');
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

test('sequenced idle polling preserves automatic update metadata after server response caching', async () => {
  const f = await fixture();
  const response = await f.send('poll-v2', { protocol: 1, epoch: '11111111-1111-4111-8111-111111111111', streamId: '22222222-2222-4222-8222-222222222222', activation: 1000, sequence: 1 });
  assert.equal(response.ok, true); assert.equal(response.data.request, null); assert.deepEqual(response.data.update, { version: '2.4.14' });
});

// Catches a runtime reload after the server refused, malformed, nearly expired, or invalidated the document transaction.
for (const [name, respond] of [
  ['refused acquire', body => body.action === 'acquire' ? { ready: false, reason: 'work_in_progress' } : undefined],
  ['malformed lease', body => body.action === 'acquire' ? { ready: true, lease: 'not-a-uuid', expiresAt: Date.now() + 8000 } : undefined],
  ['acquire expiring in under one second', body => body.action === 'acquire' ? { ready: true, lease: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 500 } : undefined],
  ['validate false', body => body.action === 'validate' ? { ready: false, reason: 'lease_expired' } : undefined],
  ['validate expiring in under one second', body => body.action === 'validate' ? { ready: true, expiresAt: Date.now() + 500 } : undefined],
]) test(`background reload fails closed and never calls runtime.reload after ${name}`, async () => {
  const f = await fixture(); f.state.maintenance = respond;
  await f.send('update-ready', { version: '2.4.14' });
  assert.equal((await f.send('reload', { version: '2.4.14' })).ok, false);
  await settle(); assert.equal(f.state.reloads, 0);
});


// A background service worker can wake long after a timer's requested delay.
for (const offset of [0, 1, 60000]) test(`deferred worker reload cannot execute at/after expiry (+${offset}ms)`, async () => {
  const f = await fixture({ holdTimers: true });
  await f.send('update-ready', { version: '2.4.14' });
  const reply = await f.send('reload', { version: '2.4.14' });
  assert.equal(reply.ok, true); assert.equal(f.state.timers.length, 1);
  f.state.now = reply.data.expiresAt + offset;
  await f.state.timers.shift()();
  assert.equal(f.state.reloads, 0, 'an expired callback must not invalidate new work');
});
test('deferred worker reload executes once before its immutable transaction deadline', async () => {
  const f = await fixture({ holdTimers: true });
  await f.send('update-ready', { version: '2.4.14' });
  const reply = await f.send('reload', { version: '2.4.14' });
  assert.equal(reply.ok, true);
  const before = f.state.serverCalls.filter(c => c.path === '/bridge/maintenance').length;
  f.state.now = reply.data.expiresAt - 1;
  await f.state.timers.shift()();
  assert.equal(f.state.reloads, 1);
  assert.equal(f.state.serverCalls.filter(c => c.path === '/bridge/maintenance').length, before,
    'validated exclusion is irrevocable until expiry; another network wait could invert worker/page reload order');
});
test('deferred worker reload cannot extend the original grant when validation advertises a later expiry', async () => {
  const f = await fixture({ holdTimers: true });
  const deadline = Date.now() + 4000;
  f.state.maintenance = body => ({ ready: true, lease: '11111111-1111-4111-8111-111111111111', expiresAt: body.action === 'acquire' ? deadline : deadline + 4000 });
  await f.send('update-ready', { version: '2.4.14' });
  const reply = await f.send('reload', { version: '2.4.14' });
  assert.equal(reply.ok, true); assert.equal(reply.data.expiresAt, deadline);
  f.state.now = deadline;
  await f.state.timers.shift()();
  assert.equal(f.state.reloads, 0);
});
