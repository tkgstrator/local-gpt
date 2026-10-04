import { zipSync } from 'fflate';
import { build } from 'esbuild';
import { readFile, writeFile, copyFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const tokenPath = process.env.BRIDGE_TOKEN_FILE || '.bridge-token';
let token;
if (process.env.LOCALGPT_IMAGE_BUILD === '1') token = '0'.repeat(64);
else try { token = (await readFile(tokenPath, 'utf8')).trim(); } catch (err) { if (err.code !== 'ENOENT') throw err; token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' }); }
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local pairing token');
const metadata = await readFile(new URL('../src/userscript.header.txt', import.meta.url), 'utf8');
await build({ entryPoints: ['src/userscript.ts'], outfile: 'dist/chatgpt-api.user.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome110', define: { __BRIDGE_TOKEN__: JSON.stringify(token) }, banner: { js: metadata }, legalComments: 'inline' });
await build({ entryPoints: ['src/server.ts', 'src/protocol.ts', 'src/chatgpt-dom.ts', 'src/extension-handler.ts', 'src/mcp.ts', 'src/capabilities.ts', 'src/page-observer.ts', 'src/dots.ts', 'src/model-selection.ts', 'src/sessions.ts', 'src/attachments.ts', 'src/browser-files.ts', 'src/localmcp.ts'], outdir: 'dist', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', packages: 'external' });

await build({ entryPoints: ['src/dashboard.ts'], outfile: 'dist/dashboard.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome110', minify: true });
await copyFile('public/dashboard.html', 'dist/dashboard.html');

await mkdir('dist/extension', { recursive: true });
await build({ entryPoints: ['src/extension-page.ts'], outfile: 'dist/extension/page.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome110' });
await build({ entryPoints: ['src/extension-content.ts'], outfile: 'dist/extension/content.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome110', define: { __BRIDGE_TOKEN__: '""' } });
await build({ entryPoints: ['src/extension-background.ts'], outfile: 'dist/extension/background.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome110', define: { __BRIDGE_TOKEN__: JSON.stringify(token) } });
await copyFile('extension/manifest.json', 'dist/extension/manifest.json');
await copyFile('extension/popup.html', 'dist/extension/popup.html');
await writeFile('dist/extension/README.txt', 'Chrome: chrome://extensions → デベロッパーモード → パッケージ化されていない拡張機能を読み込む → このフォルダーを選択。Tampermonkey版は無効にし、ChatGPTを再読み込みしてください。\n');

const extensionFiles = {};
for (const name of await readdir('dist/extension')) extensionFiles[name] = new Uint8Array(await readFile(`dist/extension/${name}`));
const extensionVersion = JSON.parse(await readFile('extension/manifest.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(extensionVersion)) throw new Error('Invalid extension version');
await writeFile(`dist/localgpt-extension-${extensionVersion}.zip`, zipSync(extensionFiles));

await build({ entryPoints: ['src/mcp-stdio.ts'], outfile: 'dist/mcp-stdio.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', packages: 'external' });
await writeFile('dist/mcp-config.json', JSON.stringify({ mcpServers: { localgpt: { command: process.execPath, args: [resolve('dist/mcp-stdio.mjs')], env: { LOCALGPT_URL: 'http://127.0.0.1:8766' } } } }, null, 2) + '\n');
