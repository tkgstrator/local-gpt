import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
// Catches a release whose packed extension requests broader grants than the deployed one, or whose version inputs drift.
test('built extension keeps the exact deployed least-privilege grants', async () => {
  const manifest = await json('dist/extension/manifest.json');
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'storage']);
  assert.equal(manifest.permissions.includes('tabs'), false, 'no broad tabs permission');
  assert.ok(manifest.host_permissions.includes('https://chatgpt.com/*'), 'ChatGPT host grant supplies URL access');
  assert.deepEqual([...manifest.host_permissions].sort(), ['http://127.0.0.1/*', 'https://chatgpt.com/*']);
  for (const key of ['optional_permissions', 'optional_host_permissions']) assert.equal(manifest[key], undefined, key);
});
test('package, extension, build-info, zip name, packed manifest and userscript versions align', async () => {
  const pkg = await json('package.json'); const version = pkg.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal((await json('extension/manifest.json')).version, version);
  assert.equal((await json('dist/extension/manifest.json')).version, version);
  assert.equal((await json('dist/extension/build-info.json')).version, version);
  const zipPath = `dist/localgpt-extension-${version}.zip`;
  const files = unzipSync(new Uint8Array(await readFile(zipPath)));
  const packed = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  assert.equal(packed.version, version);
  assert.deepEqual([...packed.permissions].sort(), ['alarms', 'storage']);
  assert.equal(JSON.parse(new TextDecoder().decode(files['build-info.json'])).version, version);
  for (const path of ['dist/chatgpt-api.user.js', 'src/userscript.header.txt'])
    assert.equal((await readFile(path, 'utf8')).match(/^\/\/ @version\s+(\S+)/m)?.[1], version, path);
});
