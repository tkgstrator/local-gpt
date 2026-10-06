import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, rename, symlink, chmod, unlink } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import { compareVersions } from './extension-release.mjs';

const allowed = new Set(['manifest.json', 'build-info.json', 'pairing.js', 'background.js', 'content.js', 'page.js', 'popup.html', 'README.txt']);
const decode = bytes => new TextDecoder().decode(bytes);
const emptyPairing = 'const LOCALGPT_PAIRING_TOKEN = "";\n';
export function unzipArchive(bytes) {
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Extension archive is too large');
  let total = 0;
  return unzipSync(bytes, { filter: entry => {
    total += entry.originalSize;
    if (!allowed.has(entry.name) || entry.originalSize > 8 * 1024 * 1024 || total > 24 * 1024 * 1024)
      throw new Error('Invalid extension file or archive size');
    return true;
  } });
}
export function validateArchive(bytes, { version, digest }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '') ||
      digest !== 'sha256:' + createHash('sha256').update(bytes).digest('hex'))
    throw new Error('Extension archive digest mismatch');
  const files = unzipArchive(bytes);
  const manifest = JSON.parse(decode(files['manifest.json']));
  const build = JSON.parse(decode(files['build-info.json']));
  if (manifest.name !== 'LocalGPT' || manifest.manifest_version !== 3 ||
      manifest.version !== version || build.version !== version)
    throw new Error('Invalid extension release version');
  compareVersions(version, version);
  if (decode(files['pairing.js']) !== emptyPairing) throw new Error('Public release contains private pairing');
  const required = [manifest.background?.service_worker, ...(manifest.content_scripts ?? []).flatMap(s => s.js ?? []), manifest.action?.default_popup];
  if (!required.length || required.some(name => !allowed.has(name) || !files[name]?.length))
    throw new Error('A declared extension script/file is missing');
  return { files, manifest, digest };
}
export function readPairing(files) {
  const paired = files['pairing.js'] ? decode(files['pairing.js']).match(/^const LOCALGPT_PAIRING_TOKEN = "([a-f0-9]{64})";\s*$/)?.[1] : null;
  const legacy = !paired && files['background.js'] ? [...decode(files['background.js']).matchAll(/\btoken:\s*"([a-f0-9]{64})"/g)].map(m => m[1]) : [];
  const key = paired || (legacy.length === 1 ? legacy[0] : null);
  if (!key || key === '0'.repeat(64)) throw new Error('A private local pairing key is required');
  return 'const LOCALGPT_PAIRING_TOKEN = "' + key + '";\n';
}
function permissions(manifest) {
  return [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? []),
    ...(manifest.optional_permissions ?? []), ...(manifest.optional_host_permissions ?? []),
    ...(manifest.content_scripts ?? []).flatMap(s => s.matches ?? [])];
}
export async function publishExtension({ extensionPath, stateRoot, release, pairing }) {
  extensionPath = resolve(extensionPath);
  stateRoot = resolve(stateRoot);
  if (extensionPath === dirname(extensionPath) || stateRoot === dirname(stateRoot) ||
      extensionPath === stateRoot || extensionPath.startsWith(stateRoot + '/') || stateRoot.startsWith(extensionPath + '/'))
    throw new Error('Invalid extension installation path');
  readPairing({ 'pairing.js': new TextEncoder().encode(pairing) });
  const old = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  if (old.name !== 'LocalGPT' || old.manifest_version !== 3) throw new Error('Target is not a LocalGPT extension');
  if (permissions(release.manifest).some(p => !permissions(old).includes(p)))
    throw new Error('New extension permissions require manual approval');
  const comparableManifest = value => Object.fromEntries(Object.entries(value).filter(([name]) =>
    !['version', 'description', 'name'].includes(name)).sort(([a], [b]) => a.localeCompare(b)));
  if (JSON.stringify(comparableManifest(old)) !== JSON.stringify(comparableManifest(release.manifest)))
    throw new Error('Extension manifest/permission changes require manual approval');
  if (compareVersions(release.manifest.version, old.version) < 0) throw new Error('Refusing an extension downgrade');
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  const releasesRoot = join(stateRoot, 'releases');
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  const staged = join(releasesRoot, release.manifest.version + '-' + randomUUID());
  await mkdir(staged, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(release.files))
    await writeFile(join(staged, name), name === 'pairing.js' ? pairing : bytes, { mode: 0o600, flag: 'wx' });
  const current = await lstat(extensionPath);
  if (!current.isDirectory() || current.isSymbolicLink()) throw new Error('Chrome needs a stable real extension directory');
  const pointer = join(extensionPath, '.localgpt-current');
  let backup = null;
  let installedPointer;
  try { installedPointer = await lstat(pointer); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (installedPointer && !installedPointer.isSymbolicLink()) throw new Error('Invalid extension update pointer');
  if (!installedPointer) {
    backup = join(releasesRoot, 'original-' + randomUUID());
    await mkdir(backup, { mode: 0o700 });
    for (const name of allowed) {
      try { await writeFile(join(backup, name), await readFile(join(extensionPath, name)), { mode: 0o600, flag: 'wx' }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // New metadata is present during migration but still describes the OLD build.
    await writeFile(join(backup, 'build-info.json'), JSON.stringify({ version: old.version }) + '\n', { mode: 0o600 });
    await writeFile(join(backup, 'pairing.js'), pairing, { mode: 0o600 });
    await symlink(backup, pointer, 'dir');
  }
  // Keep Chrome's canonical root path fixed. Each resource follows the same pointer.
  // While migrating individual links, both forms still read the old complete snapshot.
  for (const name of Object.keys(release.files)) {
    const resourceLink = join(extensionPath, '.localgpt-resource-' + randomUUID());
    await symlink('.localgpt-current/' + name, resourceLink);
    await rename(resourceLink, join(extensionPath, name));
  }
  const nextLink = join(extensionPath, '.localgpt-next-' + randomUUID());
  await symlink(staged, nextLink, 'dir');
  try { await rename(nextLink, pointer); }
  catch (error) { await unlink(nextLink).catch(() => {}); throw error; }
  return { version: release.manifest.version, backup, directory: staged };
}
