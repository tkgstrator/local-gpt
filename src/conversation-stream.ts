import { DEFAULT_GENERATION_TIMEOUT_MS, PROGRESS_IDLE_TIMEOUT_MS } from './timeouts'
import { z } from 'zod'
export const STREAM_ARM_EVENT = 'localgpt:stream-arm'
export const STREAM_EVENT = 'localgpt:response-stream'
export const StreamArmSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    text: z.string().min(1).max(5_000_000),
    newChat: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(7200000).optional(),
    backgroundJob: z.boolean().optional(),
  })
  .strict()
export const StreamEventSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    messageId: z.string().uuid(),
    conversationId: z.string().uuid().nullable(),
    kind: z.enum(['started', 'answer', 'stop', 'error', 'progress']),
    phase: z.enum(['processing', 'thinking', 'answering', 'unresponsive']).optional(),
    text: z.string().max(5_000_000).optional(),
    code: z.string().max(100).optional(),
  })
  .strict()
export type StreamEvent = z.infer<typeof StreamEventSchema>
export type StreamIdentity = Pick<StreamEvent, 'requestId' | 'messageId' | 'conversationId'>
type ObjectValue = Record<string, unknown>
const object = (v: unknown): v is ObjectValue =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
class StreamError extends Error {}
// Decode only the native response of the armed send. Never consume or replace ChatGPT's response.
export async function observeConversationResponse(
  response: Response,
  identity: StreamIdentity,
  emit: (event: StreamEvent) => void,
  options: { timeoutMs?: number; idleTimeoutMs?: number; backgroundJob?: boolean } = {},
) {
  let conversationId = identity.conversationId
  let ended = false
  let phase: 'processing' | 'thinking' | 'answering' = 'processing'
  let lastActivityAt = Date.now(),
    lastProgressAt = 0,
    idle = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let text = ''
  let finalComplete = false
  const channels = new Map<number, unknown>()
  const answers = new Map<string, string>()
  const textStates = new Map<string, boolean>()
  let previous = { c: 0, p: '', o: 'add' }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = (kind: StreamEvent['kind'], extra: Partial<StreamEvent> = {}) => {
    const value = StreamEventSchema.parse({ ...identity, conversationId, kind, ...extra })
    emit(value)
  }
  const fail = (code: string) => {
    if (!ended) {
      ended = true
      publish('error', { code })
    }
  }
  const activity = (next = phase) => {
    const now = Date.now()
    lastActivityAt = now
    if (idle || next !== phase || now - lastProgressAt >= 1000) {
      phase = next
      idle = false
      lastProgressAt = now
      publish('progress', { phase })
    } else phase = next
  }
  const update = (value: unknown) => {
    if (!object(value)) return
    if (value.error) throw new StreamError('chatgpt_api_error')
    if (value.conversation_id !== undefined) {
      const id = z.string().uuid().safeParse(value.conversation_id)
      if (!id.success || (conversationId && conversationId !== id.data))
        throw new StreamError('conversation_changed')
      if (conversationId !== id.data) {
        conversationId = id.data
        publish('started')
      }
    }
    const m = value.message
    if (!object(m) || !object(m.author) || !object(m.content)) return
    if (m.author.role === 'assistant' && m.channel === 'analysis') activity('thinking')
    if (m.content.content_type === 'model_editable_context') return
    if (m.author.role !== 'assistant') return
    if (
      (m.channel !== undefined && m.channel !== null && m.channel !== 'final') ||
      (m.recipient !== undefined && m.recipient !== 'all')
    )
      return
    if (object(m.metadata) && m.metadata.is_visually_hidden_from_conversation === true) return
    // A failed internal tool/reasoning step does not establish that the final response failed.
    if (m.status === 'failed' || m.status === 'cancelled')
      throw new StreamError(
        m.status === 'cancelled' ? 'chatgpt_generation_cancelled' : 'chatgpt_generation_failed',
      )
    if (typeof m.id !== 'string' || !object(m.content)) return
    if (
      m.content.content_type !== 'text' ||
      !Array.isArray(m.content.parts) ||
      !m.content.parts.every((p) => typeof p === 'string')
    ) {
      throw new StreamError('unsupported_response_content')
    }
    if (m.content.parts.join('').trim()) activity('answering')
    answers.set(m.id, m.content.parts.join(''))
    textStates.set(m.id, m.status === 'finished_successfully')
    const next = [...answers.values()].join('\n\n')
    if (next !== text) {
      text = next
      publish('answer', { text })
    }
    finalComplete = m.status === 'finished_successfully' && m.end_turn === true
  }
  const patch = (root: unknown, path: string, op: string, value: unknown): unknown => {
    if (op === 'patch') {
      if (!Array.isArray(value)) throw new StreamError('unsupported_response_stream')
      for (const part of value) {
        if (!object(part) || typeof part.p !== 'string' || typeof part.o !== 'string')
          throw new StreamError('unsupported_response_stream')
        root = patch(root, path + part.p, part.o, part.v)
      }
      return root
    }
    if (path !== '' && !path.startsWith('/')) throw new StreamError('unsupported_response_stream')
    const keys =
      path === ''
        ? []
        : path
            .slice(1)
            .split('/')
            .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    if (keys.some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)))
      throw new StreamError('unsupported_response_stream')
    const apply = (old: unknown) => {
      if (op === 'add' || op === 'replace') return value
      if (op === 'remove') return undefined
      if (op === 'append') {
        if (typeof old === 'string' && typeof value === 'string') return old + value
        if (Array.isArray(old)) return old.concat(value)
        if (object(old) && object(value)) return { ...old, ...value }
      }
      throw new StreamError('unsupported_response_stream')
    }
    if (!keys.length) return apply(root)
    let parent: unknown = root
    for (const key of keys.slice(0, -1)) {
      if (!object(parent) && !Array.isArray(parent))
        throw new StreamError('unsupported_response_stream')
      parent = (parent as ObjectValue)[key]
    }
    if (!object(parent) && !Array.isArray(parent))
      throw new StreamError('unsupported_response_stream')
    const key = keys.at(-1)!
    if (Array.isArray(parent) && (!/^\d+$/.test(key) || Number(key) > parent.length))
      throw new StreamError('unsupported_response_stream')
    if (op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1)
      else delete parent[key]
    } else (parent as ObjectValue)[key] = apply((parent as ObjectValue)[key])
    return root
  }
  const frame = (event: string, data: string) => {
    if (ended || !data) return
    if (data === '[DONE]') {
      if ([...answers.entries()].some(([id, value]) => value.trim() && !textStates.get(id)))
        throw new StreamError('response_incomplete')
      if (!finalComplete || !text.trim() || !conversationId)
        throw new StreamError('response_incomplete')
      ended = true
      publish('stop')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      throw new StreamError('unsupported_response_stream')
    }
    if (event === 'delta_encoding') {
      if (value !== 'v1') throw new StreamError('unsupported_response_stream')
      return
    }
    if (event === 'error' || (object(value) && value.error))
      throw new StreamError('chatgpt_api_error')
    if (event === 'delta') {
      if (!object(value)) throw new StreamError('unsupported_response_stream')
      const c = value.c ?? previous.c,
        p = value.p ?? previous.p,
        o = value.o ?? previous.o
      if (
        !Number.isInteger(c) ||
        (c as number) < 0 ||
        (c as number) > 100 ||
        typeof p !== 'string' ||
        typeof o !== 'string'
      )
        throw new StreamError('unsupported_response_stream')
      previous = { c: c as number, p, o }
      const state = patch(channels.get(previous.c), p, o, value.v)
      channels.set(previous.c, state)
      update(state)
    } else update(value)
  }
  try {
    if (!response.ok) throw new StreamError('chatgpt_http_error')
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body)
      throw new StreamError('unsupported_response_stream')
    reader = response.body.getReader()
    if (!options.backgroundJob)
      timer = setTimeout(() => {
        fail('response_stream_timeout')
        void reader?.cancel().catch(() => {})
      }, options.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS)
    const idleLimit = options.idleTimeoutMs ?? PROGRESS_IDLE_TIMEOUT_MS
    const checkIdle = () => {
      if (ended) return
      if (Date.now() - lastActivityAt >= idleLimit && !idle) {
        idle = true
        publish('progress', { phase: 'unresponsive' })
      }
      idleTimer = setTimeout(checkIdle, Math.min(idleLimit, 1000))
    }
    idleTimer = setTimeout(checkIdle, Math.min(idleLimit, 1000))
    const decoder = new TextDecoder()
    let buffer = '',
      event = '',
      data: string[] = [],
      total = 0
    const consume = () => {
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer)
        if (!match || (match[0] === '\r' && match.index === buffer.length - 1)) return
        const line = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        if (line === '') {
          frame(event, data.join('\n'))
          event = ''
          data = []
          if (ended) return
        } else if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '')
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
    }
    while (!ended) {
      const chunk = await reader.read()
      if (chunk.done) {
        buffer += decoder.decode()
        consume()
        if (!ended) throw new StreamError('response_stream_interrupted')
        break
      }
      total += chunk.value.byteLength
      if (total > 32_000_000) throw new StreamError('response_stream_too_large')
      activity()
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length + data.reduce((n, s) => n + s.length, 0) > 5_000_000)
        throw new StreamError('response_stream_too_large')
      consume()
    }
  } catch (error) {
    fail(error instanceof StreamError ? error.message : 'response_stream_interrupted')
  } finally {
    if (timer) clearTimeout(timer)
    if (idleTimer) clearTimeout(idleTimer)
    if (reader) {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}
