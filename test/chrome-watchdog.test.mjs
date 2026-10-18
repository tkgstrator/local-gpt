import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
async function fixture(storage = {}, existingAlarm) {
  const target = { tabId: 7, documentId: 'doc-a', browserId: '7:browser-a' };
  const state = { now: 30_000_000, alarms: [], currentAlarm: existingAlarm, calls: [], messages: [], reloads: 0, ready: true, safe: true, connected: true, deferred: null, target, storage, noReply: false, outage: false, changed: false, expire: false, startedAt: 1, expiryReply: 'normal', leaseReply: '11111111-1111-4111-8111-111111111111', refuseReload: false, commits: 0 };
  let alarm, startup, installed, removed, updated;
  const chrome = {
    runtime: { id: 'extension', getManifest: () => ({ version: '2.6.10' }), getURL: p => 'chrome-extension://extension/' + p,
      onMessage: { addListener() {} }, onStartup: { addListener: f => startup = f }, onInstalled: { addListener: f => installed = f } },
    alarms: { get: async () => state.currentAlarm, create: (name, options) => { state.currentAlarm = {name, ...options, scheduledTime: state.now + 60_000}; state.alarms.push(state.currentAlarm); }, onAlarm: { addListener: f => alarm = f } },
    storage: { local: { get: async key => ({ [key]: storage[key] }), set: async data => Object.assign(storage, data) } },
    tabs: { get: async id => ({ id, url: state.changed ? 'https://example.com/' : 'https://chatgpt.com/' }),
      sendMessage: async (id, message, options) => {
        state.messages.push({ id, message, options });
        assert.equal(id, 7); assert.equal(options.documentId, state.target.documentId);
        if (state.noReply) throw new Error('Receiving end does not exist');
        if (message.type === 'localgpt_maintenance_reload') { state.commits++; if (state.refuseReload) return { reloading: false }; state.reloads++; return { reloading: true }; }
        return { browserId: 'browser-a', safe: state.safe, startedAt: state.startedAt };
      }, onRemoved: { addListener: fn => removed = fn }, onUpdated: { addListener: fn => updated = fn } },
  };
  const fetch = async (url, init) => {
    state.calls.push(JSON.parse(init.body)); if (state.outage) throw new Error('offline');
    const r = state.calls.at(-1);
    if (r.action === 'probe') return Response.json({ target: state.target, connected: state.connected, deferred: state.deferred });
    if (r.action === 'acquire') return Response.json({ ready: state.ready, lease: state.leaseReply, ...(state.expiryReply === 'missing' ? {} : { expiresAt: state.expiryReply === 'normal' ? state.now + (state.expire ? 10 : 8000) : state.expiryReply }) });
    return Response.json({ ready: true, expiresAt: state.now + 8000 });
  };
  class Clock extends Date { static now() { return state.now; } }
  new Function('chrome','fetch','importScripts','LOCALGPT_PAIRING_TOKEN','Date', await readFile('dist/extension/background.js','utf8'))(chrome, fetch, () => {}, 'paired-key', Clock);
  const tick = async () => { alarm?.({ name: 'localgpt-connection-watchdog' }); await new Promise(r => setTimeout(r, 25)); };
  await new Promise(r => setTimeout(r, 25));
  return { state, tick, removed: () => removed?.(7), updated: (change = { status: 'loading' }) => updated?.(7, change), startup: () => startup?.(), installed: () => installed?.() };
}
// Catches missing alarm installation, lost persistent budgets, or healthy polls resetting refresh age.
test('watchdog cold start schedules minute alarms and refreshes an old safe existing document once', async () => {
  const f = await fixture();
  assert.ok(f.state.alarms.some(a => a.periodInMinutes === 1));
  await f.tick(); assert.equal(f.state.reloads, 1);
  const calls = f.state.calls.filter(c => c.action === 'acquire'); assert.equal(calls.length, 1);
  assert.ok(f.state.messages.some(m => m.message.type === 'localgpt_maintenance_reload'));
  await f.tick(); assert.equal(f.state.reloads, 1);
  const restart = await fixture(f.state.storage); await restart.tick(); assert.equal(restart.state.reloads, 0);
  restart.startup(); restart.installed(); await new Promise(r => setTimeout(r, 25)); assert.equal(restart.state.alarms.length, 1);
});
for (const [name, change] of [
  ['unknown server work', s => s.deferred = 'work_in_progress'],
  ['unsafe renderer', s => s.safe = false],
  ['unresponsive renderer', s => s.noReply = true],
  ['server outage', s => s.outage = true],
  ['navigated tab', s => s.changed = true],
  ['competing admission', s => s.ready = false],
  ['expiring transaction', s => s.expire = true],
]) test(`watchdog defers ${name} without any reload`, async () => { const f = await fixture(); change(f.state); await f.tick(); assert.equal(f.state.reloads, 0); });

test('closing or navigating the selected tab invalidates its exact server identity', async () => {
  const f = await fixture(); await f.tick(); f.removed(); await new Promise(r => setTimeout(r, 25));
  assert.ok(f.state.calls.some(c => c.action === 'invalidate' && c.target.documentId === 'doc-a'));
  const g = await fixture(); g.updated(); await new Promise(r => setTimeout(r, 25));
  assert.ok(g.state.calls.some(c => c.action === 'invalidate' && c.target.tabId === 7));
});

test('successful replacement documents remain eligible for each six-hour maintenance interval', async () => {
  const f = await fixture(); await f.tick(); assert.equal(f.state.reloads, 1);
  for (let i = 1; i <= 3; i++) {
    f.state.now += 60_000; f.state.startedAt = f.state.now; f.state.target = { ...f.state.target, documentId: 'doc-' + i };
    await f.tick(); assert.equal(f.state.reloads, i, 'a fresh page is not reloaded');
    f.state.now += 6 * 60 * 60 * 1000; await f.tick(); assert.equal(f.state.reloads, i + 1, 'healthy heartbeats cannot postpone the six-hour age');
  }
});
test('a disconnected recent page may recover through the same fresh safety and transaction guards', async () => {
  const f = await fixture(); f.state.startedAt = f.state.now; f.state.connected = false; await f.tick();
  assert.equal(f.state.reloads, 1);
});

for (const expiry of ['missing', 'not-a-time']) test(`malformed maintenance expiry ${expiry} cannot authorize reload`, async () => {
  const f = await fixture(); f.state.expiryReply = expiry; await f.tick(); assert.equal(f.state.reloads, 0);
});
test('a malformed maintenance transaction identifier cannot authorize reload', async () => {
  const f = await fixture(); f.state.leaseReply = 'not-an-opaque-transaction'; await f.tick(); assert.equal(f.state.reloads, 0);
});

test('failed replacement documents retain their budget until healthy polling is confirmed', async () => {
  const f = await fixture(); f.state.connected = false; await f.tick(); assert.equal(f.state.reloads, 1);
  f.state.now += 15 * 60 * 1000 + 1; f.state.startedAt = f.state.now; f.state.target = { ...f.state.target, documentId: 'failed-replacement-one' };
  await f.tick(); assert.equal(f.state.reloads, 2);
  f.state.now += 15 * 60 * 1000 + 1; f.state.startedAt = f.state.now; f.state.target = { ...f.state.target, documentId: 'failed-replacement-two' };
  await f.tick(); assert.equal(f.state.reloads, 2, 'a new document without healthy polling is not recovery');
  const state = f.state.storage['localgpt-maintenance-v1']; assert.equal(state.attempts.length, 2); assert.equal(state.recoveredAt, undefined);
  const restarted = await fixture(f.state.storage); restarted.state.connected = false; restarted.state.now = f.state.now + 15 * 60 * 1000 + 1; restarted.state.target = { ...restarted.state.target, documentId: 'failed-after-worker-restart' }; restarted.state.startedAt = restarted.state.now;
  await restarted.tick(); assert.equal(restarted.state.reloads, 0, 'cold worker restart cannot reset the failed-attempt budget');
  f.state.connected = true; await f.tick(); assert.equal(state.attempts.length, 0); assert.equal(state.pending, undefined);
  assert.equal(state.recoveredAt, f.state.now); assert.equal(f.state.reloads, 2);
  f.state.connected = false; await f.tick(); assert.equal(f.state.reloads, 3, 'confirmed healthy polling releases the failed-attempt budget');
});

test('two explicit draft-race refusals do not exhaust the later real recovery budget', async () => {
  const f = await fixture(); f.state.refuseReload = true;
  await f.tick(); await f.tick(); assert.equal(f.state.commits, 2, 'known refusals roll back cooldown too');
  const stored = f.state.storage['localgpt-maintenance-v1']; assert.equal(stored.pending, undefined); assert.equal(stored.attempts?.length ?? 0, 0);
  f.state.refuseReload = false; await f.tick(); assert.equal(f.state.reloads, 1);
});

test('cold workers preserve an existing minute alarm countdown across repeated startup events', async () => {
  const existing = { name: 'localgpt-connection-watchdog', periodInMinutes: 1, scheduledTime: 30_000_123 };
  const f = await fixture({}, existing); f.startup(); f.installed(); await new Promise(r => setTimeout(r, 25));
  assert.equal(f.state.alarms.length, 0, 'waking a worker must not postpone an existing alarm');
  assert.equal(f.state.currentAlarm.scheduledTime, 30_000_123);
  await f.tick(); assert.equal(f.state.reloads, 1, 'the preserved alarm still drives maintenance');
  const wrong = await fixture({}, { ...existing, periodInMinutes: 5 });
  assert.equal(wrong.state.alarms.length, 1); assert.equal(wrong.state.currentAlarm.periodInMinutes, 1);
});
test('URL-only ChatGPT route updates preserve the selected document until actual loading', async () => {
  const f = await fixture(); f.updated({ url: 'https://chatgpt.com/c/same-document-route' }); await new Promise(r => setTimeout(r, 25));
  assert.equal(f.state.calls.some(c => c.action === 'invalidate'), false);
  f.updated({ status: 'loading', url: 'https://chatgpt.com/' }); await new Promise(r => setTimeout(r, 25));
  assert.equal(f.state.calls.filter(c => c.action === 'invalidate').length, 1);
});
