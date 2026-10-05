import { waitForResponseJob } from './job-stream'
import { ResponseJobSchema } from './response-jobs'
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
  sharedBrowserId: z.string().nullable().optional(),
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
        'LocalGPT controls the signed-in ChatGPT browser. First call localgpt_status and localgpt_capabilities. For each topic create a localgpt_session_create, then pass its id as session_id to every localgpt_respond continuation. All browser operations run one at a time service-wide through one shared existing ChatGPT tab; additional tabs stay on standby and receive no operations unless the shared tab disconnects with nothing in flight. Do not open ChatGPT tabs per caller or session. sharedBrowserId in localgpt_status identifies the shared tab. A 409 browser_busy rejects an operation before dispatch; wait and retry only that operation. Only choose model/effort combinations from capabilities.choices. For dots: list observed dots, select dotId, wait for selected/reconnection, send, then read messages after the returned outgoing messageId. A dot send receipt is not a completed answer and complete:false does not guarantee background completion. Pro models default to asynchronous response jobs: localgpt_response_start, or localgpt_respond with background:true or a Pro model, returns a job receipt, not an answer. Call localgpt_response_get by job_id until completed or failed; each call waits on SSE for up to 25 seconds and returns immediately on completion, so call again at once while in_progress without sleeping. thinking is observed activity; unresponsive means no recent native activity and an UNKNOWN outcome, not proof that work stopped. Keep polling and never resend. Async generation has no elapsed-time cutoff, polling never cancels it, and there is no remote cancel tool. Disconnects, restarts and incomplete native streams keep a job in_progress/unresponsive, preserve partial text and keep the browser slot reserved. Completed results expire after one hour. Do not automatically resend timed-out sends. Preserve manual drafts. If localmcp_ tools are listed, the caller can use them directly for workspace files. To let the ChatGPT worker read or edit files itself without attachments, connect the LocalMCP-only endpoint as a ChatGPT plugin and enable it for that conversation; gateway status does not prove ChatGPT plugin access. Never connect this LocalGPT endpoint back to its own ChatGPT worker: localgpt_respond would recurse. File attachments are transmitted to ChatGPT only when the user authorizes those specific files.',
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
  const SessionList = z.object({ object: z.literal('list'), data: z.array(SessionSchema) })
  const progressSender = (extra: {
    _meta?: { progressToken?: string | number }
    sendNotification: (notification: never) => Promise<void>
  }) => {
    let progress = 0
    return (event: Parameters<NonNullable<Parameters<typeof waitForResponseJob>[4]>>[0]) => {
      const progressToken = extra._meta?.progressToken
      if (progressToken === undefined) return
      const message =
        event.type === 'response_job.updated'
          ? event.job.phase
          : event.type === 'response.output_text.delta'
            ? event.delta
            : event.text
      void extra
        .sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: ++progress, message: message.slice(-2000) },
        } as never)
        .catch(() => {})
    }
  }
  const respondSchema = {
    input: ResponsesRequestSchema.shape.input,
    model: ResponsesRequestSchema.shape.model,
    files: ResponsesRequestSchema.shape.files,
    reasoning: ResponsesRequestSchema.shape.reasoning,
    session_id: ResponsesRequestSchema.shape.session_id,
    instructions: ResponsesRequestSchema.shape.instructions,
    newChat: ResponsesRequestSchema.shape.newChat,
  }
  server.registerTool(
    'localgpt_respond',
    {
      description:
        'Send text to the signed-in ChatGPT browser tab. Pro models (by the model argument or the session model) and background:true return an asynchronous response_job receipt immediately; await it with localgpt_response_get and never resend. Other requests return the completed text directly. Text goes to ChatGPT. Actual model is selected in the browser. newChat defaults to true; does not overwrite unsent drafts. Supports local files by absolute path: UTF-8 source code/logs/text, PDF, PNG/JPEG/WebP/GIF; max 10 files, 8 MiB each, 16 MiB total. Auto mode sends UTF-8 source/log/text files up to 256 KiB as prompt context; images/PDF/larger files use browser attachment upload. mode:text or mode:upload can be specified. Files are transmitted to ChatGPT. LocalMCP file tools can independently read/write files; LocalGPT itself does not edit the files. Obtain user authorization for the specific files first. Prompts are never stored in job records or the session database.',
      inputSchema: { ...respondSchema, background: z.boolean().optional() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const { background, ...body } = args
      let model = args.model
      if (!model && args.session_id) {
        const listed = await invoke('/v1/sessions', SessionList, undefined, extra.signal)
        if ('isError' in listed) return listed
        const session = SessionList.parse(listed.structuredContent).data.find(
          (value) => value.id === args.session_id,
        )
        model = session?.model ?? undefined
      }
      if (background === true || (model && /\bpro\b/i.test(model)))
        return invoke(
          '/v1/response-jobs',
          ResponseJobSchema,
          { ...body, stream: false, store: false },
          extra.signal,
        )
      return invoke(
        '/v1/responses',
        ResponseSchema,
        { ...body, stream: false, store: false },
        extra.signal,
      )
    },
  )
  server.registerTool(
    'localgpt_response_start',
    {
      description:
        'Start an asynchronous LocalGPT response and return a response_job receipt immediately; it is not the answer. Await localgpt_response_get by job_id. The job survives start/poll client disconnects but holds the service-wide browser slot until it completes or fails. Do not resend a job that is thinking or unresponsive. No elapsed-time cutoff applies once sent. Results expire one hour after completion and survive restart when LOCALGPT_RESPONSE_JOBS_DIR is configured; a restarted pending job stays unknown and reserves the browser slot for manual recovery. Reference LocalMCP-visible paths rather than pasting large content.',
      inputSchema: respondSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) =>
      invoke(
        '/v1/response-jobs',
        ResponseJobSchema,
        { ...args, stream: false, store: false },
        extra.signal,
      ),
  )
  server.registerTool(
    'localgpt_response_get',
    {
      description:
        'Wait for response_job events over SSE. wait_ms defaults to and is capped at 25000; it returns immediately on completion or failure, and an unfinished job returns in_progress after the bounded wait, so call again immediately without sleeping. wait_ms:0 reads an immediate snapshot. Only completed contains the final answer. thinking is observed activity; unresponsive is an unknown outcome, not confirmed stopping. A disconnect or stream ambiguity stays in_progress/unresponsive with partial text preserved. Never resend or assume cancellation. Jobs expire one hour after completion.',
      inputSchema: {
        job_id: z.string().uuid(),
        wait_ms: z.number().int().min(0).max(25000).default(25000),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      if (args.wait_ms === 0)
        return invoke(
          `/v1/response-jobs/${args.job_id}`,
          ResponseJobSchema,
          undefined,
          extra.signal,
        )
      try {
        const job = await waitForResponseJob(
          base,
          args.job_id,
          args.wait_ms,
          extra.signal,
          progressSender(extra as never),
        )
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(job) }],
          structuredContent: job,
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: error instanceof Error ? error.message : 'Job stream failed; do not resend.',
            },
          ],
        }
      }
    },
  )
  return server
}
