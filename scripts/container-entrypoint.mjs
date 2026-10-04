import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync, chownSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const state = process.env.LOCALGPT_CREDENTIALS_DIR || '/var/lib/localgpt-credentials';
mkdirSync(state, { recursive: true, mode: 0o700 });
for (const name of ['browser-bridge', 'local-mcp-token']) {
  const path = `${state}/${name}`;
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  if (!/^[a-f0-9]{64}$/.test(readFileSync(path, 'utf8').trim())) throw new Error(`Invalid stored credential: ${name}`);
}
if (process.argv.includes('--init')) {
  if (process.env.LOCALMCP_UID) {
    const uid = Number(process.env.LOCALMCP_UID);
    if (!Number.isInteger(uid) || uid < 0) throw new Error('Invalid LocalMCP UID');
    // The pinned Rust sidecar runs as vscode (1000); only its key is readable by that user.
    chownSync(`${state}/local-mcp-token`, uid, uid);
    if (process.env.LOCALGPT_INIT_WORKSPACE) chownSync(process.env.LOCALGPT_INIT_WORKSPACE, uid, uid);
    chmodSync(state, 0o711);
  }
  process.exit(0);
}
process.env.BRIDGE_TOKEN_FILE = `${state}/browser-bridge`;
process.env.LOCALMCP_TOKEN_FILE = `${state}/local-mcp-token`;
// Pair browser downloads with this installation, never with a published image key.
const build = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit', env: process.env });
if (build.status !== 0) process.exit(build.status ?? 1);
const args = process.argv.slice(2);
const child = args.length ? spawn(args[0], args.slice(1), { stdio: 'inherit', env: process.env }) : spawn(process.execPath, ['dist/server.cjs'], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
