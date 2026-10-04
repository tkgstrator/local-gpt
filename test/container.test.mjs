import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('container initialization preserves private pairing across restarts and rejects corrupt keys', () => {
  const state = mkdtempSync(join(tmpdir(), 'localgpt-credentials-'));
  try {
    const initialize = () => spawnSync(process.execPath, ['scripts/container-entrypoint.mjs', '--init'], {
      env: { ...process.env, LOCALGPT_CREDENTIALS_DIR: state }, encoding: 'utf8',
    });
    expect(initialize().status).toBe(0);
    const key = readFileSync(join(state, 'browser-bridge'), 'utf8');
    expect(key.trim()).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(state, 'local-mcp-token'), 'utf8').trim()).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(join(state, 'browser-bridge')).mode & 0o777).toBe(0o600);
    expect(initialize().status).toBe(0);
    expect(readFileSync(join(state, 'browser-bridge'), 'utf8')).toBe(key);
    writeFileSync(join(state, 'browser-bridge'), 'invalid');
    expect(initialize().status).not.toBe(0);
  } finally { rmSync(state, { recursive: true, force: true }); }
});
