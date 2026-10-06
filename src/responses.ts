import type { GeneratedImage } from './generated-image-protocol'
import { FilesSchema } from './attachment-protocol'
import { z } from 'zod'
import type { ChatRequest } from './protocol'
z.config({ jitless: true })
const text = z.string().refine((value) => value.trim().length > 0, 'Text cannot be blank')
const message = z
  .object({
    type: z.literal('message').optional(),
    role: z.enum(['user', 'assistant', 'system', 'developer']),
    content: z.union([
      text,
      z.array(z.object({ type: z.literal('input_text'), text }).strict()).min(1),
    ]),
  })
  .strict()
// Reject unsupported official options instead of silently pretending to honor them.
export const ResponsesRequestSchema = z
  .object({
    input: z.union([text, z.array(message).min(1)]),
    files: FilesSchema.optional(),
    instructions: text.optional(),
    model: text.optional(),
    reasoning: z.object({ effort: text }).strict().optional(),
    session_id: z.string().uuid().optional(),
    stream: z.boolean().default(false),
    store: z.literal(false).default(false),
    newChat: z.boolean().default(true),
  })
  .strict()
export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>
export function toChatRequest(body: ResponsesRequest): ChatRequest {
  const messages: ChatRequest['messages'] =
    typeof body.input === 'string'
      ? [{ role: 'user', content: body.input }]
      : body.input.map((item) => ({
          role: item.role,
          content:
            typeof item.content === 'string'
              ? item.content
              : item.content.map((part) => part.text).join('\n'),
        }))
  if (body.instructions) messages.unshift({ role: 'developer', content: body.instructions })
  return {
    messages,
    files: body.files,
    model: body.model,
    reasoning: body.reasoning,
    session_id: body.session_id,
    stream: body.stream,
    newChat: body.newChat,
  }
}
export function createResponsesWriter(
  write: (data: string) => unknown,
  requestId: string,
  body: ResponsesRequest,
) {
  const id = `resp_${requestId}`
  const itemId = `msg_${requestId}`
  const createdAt = Math.floor(Date.now() / 1000)
  let sequence = 0
  const part = (text: string) => ({ type: 'output_text', text, annotations: [], logprobs: [] })
  const item = (text: string, status: string) => ({
    id: itemId,
    type: 'message',
    status,
    role: 'assistant',
    content: [part(text)],
  })
  const response = (
    text: string,
    status: string,
    error: { code: string; message: string } | null = null,
    images: GeneratedImage[] = [],
  ) => ({
    id,
    object: 'response',
    session_id: body.session_id ?? null,
    created_at: createdAt,
    completed_at: status === 'completed' ? Math.floor(Date.now() / 1000) : null,
    status,
    error,
    incomplete_details: null,
    model: body.model || 'browser-selected',
    output:
      status === 'in_progress'
        ? []
        : [item(text, status === 'completed' ? 'completed' : 'incomplete')],
    instructions: body.instructions ?? null,
    usage: null,
    store: false,
    images,
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false,
    previous_response_id: null,
    metadata: {},
  })
  const emit = (type: string, data: Record<string, unknown>) =>
    write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`,
    )
  const indexes = { item_id: itemId, output_index: 0, content_index: 0 }
  return {
    response,
    start() {
      emit('response.created', { response: response('', 'in_progress') })
      emit('response.in_progress', { response: response('', 'in_progress') })
      emit('response.output_item.added', {
        output_index: 0,
        item: { ...item('', 'in_progress'), content: [] },
      })
      emit('response.content_part.added', { ...indexes, part: part('') })
    },
    delta(delta: string) {
      emit('response.output_text.delta', { ...indexes, delta, logprobs: [] })
    },
    complete(text: string, images: GeneratedImage[] = []) {
      emit('response.output_text.done', { ...indexes, text, logprobs: [] })
      emit('response.content_part.done', { ...indexes, part: part(text) })
      emit('response.output_item.done', { output_index: 0, item: item(text, 'completed') })
      for (const image of images) emit('response.image.saved', { image })
      emit('response.completed', { response: response(text, 'completed', null, images) })
    },
    fail(text: string, code: string, message: string) {
      emit('response.failed', { response: response(text, 'failed', { code, message }) })
    },
  }
}
