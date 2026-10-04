import { context } from 'esbuild';
import { readFile } from 'node:fs/promises';
const metadata = await readFile(new URL('../src/userscript.header.txt', import.meta.url), 'utf8');
const token = (await readFile('.bridge-token', 'utf8')).trim();
const ctx = await context({ entryPoints: ['src/userscript.ts'], outfile: 'dist/chatgpt-api.user.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome110', define: { __BRIDGE_TOKEN__: JSON.stringify(token) }, banner: { js: metadata } });
await ctx.watch();
console.log('Watching userscript sources. Run bun run typecheck separately; reinstall the built script after changes.');
