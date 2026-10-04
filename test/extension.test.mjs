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

test('extension archive filename follows the manifest version',async()=>{
 const manifest=JSON.parse(await readFile('dist/extension/manifest.json','utf8'));const archive=await readFile(`dist/localgpt-extension-${manifest.version}.zip`);assert.equal(archive.subarray(0,2).toString(),'PK');
});
