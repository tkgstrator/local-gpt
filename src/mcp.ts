import { SessionSchema, CreateSessionSchema } from './sessions'
import { DotResultSchema } from './dots'
import { CapabilitiesSchema } from './capabilities'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ResponsesRequestSchema } from './responses'
z.config({ jitless: true })
const HealthSchema = z.object({
  status: z.literal('ok'),
  browserConnected: z.boolean(),
  busy: z.boolean(),
  transport: z.enum(['http', 'websocket']).nullable(),
  browsers: z.number().int().optional(),
  availableBrowsers: z.number().int().optional(),
  wsPort: z.number(),
})
const ModelsSchema = z.object({
  object: z.literal('list'),
  data: z.array(z.object({ id: z.string(), display_name: z.string() })),
  selected: z.string().nullable(),
  selectionLabel: z.string().nullable(),
  source: z.literal('visible_ui'),
  scope: z.literal('currently_visible_controls'),
  canSelect: z.literal(false),
})
const ResponseSchema = z.object({
  object: z.literal('response'),
  status: z.literal('completed'),
  id: z.string(),
  session_id: z.string().nullable().optional(),
  model: z.string(),
  output: z.array(
    z.object({
      type: z.literal('message'),
      content: z.array(z.object({ type: z.literal('output_text'), text: z.string() })),
    }),
  ),
})
export function localApiBase(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('LOCALGPT_URL must be a loopback HTTP origin, e.g. http://127.0.0.1:8766')
  return url.origin
}
export function createMcpServer(baseUrl: string) {
  const base = localApiBase(baseUrl)
  const server = new McpServer(
    { name: 'LocalGPT', version: '2.5.0' },
    {
      instructions:
        'LocalGPT controls the signed-in ChatGPT browser. First call localgpt_status and localgpt_capabilities. For each topic create a localgpt_session_create, then pass its id as session_id to every localgpt_respond continuation. Distinct sessions can run concurrently using separate open ChatGPT tabs; the same session cannot. Browser capacity is reported by localgpt_status. Only choose model/effort combinations from capabilities.choices. For dots: list observed dots, select dotId, wait for selected/reconnection, send, then read messages after the returned outgoing messageId. A dot send receipt is not a completed answer and complete:false does not guarantee background completion. Do not automatically resend timed-out sends. Preserve manual drafts. If localmcp_ tools are listed, the caller can use them directly for workspace files. To let the ChatGPT worker read or edit files itself without attachments, connect the LocalMCP-only endpoint as a ChatGPT plugin and enable it for that conversation; gateway status does not prove ChatGPT plugin access. Never connect this LocalGPT endpoint back to its own ChatGPT worker: localgpt_respond would recurse. File attachments are transmitted to ChatGPT only when the user authorizes those specific files.',
    },
  )
  async function invoke(path: string, schema: z.ZodType, body?: unknown, signal?: AbortSignal) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(190000)])
          : AbortSignal.timeout(190000),
      })
      const value: unknown = await response.json()
      if (!response.ok) {
        const parsed = z
          .object({ error: z.object({ code: z.string(), message: z.string().optional() }) })
          .safeParse(value)
        throw new Error(
          parsed.success
            ? `${parsed.data.error.code}: ${parsed.data.error.message || 'LocalGPT request failed'}`
            : `LocalGPT HTTP ${response.status}`,
        )
      }
      const result = schema.parse(value) as Record<string, unknown>
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
      }
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: err instanceof Error ? err.message : 'LocalGPT request failed',
          },
        ],
      }
    }
  }
  server.registerTool(
    'localgpt_status',
    {
      description:
        'Read LocalGPT server and browser connection status. Does not generate a response.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => invoke('/health', HealthSchema, undefined, extra.signal),
  )
  server.registerTool(
    'localgpt_sessions',
    {
      description:
        'List LocalGPT session IDs and their bound ChatGPT conversation metadata. Message contents are not stored locally.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) =>
      invoke(
        '/v1/sessions',
        z.object({ object: z.literal('list'), data: z.array(SessionSchema) }),
        undefined,
        extra.signal,
      ),
  )
  server.registerTool(
    'localgpt_session_create',
    {
      description:
        'Create a LocalGPT session for a topic. Pass its id as session_id to localgpt_respond to start and continue the same ChatGPT conversation. Does not send a message.',
      inputSchema: CreateSessionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args, extra) => invoke('/v1/sessions', SessionSchema, args, extra.signal),
  )
  server.registerTool(
    'localgpt_dots',
    {
      description:
        'List observed dots in the connected ChatGPT account. This is the observed API page, not a guarantee that all cursor pages have been loaded. IDs are required for selection and messaging.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => invoke('/v1/dots', DotResultSchema, undefined, extra.signal),
  )
  server.registerTool(
    'localgpt_dot_select',
    {
      description:
        'Open an observed dot in ChatGPT, preserving unsent drafts. navigation_requested means reload/reconnection is still pending; read localgpt_dots until selected matches before sending.',
      inputSchema: { dotId: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args, extra) => invoke('/v1/dots/select', DotResultSchema, args, extra.signal),
  )
  server.registerTool(
    'localgpt_dot_send',
    {
      description:
        'Send text to the currently selected dot. Returns the rendered outgoing message ID, not a completed answer. Use localgpt_dot_messages with that ID as the cursor to get replies. Timeout may mean sent; never automatically retry.',
      inputSchema: { dotId: z.string().min(1).max(200), text: z.string().min(1).max(100000) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => invoke('/v1/dots/messages', DotResultSchema, args, extra.signal),
  )
  server.registerTool(
    'localgpt_dot_messages',
    {
      description:
        'Read currently rendered messages for the selected dot. afterMessageId restricts results to newer messages and must be visible. Replies can arrive in multiple messages and background tasks may continue; complete is always false.',
      inputSchema: {
        dotId: z.string().min(1).max(200),
        afterMessageId: z.string().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) =>
      invoke(
        '/v1/dots/messages?' +
          new URLSearchParams({
            dotId: args.dotId,
            limit: String(args.limit),
            ...(args.afterMessageId ? { afterMessageId: args.afterMessageId } : {}),
          }),
        DotResultSchema,
        undefined,
        extra.signal,
      ),
  )
  server.registerTool(
    'localgpt_capabilities',
    {
      description:
        'Read the connected browser’s ChatGPT API data: available Chat models, reasoning types and thinking effort choices, and account plan. Null means not observed; reload ChatGPT after installing version 2.4. Reports observed model selection choices; does not expose personal account information.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => invoke('/v1/capabilities', CapabilitiesSchema, undefined, extra.signal),
  )
  server.registerTool(
    'localgpt_models',
    {
      description:
        'Read model display labels from the connected ChatGPT page. Temporarily opens the model menu to read rendered choices, closes it if originally closed, and never selects another model. selected is a model label; selectionLabel may be an effort/mode label such as Pro. Labels are not official model IDs.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, extra) => invoke('/v1/models', ModelsSchema, undefined, extra.signal),
  )
  server.registerTool(
    'localgpt_respond',
    {
      description:
        'Send text to the signed-in ChatGPT browser tab and return its completed response. Text goes to ChatGPT. Actual model is selected in the browser. newChat defaults to true; does not overwrite unsent drafts. Supports local files by absolute path: UTF-8 source code/logs/text, PDF, PNG/JPEG/WebP/GIF; max 10 files, 8 MiB each, 16 MiB total. Auto mode sends UTF-8 source/log/text files up to 256 KiB as prompt context; images/PDF/larger files use browser attachment upload. mode:text or mode:upload can be specified. Files are transmitted to ChatGPT. LocalMCP file tools can independently read/write files; LocalGPT itself does not edit the files. Obtain user authorization for the specific files first. No message text is stored locally.',
      inputSchema: {
        input: ResponsesRequestSchema.shape.input,
        model: ResponsesRequestSchema.shape.model,
        files: ResponsesRequestSchema.shape.files,
        reasoning: ResponsesRequestSchema.shape.reasoning,
        session_id: ResponsesRequestSchema.shape.session_id,
        instructions: ResponsesRequestSchema.shape.instructions,
        newChat: ResponsesRequestSchema.shape.newChat,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) =>
      invoke(
        '/v1/responses',
        ResponseSchema,
        { ...args, stream: false, store: false },
        extra.signal,
      ),
  )
  return server
}
