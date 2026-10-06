import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
const origin = process.env.LOCALGPT_URL || 'http://127.0.0.1:8766';
const client = new Client({ name: 'compose-verification', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
try {
  const status = await client.callTool({ name: 'localmcp_status', arguments: {} });
  assert.equal(status.structuredContent.connected, true);
  const path = 'localgpt-verification/compose-test.txt';
  const call = async (name, args) => {
    const result = await client.callTool({ name: `localmcp_${name}`, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  };
  await call('write_file', { path, content: 'BEFORE' });
  await call('edit_file', { path, old_text: 'BEFORE', new_text: 'AFTER' });
  assert.match((await call('read_file', { path })).content[0].text, /AFTER/);
  const response = await fetch(`${origin}/extension`);
  assert.equal(response.status, 200);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const token = readFileSync(process.env.BRIDGE_TOKEN_FILE || '/var/lib/localgpt-credentials/browser-bridge', 'utf8').trim();
  assert.ok(new TextDecoder().decode(files['pairing.js']).includes(token));
  console.log('Compose: combined MCP write/edit/read and installation-paired extension download passed.');
} finally { await client.close(); }
