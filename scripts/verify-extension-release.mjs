import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateArchive } from './extension-updater.mjs';
const version = JSON.parse(await readFile('extension/manifest.json', 'utf8')).version;
const bytes = new Uint8Array(await readFile('dist/localgpt-extension-' + version + '.zip'));
validateArchive(bytes, { version, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') });
console.log('Public extension ' + version + ' verified: complete archive, matching metadata, no pairing key.');
