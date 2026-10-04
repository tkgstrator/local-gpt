import { attachLocalMcpTools, readLocalMcpConfig } from './localmcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './mcp'
// stdout belongs exclusively to the MCP JSON-RPC transport.
const server = createMcpServer(process.env.LOCALGPT_URL || 'http://127.0.0.1:8766')
await attachLocalMcpTools(server, readLocalMcpConfig())
await server.connect(new StdioServerTransport())
