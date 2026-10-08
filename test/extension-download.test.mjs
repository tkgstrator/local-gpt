import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { updateExtension } from '../scripts/update-extension.mjs';

test('updater selects the greatest stable extension release and preserves the installed legacy pairing offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'localgpt-download-'));
  const originalFetch = globalThis.fetch;
  try {
    const extensionPath = join(root, 'installed');
    await mkdir(extensionPath);
    const manifest = { name: 'LocalGPT', manifest_version: 3, version: '2.4.14', background: { service_worker: 'background.js' }, content_scripts: [{ matches: ['https://chatgpt.com/*'], js: ['content.js', 'page.js'] }], action: { default_popup: 'popup.html' } };
    const key = 'b'.repeat(64);
    await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.4.13' }));
    await writeFile(join(extensionPath, 'background.js'), '({token: "' + key + '"})');
    const bytes = zipSync(Object.fromEntries(Object.entries({
      'manifest.json': JSON.stringify(manifest), 'build-info.json': '{"version":"2.4.14"}',
      'pairing.js': 'const LOCALGPT_PAIRING_TOKEN = "";\n', 'background.js': 'importScripts("pairing.js");',
      'content.js': 'updated', 'page.js': 'page', 'popup.html': '<body></body>',
    }).map(([name, text]) => [name, strToU8(text)])));
    const assetUrl = 'https://github.com/tkgstrator/local-gpt/releases/download/extension-v2.4.14/localgpt-extension-2.4.14.zip';
    const selected = { tag_name: 'extension-v2.4.14', assets: [{ name: 'localgpt-extension-2.4.14.zip', digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), browser_download_url: assetUrl }] };
    globalThis.fetch = async (url) => {
      if (url === 'https://api.github.com/repos/tkgstrator/local-gpt/releases?per_page=100')
        return Response.json([{ tag_name: 'app-v3.0.0' }, { ...selected, tag_name: 'extension-v2.4.15', prerelease: true }, selected, { tag_name: 'extension-v2.4.9' }]);
      if (url === assetUrl) return new Response(bytes);
      throw new Error('Unexpected request: ' + url);
    };
    const result = await updateExtension({ extensionPath, stateRoot: join(root, 'state'), allowMigration: true });
    expect(result.version).toBe('2.4.14');
    expect(await readFile(join(extensionPath, 'content.js'), 'utf8')).toBe('updated');
    expect(await readFile(join(extensionPath, 'pairing.js'), 'utf8')).toBe('const LOCALGPT_PAIRING_TOKEN = "' + key + '";\n');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
