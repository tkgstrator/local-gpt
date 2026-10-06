import { CallToolResultSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
z.config({ jitless: true })
export interface LocalMcpConfig {
  url: string
  token: string
}
const allowedTools = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'search',
  'execute',
  'start_command',
  'poll_job',
  'stop_job',
])
export function readLocalMcpConfig(
  env: Record<string, string | undefined> = process.env,
): LocalMcpConfig | undefined {
  if (!env.LOCALMCP_URL) return undefined
  let url: URL
  try {
    url = new URL(env.LOCALMCP_URL)
  } catch {
    throw new Error('Invalid LOCALMCP_URL')
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', 'local-mcp'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, '') !== '/local'
  )
    throw new Error('LOCALMCP_URL must be an HTTPS or loopback HTTP /local endpoint')
  let token = env.LOCALMCP_TOKEN
  if (!token && env.LOCALMCP_TOKEN_FILE) {
    try {
      token = readFileSync(env.LOCALMCP_TOKEN_FILE, 'utf8').trim()
    } catch {
      throw new Error('Cannot read LOCALMCP_TOKEN_FILE')
    }
  }
  if (!token || token.length < 16 || /[\r\n]/.test(token))
    throw new Error('LocalMCP requires a token of at least 16 characters')
  return { url: url.href, token }
}
export async function attachLocalMcpTools(server: McpServer, config?: LocalMcpConfig) {
  if (!config) return
  const client = new Client({ name: 'LocalGPT-LocalMCP', version: '2.5.0' })
  let connected = false
  let names: string[] = []
  let error: string | null = null
  // Only the server-side transport receives credentials. Never put them in descriptions, results or browser bundles.
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error' },
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 1000,
      initialReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
  })
  try {
    await client.connect(transport, { timeout: 5000 })
    const tools = []
    let cursor: string | undefined
    for (let page = 0; page < 16; page++) {
      const listed = await client.listTools(cursor ? { cursor } : {}, { timeout: 5000 })
      tools.push(...listed.tools.filter((tool) => allowedTools.has(tool.name)))
      cursor = listed.nextCursor
      if (!cursor) break
    }
    if (cursor) throw new Error('tool pagination exceeded')
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new Error('duplicate tools')
    // Convert all schemas before registration so a malformed upstream never leaves a partial tool list.
    const definitions = tools.map((tool) => ({
      tool,
      schema: z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]),
    }))
    for (const { tool, schema } of definitions) {
      server.registerTool(
        `localmcp_${tool.name}`,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: schema,
          annotations: tool.annotations ?? {
            readOnlyHint: ['read_file', 'list_dir', 'search'].includes(tool.name),
            destructiveHint: !['read_file', 'list_dir', 'search'].includes(tool.name),
            openWorldHint: ['execute', 'start_command', 'poll_job', 'stop_job'].includes(tool.name),
          },
        },
        async (args, extra) => {
          try {
            return CallToolResultSchema.parse(
              await client.callTool(
                { name: tool.name, arguments: args as Record<string, unknown> },
                undefined,
                { signal: extra.signal, timeout: 190000 },
              ),
            )
          } catch (cause) {
            if (
              cause instanceof McpError &&
              [ErrorCode.InvalidParams, ErrorCode.MethodNotFound].includes(cause.code)
            ) {
              const message = cause.message.split(config.token).join('[redacted]').slice(0, 2000)
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `localmcp_tool_error (${cause.code}): ${message}`,
                  },
                ],
              }
            }
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: 'localmcp_call_failed: tool execution was not confirmed; do not automatically retry writes or commands.',
                },
              ],
            }
          }
        },
      )
    }
    names = definitions.map(({ tool }) => `localmcp_${tool.name}`)
    connected = true
    client.onclose = () => {
      connected = false
    }
  } catch {
    error = 'localmcp_unavailable'
    await client.close().catch(() => {})
  }
  const previousClose = server.server.onclose
  server.server.onclose = () => {
    previousClose?.()
    void client.close().catch(() => {})
  }
  const report = () => ({
    configured: true,
    connected,
    endpoint: config.url,
    tools: names,
    error: connected ? null : (error ?? 'localmcp_disconnected'),
    chatgptConnection: 'not_verified',
  })
  server.registerTool(
    'localmcp_status',
    {
      description:
        'Report the configured LocalMCP gateway connection and forwarded tool names. This confirms gateway connectivity only; it does not prove that ChatGPT has connected or selected the LocalMCP plugin.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const result = report()
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
      }
    },
  )
  return { status: report, close: () => client.close() }
}
