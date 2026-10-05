import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('compose mounts the existing LocalGPT state volume for private durable job records, with no new volume', async () => {
  const compose = await readFile('compose.yaml', 'utf8'); assert.match(compose, /LOCALGPT_RESPONSE_JOBS_DIR: \/var\/lib\/localgpt\/response-jobs/); assert.match(compose, /- localgpt-state:\/var\/lib\/localgpt\b/);
  assert.equal((compose.match(/^\s{2}[a-z-]+:\s*$/gm) ?? []).filter(l => /jobs/.test(l)).length, 0);
});
test('extension and userscript versions are bumped together so reloaded browsers get native stream support', async () => {
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8')); const header = await readFile('src/userscript.header.txt', 'utf8'); assert.match(header, new RegExp(`@version\\s+${manifest.version.replace(/\./g, '\\.')}\\b`)); assert.notEqual(manifest.version, '2.4.1');
});
test('README documents the job API, extension update, and manual recovery without claiming remote cancellation', async () => {
  const readme = await readFile('README.md', 'utf8');
  for (const needle of [/\/v1\/response-jobs/, /LOCALGPT_RESPONSE_JOBS_DIR/, /localgpt_response_get/, /202/, /wait_ms/, /拡張機能|extension/i, /unknown|不明/i, /stop|停止/, /backup|バックアップ/, /ChatGPT.*(idle|待機|生成中でない)/]) assert.match(readme, needle);
  assert.doesNotMatch(readme, /リモート(生成を)?キャンセル(でき|する|します)|remote(ly)? cancel(s|led)? (the )?generation/i);
});
