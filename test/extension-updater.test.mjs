import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createHash } from 'node:crypto';
import { validateArchive, publishExtension, readPairing } from '../scripts/extension-updater.mjs';

const key = 'a'.repeat(64);
const pairing = 'const LOCALGPT_PAIRING_TOKEN = "' + key + '";\n';
const manifest = { manifest_version: 3, name: 'LocalGPT', version: '2.4.14', host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' }, content_scripts: [{ matches: ['https://chatgpt.com/*'], js: ['page.js', 'content.js'] }], action: { default_popup: 'popup.html' } };
function archive(overrides = {}) {
  const files = {
    'manifest.json': JSON.stringify(manifest),
    'build-info.json': '{"version":"2.4.14"}',
    'pairing.js': 'const LOCALGPT_PAIRING_TOKEN = "";\n',
    'background.js': 'importScripts("pairing.js");',
    'content.js': 'console.log("content");',
    'page.js': 'console.log("page");',
    'popup.html': '<body>LocalGPT</body>',
    ...overrides,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(body)])));
}
function checked(bytes) {
  return validateArchive(bytes, { version: '2.4.14', digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') });
}

test('archive rejects a digest mismatch before publishing', () => {
  expect(() => validateArchive(archive(), { version: '2.4.14', digest: 'sha256:' + 'f'.repeat(64) })).toThrow(/digest/);
});
test('public archive rejects private pairing and archive traversal', () => {
  expect(() => checked(archive({ 'pairing.js': pairing }))).toThrow(/pairing/);
  expect(() => checked(archive({ '../outside.js': 'attack' }))).toThrow(/file/);
});
test('archive rejects an absent declared script and mismatched build version', () => {
  expect(() => checked(archive({ 'page.js': '' }))).toThrow(/script|file/);
  expect(() => checked(archive({ 'build-info.json': '{"version":"2.4.13"}' }))).toThrow(/version/);
});
test('publishing retains pairing, replaces files together, and preserves the original for rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localgpt-update-'));
  try {
    const extensionPath = join(root, 'installed');
    await mkdir(extensionPath);
    await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.4.13' }));
    await writeFile(join(extensionPath, 'pairing.js'), pairing);
    await writeFile(join(extensionPath, 'content.js'), 'old');
    const result = await publishExtension({ extensionPath, stateRoot: join(root, 'state'), release: checked(archive()), pairing });
    expect((await lstat(extensionPath)).isDirectory()).toBe(true);
    expect((await lstat(join(extensionPath, '.localgpt-current'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(extensionPath, 'pairing.js'), 'utf8')).toBe(pairing);
    expect(await readFile(join(extensionPath, 'content.js'), 'utf8')).toBe('console.log("content");');
    expect(await readFile(join(result.backup, 'content.js'), 'utf8')).toBe('old');
    // Chromium's content-script loader requires every symlink to resolve within its root.
    const canonicalRoot = await realpath(extensionPath);
    for (const name of Object.keys(checked(archive()).files))
      expect((await realpath(join(extensionPath, name))).startsWith(canonicalRoot + '/')).toBe(true);
    expect((await realpath(result.backup)).startsWith(canonicalRoot + '/')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('publishing refuses newly expanded permissions and leaves old files intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localgpt-update-'));
  try {
    const extensionPath = join(root, 'installed');
    await mkdir(extensionPath);
    await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.4.13' }));
    const release = checked(archive({ 'manifest.json': JSON.stringify({ ...manifest, permissions: ['debugger'] }) }));
    await expect(publishExtension({ extensionPath, stateRoot: join(root, 'state'), release, pairing })).rejects.toThrow(/permission/);
    expect((await lstat(extensionPath)).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8')).version).toBe('2.4.13');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('migration reads the legacy paired download without accepting an unpaired image key', () => {
  expect(readPairing({ 'background.js': strToU8('({token: "' + key + '"})') })).toBe(pairing);
  expect(() => readPairing({ 'background.js': strToU8('({token: "' + '0'.repeat(64) + '"})') })).toThrow(/pairing/);
});
test('automatic publication rejects changed injection worlds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localgpt-update-'));
  try {
    const extensionPath = join(root, 'installed');
    await mkdir(extensionPath);
    await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.4.13' }));
    const updated = { ...manifest, content_scripts: manifest.content_scripts.map(script => ({ ...script, world: 'MAIN' })) };
    await expect(publishExtension({ extensionPath, stateRoot: join(root, 'state'), release: checked(archive({ 'manifest.json': JSON.stringify(updated) })), pairing })).rejects.toThrow(/manual approval/);
    expect((await lstat(extensionPath)).isDirectory()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a second publication switches the existing link while retaining the local key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localgpt-update-'));
  try {
    const extensionPath = join(root, 'installed');
    await mkdir(extensionPath);
    await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.4.13' }));
    const config = { extensionPath, stateRoot: join(root, 'state'), pairing };
    await publishExtension({ ...config, release: checked(archive()) });
    const second = await publishExtension({ ...config, release: checked(archive({ 'content.js': 'second' })) });
    expect(second.backup).toBeNull();
    expect(await readFile(join(extensionPath, 'content.js'), 'utf8')).toBe('second');
    expect(await readFile(join(extensionPath, 'pairing.js'), 'utf8')).toBe(pairing);
    expect((await realpath(join(extensionPath, 'content.js'))).startsWith((await realpath(extensionPath)) + '/')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration repairs an external update pointer without changing pairing or the rollback source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localgpt-update-'));
  try {
    const extensionPath = join(root, 'installed');
    const external = join(root, 'state', 'releases', 'legacy');
    await mkdir(extensionPath);
    await mkdir(external, { recursive: true });
    const files = checked(archive()).files;
    for (const [name, bytes] of Object.entries(files))
      await writeFile(join(external, name), name === 'pairing.js' ? pairing : bytes);
    await symlink(external, join(extensionPath, '.localgpt-current'), 'dir');
    for (const name of Object.keys(files))
      await symlink('.localgpt-current/' + name, join(extensionPath, name));
    await publishExtension({ extensionPath, stateRoot: join(root, 'state'), release: checked(archive({ 'content.js': 'repaired' })), pairing });
    const canonicalRoot = await realpath(extensionPath);
    for (const name of Object.keys(files))
      expect((await realpath(join(extensionPath, name))).startsWith(canonicalRoot + '/')).toBe(true);
    expect(await readFile(join(extensionPath, 'pairing.js'), 'utf8')).toBe(pairing);
    expect(await readFile(join(extensionPath, 'content.js'), 'utf8')).toBe('repaired');
    expect(await readFile(join(external, 'content.js'), 'utf8')).toBe('console.log("content");');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication refuses a releases directory symlink that would escape the Chrome root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localgpt-update-'));
  try {
    const extensionPath = join(root, 'installed');
    const external = join(root, 'external');
    await mkdir(extensionPath);
    await mkdir(external);
    await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.4.13' }));
    await symlink(external, join(extensionPath, '.localgpt-releases'), 'dir');
    await expect(publishExtension({ extensionPath, stateRoot: join(root, 'state'), release: checked(archive()), pairing })).rejects.toThrow('Extension release directory must remain within the Chrome root');
    expect(JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8')).version).toBe('2.4.13');
  } finally { await rm(root, { recursive: true, force: true }); }
});
