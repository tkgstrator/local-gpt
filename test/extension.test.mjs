import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
test('developer extension build includes every declared script', async () => {
  const manifest = JSON.parse(await readFile('dist/extension/manifest.json', 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  for (const file of [manifest.background.service_worker, ...manifest.content_scripts.flatMap(script => script.js), manifest.action.default_popup]) assert.ok((await readFile(`dist/extension/${file}`)).length > 0);
});
test('background rejects requests originating from another site', async () => {
  const { handleBridgeMessage } = require('../dist/extension-handler.cjs');
  const result = await handleBridgeMessage({ type: 'bridge_request', path: 'poll', browserId: 'tab1', data: {} }, { id: 'our-id', url: 'https://example.com/', tab: { id: 1 }, frameId: 0 }, { extensionId: 'our-id', token: 'fixture' });
  assert.equal(result.ok, false); assert.equal(result.error, 'Unauthorized content script');
});
test('background rejects arbitrary network URLs', async () => {
  const { handleBridgeMessage } = require('../dist/extension-handler.cjs');
  const result = await handleBridgeMessage({ type: 'bridge_request', path: 'https://example.com/', browserId: 'tab1', data: {} }, { id: 'our-id', url: 'https://chatgpt.com/', tab: { id: 1 }, frameId: 0 }, { extensionId: 'our-id', token: 'fixture' });
  assert.equal(result.ok, false); assert.equal(result.error, 'Invalid bridge request');
});
test('an unpaired public download never forwards unauthenticated bridge traffic', async () => {
  const { handleBridgeMessage } = require('../dist/extension-handler.cjs');
  const result = await handleBridgeMessage({ type: 'bridge_request', path: 'poll', browserId: 'tab1', data: {} },
    { id: 'our-id', url: 'https://chatgpt.com/', tab: { id: 1 }, frameId: 0 },
    { extensionId: 'our-id', token: '' }, async () => { throw new Error('Network must not be called'); });
  assert.equal(result.ok, false);
  assert.match(result.error, /pairing is missing/);
});

test('extension archive filename follows the manifest version',async()=>{
 const manifest=JSON.parse(await readFile('dist/extension/manifest.json','utf8'));const archive=await readFile(`dist/localgpt-extension-${manifest.version}.zip`);assert.equal(archive.subarray(0,2).toString(),'PK');
});

test('background delivers native and legacy requests without activating Chrome', async () => {
  let listener;
  const activationCalls = [];
  let fetched = false;
  const chrome = {
    runtime: { id: 'our-id', onMessage: { addListener: fn => { listener = fn; } } },
    tabs: { update: async (id, options) => {
      activationCalls.push({ api: 'tabs.update', id, options });
      return { id, windowId: 2 };
    } },
    windows: { update: async (id, options) => {
      activationCalls.push({ api: 'windows.update', id, options });
    } },
  };
  let job = null;
  const fetch = async () => { fetched = true; return Response.json({ request: job }); };
  new Function('chrome', 'fetch', 'importScripts', 'LOCALGPT_PAIRING_TOKEN', await readFile('dist/extension/background.js', 'utf8'))(chrome, fetch, () => {}, 'fixture');
  const request = { type: 'bridge_request', path: 'poll', browserId: 'tab1', data: {} };
  const sender = { id: 'our-id', url: 'https://chatgpt.com/', tab: { id: 7 }, frameId: 0 };
  const invoke = sender => new Promise(resolve => listener(request, sender, resolve));
  assert.equal((await invoke(sender)).ok, true);
  assert.deepEqual(activationCalls, []);
  const jobs = [
    { type: 'request', requestId: 'legacy1', text: 'Hello', newChat: true },
    { type: 'native_readiness', requestId: 'readiness1' },
    { type: 'request', requestId: 'native1', text: 'Hello', newChat: true,
      native: true, model: 'gpt-6-instant',
      nativeUserMessageId: '00000000-0000-4000-8000-000000000001' },
    { type: 'models', requestId: 'models1' },
    { type: 'capabilities', requestId: 'capabilities1' },
  ];
  for (job of jobs) {
    const response = await invoke(sender);
    assert.equal(response.ok, true);
    assert.deepEqual(response.data.request, job);
    assert.deepEqual(activationCalls, [], job.type);
  }
  fetched = false;
  assert.equal((await invoke({ ...sender, url: 'https://example.com/' })).ok, false);
  assert.equal(fetched, false);
  assert.deepEqual(activationCalls, []);
});
