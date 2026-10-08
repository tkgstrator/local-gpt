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

test('background activates only the requesting ChatGPT tab when a job arrives', async () => {
  let listener;
  let activeTab = 99;
  let focusedWindow = 9;
  let fetched = false;
  const chrome = {
    runtime: { id: 'our-id', onMessage: { addListener: fn => { listener = fn; } } },
    tabs: { update: async (id, options) => {
      assert.equal(fetched, true);
      assert.deepEqual(options, { active: true });
      activeTab = id;
      return { id, windowId: 2 };
    } },
    windows: { update: async (id, options) => {
      assert.deepEqual(options, { focused: true });
      focusedWindow = id;
    } },
  };
  let job = null;
  const fetch = async () => { fetched = true; return Response.json({ request: job }); };
  new Function('chrome', 'fetch', 'importScripts', 'LOCALGPT_PAIRING_TOKEN', await readFile('dist/extension/background.js', 'utf8'))(chrome, fetch, () => {}, 'fixture');
  const request = { type: 'bridge_request', path: 'poll', browserId: 'tab1', data: {} };
  const sender = { id: 'our-id', url: 'https://chatgpt.com/', tab: { id: 7 }, frameId: 0 };
  const invoke = sender => new Promise(resolve => listener(request, sender, resolve));
  assert.equal((await invoke(sender)).ok, true);
  assert.equal(activeTab, 99);
  job = { type: 'request', requestId: 'job1', text: 'Hello', newChat: true };
  const response = await invoke(sender);
  assert.equal(response.ok, true);
  assert.equal(response.data.request.requestId, 'job1');
  assert.equal(activeTab, 7);
  assert.equal(focusedWindow, 2);
  activeTab = 99;
  assert.equal((await invoke({ ...sender, url: 'https://example.com/' })).ok, false);
  assert.equal(activeTab, 99);
});
