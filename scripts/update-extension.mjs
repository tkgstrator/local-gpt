import { readFile, writeFile, mkdir, unlink, rename, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { validateArchive, publishExtension, readPairing, unzipArchive } from './extension-updater.mjs';
import { compareVersions } from './extension-release.mjs';

const repository = 'tkgstrator/local-gpt';
async function fetchBytes(url, limit) {
  const response = await fetch(url, { headers: { 'User-Agent': 'LocalGPT-extension-updater' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Update download returned HTTP ' + response.status);
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Update response is too large');
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  return data;
}
export async function updateExtension(config) {
  const current = JSON.parse(await readFile(join(config.extensionPath, 'manifest.json'), 'utf8'));
  const releases = JSON.parse(new TextDecoder().decode(await fetchBytes('https://api.github.com/repos/' + repository + '/releases?per_page=100', 2 * 1024 * 1024)));
  const release = releases.filter(r => /^extension-v\d+\.\d+\.\d+$/.test(r.tag_name ?? '') && !r.draft && !r.prerelease)
    .sort((a, b) => compareVersions(b.tag_name.slice(11), a.tag_name.slice(11)))[0];
  if (!release) throw new Error('No stable extension release is available');
  const version = release.tag_name?.match(/^extension-v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version || release.draft || release.prerelease) throw new Error('Latest release is not a stable LocalGPT extension');
  if (compareVersions(version, current.version) <= 0) return { version: current.version, updated: false };
  const name = 'localgpt-extension-' + version + '.zip';
  const asset = release.assets?.find(a => a.name === name);
  if (!asset || asset.browser_download_url !== 'https://github.com/' + repository + '/releases/download/' + release.tag_name + '/' + name)
    throw new Error('Expected extension release asset is missing');
  const bytes = await fetchBytes(asset.browser_download_url, 16 * 1024 * 1024);
  const verified = validateArchive(bytes, { version, digest: asset.digest });
  let pairing;
  try {
    const installed = {};
    for (const name of ['pairing.js', 'background.js']) {
      try { installed[name] = new Uint8Array(await readFile(join(config.extensionPath, name))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    pairing = readPairing(installed);
  }
  catch (error) {
    if (!config.allowMigration) throw error;
    pairing = readPairing(unzipArchive(await fetchBytes('http://127.0.0.1:8766/extension', 16 * 1024 * 1024)));
  }
  return { ...await publishExtension({ ...config, release: verified, pairing }), updated: true };
}

export async function main(args) {
  const install = args[0] === '--install';
  const stateRoot = resolve(process.env.LOCALGPT_UPDATE_STATE || join(homedir(), 'Library', 'Application Support', 'LocalGPT', 'extension-updater'));
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const configPath = join(stateRoot, 'config.json');
  let config;
  if (install) {
    if (!args[1]) throw new Error('Usage: update-extension --install /absolute/path/to/installed/LocalGPT');
    config = { extensionPath: resolve(args[1]), stateRoot, allowMigration: true };
  } else config = JSON.parse(await readFile(configPath, 'utf8'));
  const lock = join(stateRoot, 'update.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lock, String(process.pid), { mode: 0o600, flag: 'wx' });
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readFile(lock, 'utf8');
      const pid = Number(owner);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid updater lock; inspect ' + lock);
      try { process.kill(pid, 0); return; }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      if (await readFile(lock, 'utf8') !== owner) return;
      await unlink(lock);
    }
  }
  if (!acquired) return;
  try {
    if (install) {
      const pendingConfig = configPath + '.next';
      await writeFile(pendingConfig, JSON.stringify(config) + '\n', { mode: 0o600 });
      await rename(pendingConfig, configPath);
    }
    const result = await updateExtension(config);
    if (install) {
      const temporaryConfig = configPath + '.next';
      await writeFile(temporaryConfig, JSON.stringify({ ...config, allowMigration: false }) + '\n', { mode: 0o600 });
      await rename(temporaryConfig, configPath);
    }
    console.log(result.updated ? 'LocalGPT extension updated to ' + result.version : 'LocalGPT extension is current (' + result.version + ')');
  } finally { await unlink(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(resolve(process.argv[1]))).href)
  await main(process.argv.slice(2));
