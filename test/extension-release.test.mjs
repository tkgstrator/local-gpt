import { test, expect } from 'bun:test';
import { validateExtensionRelease } from '../scripts/extension-release.mjs';

function snapshot(version, code = 'export const value = 1') {
  return new Map([
    ['extension/manifest.json', JSON.stringify({ version, manifest_version: 3 })],
    ['src/userscript.header.txt', '// @version ' + version],
    ['src/extension-content.ts', "import { value } from './browser-app'"],
    ['src/browser-app.ts', code],
    ['src/extension-background.ts', ''],
    ['src/extension-page.ts', ''],
    ['src/userscript.ts', ''],
  ]);
}

test('changed browser dependency cannot reuse the released version', () => {
  expect(() => validateExtensionRelease(snapshot('2.4.13'), snapshot('2.4.13', 'export const value = 2')))
    .toThrow(/increase/);
});

test('a browser fix with a greater extension version is releasable', () => {
  expect(() => validateExtensionRelease(snapshot('2.4.13'), snapshot('2.4.14', 'export const value = 2')))
    .not.toThrow();
});

test('server-only changes do not require an extension release', () => {
  const before = snapshot('2.4.13');
  const after = snapshot('2.4.13');
  before.set('src/server.ts', 'old');
  after.set('src/server.ts', 'new');
  expect(() => validateExtensionRelease(before, after)).not.toThrow();
});
test('a changed release updater also requires a new published version', () => {
  const before = snapshot('2.4.13');
  const after = snapshot('2.4.13');
  before.set('scripts/update-extension.mjs', 'old');
  after.set('scripts/update-extension.mjs', 'new');
  expect(() => validateExtensionRelease(before, after)).toThrow(/increase/);
});

test('removed browser dependency still requires a version increase', () => {
  const before = snapshot('2.4.13', "export { value } from './old-helper'");
  before.set('src/old-helper.ts', 'export const value = 1');
  expect(() => validateExtensionRelease(before, snapshot('2.4.13'))).toThrow(/increase/);
});

test('version comparison is numeric and userscript must match the extension', () => {
  expect(() => validateExtensionRelease(snapshot('2.4.9'), snapshot('2.4.10', 'changed'))).not.toThrow();
  const after = snapshot('2.4.14', 'changed');
  after.set('src/userscript.header.txt', '// @version 2.4.13');
  expect(() => validateExtensionRelease(snapshot('2.4.13'), after)).toThrow(/userscript/);
  expect(() => validateExtensionRelease(snapshot('2.4.14'), snapshot('2.4.13', 'changed'))).toThrow(/increase/);
});
