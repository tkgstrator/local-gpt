import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.ts';

// Imports source (not dist/mcp.cjs); the dist-importing mcp.test.mjs is unchanged until root rebuilds.
async function status(t, health) {
  const api = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(health)); });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  t.after(() => api.close());
  const server = createMcpServer(`http://127.0.0.1:${api.address().port}`);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, result: await client.callTool({ name: 'localgpt_status', arguments: {} }) };
}
const base = { status: 'ok', browserConnected: true, busy: false, transport: 'websocket', wsPort: 1 };
test('MCP reports the current package version', async t => {
  const { client } = await status(t, base);
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(client.getServerVersion().version, version);
});
test('MCP health accepts nullable or absent nativeReadyReason and passes a code through', async t => {
  for (const reason of [undefined, null, 'native_store_ambiguous']) {
    const { result } = await status(t, { ...base, nativeReady: reason === undefined || reason === null, ...(reason === undefined ? {} : { nativeReadyReason: reason }) });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.nativeReadyReason, reason);
  }
});
