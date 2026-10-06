import { waitForResponseJob } from './job-stream'
import { ResponseJobSchema } from './response-jobs'
import { DEFAULT_GENERATION_TIMEOUT_MS } from './timeouts'
import { GeneratedImageSchema, MAX_IMAGE_BYTES } from './generated-image-protocol'
import {
  SessionSchema,
  CreateSessionSchema,
  DeleteSessionSchema,
  DeleteSessionResultSchema,
} from './sessions'
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
  images: z.array(GeneratedImageSchema).max(4).default([]),
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
        'LocalGPT controls the signed-in ChatGPT browser. First call localgpt_status, then localgpt_capabilities and localgpt_models sequentially. For each topic create a localgpt_session_create, then pass its id as session_id to every localgpt_respond continuation. All browser operations, including model/capability reads, generation, project placement, deletion and dots, run one at a time service-wide. All Codex callers and LocalGPT sessions share one existing ChatGPT tab selected by the server. Additional tabs stay on standby and receive no operations while the shared tab is connected. Only a disconnected shared tab is replaced, never during an in-flight operation. Do not open ChatGPT tabs or windows per caller, session or subagent. sharedBrowserId in status identifies the shared connection. Check localgpt_status and wait when busy; a 409 browser_busy rejects the operation before dispatch. Sessions default to the LocalGPT project. Generation confirms native project membership before completion; use localgpt_session_project to explicitly move an existing LocalGPT session into its configured project. Never autonomously use Computer Use, browser automation or direct ChatGPT tab manipulation to bypass or diagnose a routine LocalGPT failure; report structured errors or required manual extension/login actions. Computer Use requires explicit user authorization. Only choose model/effort combinations from capabilities.choices. For dots: list observed dots, select dotId, wait for selected/reconnection, send, then read messages after the returned outgoing messageId. A dot send receipt is not a completed answer and complete:false does not guarantee background completion. Pro models default to asynchronous response jobs; localgpt_response_start or localgpt_respond background:true returns a job receipt, not a completed answer. Await localgpt_response_get by job_id until completed or failed; it waits for SSE events for up to 25 seconds and returns immediately on completion. Call again immediately while in_progress, without polling sleeps. A thinking phase means observed thinking activity; unresponsive means no recent native API activity and an unknown outcome, not proof that work stopped. Keep polling without resending. lastActivityAt reports the last observed activity; no hidden reasoning is returned. Async generation has no elapsed-time cutoff. Polling stays bounded at 25 seconds and never cancels generation. Completed results expire after one hour; at most 100 jobs are retained. When LOCALGPT_RESPONSE_JOBS_DIR is configured, private job records survive server restart; pending work becomes unknown and keeps the browser slot reserved for manual recovery. Transport disconnects and incomplete native streams keep jobs in_progress/unresponsive, preserve partial text and reserve the browser slot; they never prove remote generation stopped. No automatic resend or remote cancellation is performed. Do not automatically resend timed-out sends. Preserve manual drafts. Use LocalMCP for all workspace file operations by default; if it cannot access the files, report the setup/access issue instead of silently using Codex file tools or shell reads. Delegate file summaries and reviews by sending short requests with LocalMCP-visible paths, optional line ranges or revision references, questions and output criteria. Never paste full file contents, large code blocks, diffs or logs into LocalGPT messages or instructions. The ChatGPT worker must read files through its own enabled LocalMCP-only plugin in the target conversation; caller LocalMCP availability or healthy gateway status does not prove worker access. If worker LocalMCP access is missing, report the setup issue and stop the dependent delegation. Never automatically fall back to inline file text or attachments. Never connect this LocalGPT endpoint back to its own ChatGPT worker: localgpt_respond would recurse. Attachment support is reserved for an explicit user request to upload specific files, never as a fallback for missing LocalMCP access.',
    },
  )
  async function invoke(path: string, schema: z.ZodType, body?: unknown, signal?: AbortSignal) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_GENERATION_TIMEOUT_MS + 10000)])
          : AbortSignal.timeout(DEFAULT_GENERATION_TIMEOUT_MS + 10000),
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
  async function withSavedImages(
    result: Awaited<ReturnType<typeof invoke>>,
    metadata: z.infer<typeof ResponseSchema>,
    signal?: AbortSignal,
  ) {
    if ('isError' in result) return result
    try {
      const pixels = await Promise.all(
        metadata.images.map(async (image) => {
          const response = await fetch(`${base}${image.url}`, {
            redirect: 'error',
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
              : AbortSignal.timeout(30000),
          })
          if (
            !response.ok ||
            response.headers.get('content-type')?.split(';')[0] !== image.mimeType
          )
            throw new Error('Saved image could not be read.')
          const bytes = Buffer.from(await response.arrayBuffer())
          if (bytes.length !== image.bytes || bytes.length > MAX_IMAGE_BYTES)
            throw new Error('Saved image size changed.')
          return {
            type: 'image' as const,
            mimeType: image.mimeType,
            data: bytes.toString('base64'),
          }
        }),
      )
      return { ...result, content: [...result.content, ...pixels] }
    } catch {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: 'Images were saved, but could not be returned. Use the saved file metadata to recover them; do not automatically resend generation.',
          },
        ],
        structuredContent: result.structuredContent,
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
        'Create a LocalGPT session for a topic. Pass its id as session_id to localgpt_respond to start and continue the same ChatGPT conversation. Defaults to the LocalGPT project; projectName:null opts out. Project placement occurs on the first response. Does not send a message.',
      inputSchema: CreateSessionSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args, extra) => invoke('/v1/sessions', SessionSchema, args, extra.signal),
  )
  server.registerTool(
    'localgpt_session_project',
    {
      description:
        "Explicitly move a LocalGPT session's bound ChatGPT conversation into its configured project (LocalGPT by default). Returns metadata only for unbound sessions. Rejects concurrent browser operations and sessions with projectName:null. Confirms native project membership before returning. Do not automatically retry a timed-out movement.",
      inputSchema: DeleteSessionSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) => invoke('/v1/sessions/project', SessionSchema, args, extra.signal),
  )
  server.registerTool(
    'localgpt_session_delete',
    {
      description:
        'Delete an explicitly selected, no-longer-needed LocalGPT session and its bound ChatGPT chat. Use only for disposable LocalGPT work; retain conversations needed for follow-up. Rejects active sessions and preserves manual drafts. Chat deletion is permanent. An unbound session only removes local metadata. On timeout, inspect the browser before retrying; deletion may already have happened.',
      inputSchema: DeleteSessionSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) =>
      invoke('/v1/sessions/delete', DeleteSessionResultSchema, args, extra.signal),
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
        'Read the connected browser’s ChatGPT API data: available Chat models, reasoning types and thinking effort choices, and account plan. Null means not observed; reload ChatGPT after installing version 2.4.14. Reports observed model selection choices; does not expose personal account information.',
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
        'Send text to the signed-in ChatGPT browser. Pro models automatically return an asynchronous response_job receipt; await localgpt_response_get by job_id until completion (SSE wait, no polling sleeps). background:true forces an async job for any model; false or omission keeps automatic Pro routing. Other requests wait on SSE for up to 25 seconds and return completed text/images, or a response_job receipt if still running; this also applies when no model is specified. Await localgpt_response_get immediately for any receipt, never resend the generation. Generated images are saved locally; the reply includes image pixels and persistent file paths in images. Saved images remain after session deletion. At most four PNG/JPEG/WebP/GIF images of 8 MiB each. Text goes to ChatGPT. Actual model is selected in the browser. newChat defaults to true; does not overwrite unsent drafts. For file analysis, send only LocalMCP-visible paths, relevant line ranges or revision references, questions and criteria. The worker must read files using its own enabled LocalMCP-only plugin; caller LocalMCP access is not proof of worker access. Never paste full files, large code blocks, diffs or logs, and never automatically substitute inline text or attachments when LocalMCP is unavailable. Report the setup/access issue instead. The files argument supports explicit user-requested uploads only (max 10 files, 8 MiB each, 16 MiB total), not routine file-reference delegation. LocalGPT itself does not edit workspace files; use LocalMCP for actual file operations. Response jobs have no generation time limit. Private configured job storage retains results and partial answer text; prompts are never persisted in job records or the session database.',
      inputSchema: {
        input: ResponsesRequestSchema.shape.input,
        background: z.boolean().optional(),
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
    async (args, extra) => {
      const { background, ...body } = args
      let model = args.model
      if (!model && args.session_id) {
        const listed = await invoke(
          '/v1/sessions',
          z.object({ object: z.literal('list'), data: z.array(SessionSchema) }),
          undefined,
          extra.signal,
        )
        if ('isError' in listed) return listed
        const session = z
          .array(SessionSchema)
          .parse(listed.structuredContent.data)
          .find((value) => value.id === args.session_id)
        model = session?.model ?? undefined
      }
      if (background === true || (model && /\bpro\b/i.test(model))) {
        return invoke(
          '/v1/response-jobs',
          ResponseJobSchema,
          { ...body, stream: false, store: false },
          extra.signal,
        )
      }
      const started = await invoke(
        '/v1/response-jobs',
        ResponseJobSchema,
        { ...body, stream: false, store: false },
        extra.signal,
      )
      if ('isError' in started) return started
      const receipt = ResponseJobSchema.parse(started.structuredContent)
      try {
        let progress = 0
        const job = await waitForResponseJob(base, receipt.id, 25000, extra.signal, (event) => {
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
            })
            .catch(() => {})
        })
        if (job.status === 'failed')
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${job.error?.code}: ${job.error?.message}` }],
          }
        if (job.status !== 'completed' || !job.result)
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(job) }],
            structuredContent: job,
          }
        const answer = ResponseSchema.parse(job.result)
        return withSavedImages(
          {
            content: [{ type: 'text' as const, text: JSON.stringify(answer) }],
            structuredContent: answer,
          },
          answer,
          extra.signal,
        )
      } catch (error) {
        // The send was accepted. Keep the job ID even if its SSE subscription failed.
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ...receipt,
                retrieval_error: error instanceof Error ? error.message : 'SSE retrieval failed',
                message: 'The job was accepted; resume with localgpt_response_get. Do not resend.',
              }),
            },
          ],
          structuredContent: receipt,
        }
      }
    },
  )
  server.registerTool(
    'localgpt_response_start',
    {
      description:
        'Start an asynchronous LocalGPT response and return a response_job receipt immediately. Does not mean the answer is complete. Await localgpt_response_get by job_id (SSE wait, no polling sleeps). The job survives start/poll client disconnects but holds the service-wide browser slot until completion or failure. Do not resend a job when thinking or unresponsive. Async generation has no elapsed-time cutoff. Results expire one hour after completion and survive restart when LOCALGPT_RESPONSE_JOBS_DIR is configured. Unknown disconnected work remains pending and reserves the browser slot. For file tasks reference LocalMCP-visible paths and let the worker read through its enabled LocalMCP plugin; never paste full files or large code/diffs/logs or automatically attach files.',
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
        'Wait for response_job events over SSE without navigating or claiming the browser slot. wait_ms defaults to 25000 (maximum), returns immediately on completion/failure; an unfinished job returns after that bounded wait. Call again immediately while in_progress, without sleeps. wait_ms:0 reads an immediate snapshot. in_progress is a pending receipt; only completed contains the final answer and saved images. thinking is observed activity; unresponsive means unknown activity, not confirmed stopping. disconnect or stream ambiguity remains in_progress/unresponsive, preserving partial text and browser ownership. Do not automatically resend. Completed results include original saved image pixels. Jobs expire one hour after completion; configured private LOCALGPT_RESPONSE_JOBS_DIR storage survives restart. Restarted pending jobs stay unknown and reserve the browser slot for manual recovery.',
      inputSchema: {
        job_id: z.string().uuid(),
        wait_ms: z.number().int().min(0).max(25000).default(25000),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args, extra) => {
      let result: Awaited<ReturnType<typeof invoke>>
      if (args.wait_ms === 0)
        result = await invoke(
          `/v1/response-jobs/${args.job_id}`,
          ResponseJobSchema,
          undefined,
          extra.signal,
        )
      else {
        try {
          let progress = 0
          const job = await waitForResponseJob(
            base,
            args.job_id,
            args.wait_ms,
            extra.signal,
            (event) => {
              const progressToken = extra._meta?.progressToken
              if (progressToken === undefined) return
              const message =
                event.type === 'response_job.updated'
                  ? event.job.phase
                  : event.type === 'response.output_text.delta'
                    ? event.delta.slice(-2000)
                    : event.text.slice(-2000)
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress: ++progress, message },
                })
                .catch(() => {})
            },
          )
          result = {
            content: [{ type: 'text' as const, text: JSON.stringify(job) }],
            structuredContent: job,
          }
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  error instanceof Error
                    ? error.message
                    : 'Job stream failed; do not resend generation.',
              },
            ],
          }
        }
      }
      if ('isError' in result) return result
      const job = ResponseJobSchema.parse(result.structuredContent)
      if (job.status !== 'completed' || !job.result) return result
      return withSavedImages(result, ResponseSchema.parse(job.result), extra.signal)
    },
  )

  return server
}
