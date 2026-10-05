import { DEFAULT_GENERATION_TIMEOUT_MS } from './timeouts'
import {
  STREAM_ARM_EVENT,
  STREAM_EVENT,
  StreamArmSchema,
  observeConversationResponse,
  type StreamEvent,
} from './conversation-stream'
import { DOT_EVENT, normalizeDots } from './dots'
import {
  TURN_EVENT,
  SubmittedTurnSchema,
  CAPABILITY_EVENT,
  CAPABILITY_REQUEST,
  emptyCapabilities,
  normalizeChoices,
  normalizeModels,
  normalizePlanDetails,
} from './capabilities'
// Runs in the page world at document_start. Observes exact metadata routes and sanitized outgoing message identifiers.
// Authentication remains inside ChatGPT's own fetch call; it is never copied.
type PageWindow = Pick<Window, 'location' | 'dispatchEvent' | 'addEventListener'> & {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  CustomEvent: typeof CustomEvent
  URL: typeof URL
  Headers: typeof Headers
  Request: typeof Request
}
export function installPageObserver(page: PageWindow) {
  // One armed send at a time; only the request whose exact outgoing user text matches is observed.
  let armed: ReturnType<typeof StreamArmSchema.parse> | null = null
  page.addEventListener(STREAM_ARM_EVENT, (event) => {
    try {
      const parsed = StreamArmSchema.safeParse(JSON.parse((event as CustomEvent<string>).detail))
      if (parsed.success) armed = parsed.data
    } catch {}
  })
  page.addEventListener('localgpt:stream-disarm', (event) => {
    if ((event as CustomEvent<string>).detail === armed?.requestId) armed = null
  })
  const publishStream = (event: StreamEvent) =>
    page.dispatchEvent(new page.CustomEvent(STREAM_EVENT, { detail: JSON.stringify(event) }))
  let snapshot = emptyCapabilities()
  let dots: ReturnType<typeof normalizeDots> = null
  const publishDots = () => {
    if (dots)
      page.dispatchEvent(
        new page.CustomEvent(DOT_EVENT, { detail: JSON.stringify({ ...dots, selected: null }) }),
      )
  }
  let context: string | null | undefined
  let epoch = 0
  const sequence = { models: 0, plan: 0, dots: 0 }
  const publish = () =>
    page.dispatchEvent(new page.CustomEvent(CAPABILITY_EVENT, { detail: JSON.stringify(snapshot) }))
  page.addEventListener(CAPABILITY_REQUEST, () => {
    publish()
    publishDots()
  })
  const original = page.fetch
  page.fetch = function (input, init) {
    let url: URL | undefined
    let observedRequest: Request | undefined
    try {
      url = new URL(
        typeof input === 'string' ? input : input instanceof page.URL ? input.href : input.url,
        page.location.href,
      )
      if (
        url.origin === 'https://chatgpt.com' &&
        url.pathname === '/backend-api/f/conversation' &&
        input instanceof page.Request &&
        typeof init?.body !== 'string'
      )
        observedRequest = input.clone()
    } catch {}
    const result = original.call(this, input, init)
    if (!url) return result
    if (url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/f/conversation') {
      const observeTurn = (body: string) => {
        try {
          if (body.length > 5_000_000) return
          const value = JSON.parse(body) as {
            conversation_id?: unknown
            messages?: {
              id?: unknown
              author?: { role?: unknown }
              content?: { parts?: unknown[] }
            }[]
          }
          const message = value.messages?.filter((m) => m.author?.role === 'user').at(-1)
          const parsed = SubmittedTurnSchema.safeParse({
            messageId: message?.id,
            conversationId: value.conversation_id ?? null,
          })
          if (parsed.success) {
            page.dispatchEvent(
              new page.CustomEvent(TURN_EVENT, { detail: JSON.stringify(parsed.data) }),
            )
            if (
              armed &&
              Array.isArray(message?.content?.parts) &&
              message.content.parts.filter((part) => typeof part === 'string').join('') ===
                armed.text
            ) {
              const { requestId, timeoutMs, backgroundJob } = armed
              armed = null
              const identity = { requestId, ...parsed.data }
              publishStream({ ...identity, kind: 'started' })
              void result
                .then((response) =>
                  observeConversationResponse(response.clone(), identity, publishStream, {
                    timeoutMs: timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
                    backgroundJob: backgroundJob === true,
                  }),
                )
                .catch(() =>
                  publishStream({
                    ...identity,
                    kind: 'error',
                    code: 'response_stream_interrupted',
                  }),
                )
            }
          }
        } catch {}
      }
      if (typeof init?.body === 'string') observeTurn(init.body)
      else if (observedRequest)
        void observedRequest
          .text()
          .then(observeTurn)
          .catch(() => {})
    }
    const kind =
      url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/tbo'
        ? 'dots'
        : url.origin === 'https://chatgpt.com' && url.pathname === '/backend-api/models'
          ? 'models'
          : url.origin === 'https://chatgpt.com' &&
              url.pathname === '/backend-api/accounts/check/v4-2023-04-27'
            ? 'plan'
            : null
    if (!kind) return result
    let accountId: string | null = null
    try {
      accountId = new page.Headers(
        init?.headers ?? (input instanceof page.Request ? input.headers : undefined),
      ).get('ChatGPT-Account-ID')
    } catch {
      /* No active account hint. */
    }
    if (context !== accountId) {
      context = accountId
      epoch++
      snapshot = emptyCapabilities()
      dots = null
      publish()
      page.dispatchEvent(
        new page.CustomEvent(DOT_EVENT, {
          detail: JSON.stringify({ dots: [], cursor: null, source: 'chatgpt_api', selected: null }),
        }),
      )
    }
    const requestEpoch = epoch
    const requestSequence = ++sequence[kind]
    void result
      .then(async (response) => {
        if (!response.ok || !response.headers.get('content-type')?.includes('json')) return
        const clone = response.clone()
        const reader = clone.body?.getReader()
        if (!reader) return
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 2_000_000) {
              await reader.cancel()
              return
            }
            chunks.push(value)
          }
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          if (requestEpoch !== epoch || requestSequence !== sequence[kind]) return
          const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
          if (kind === 'dots') {
            dots = normalizeDots(value)
            publishDots()
            return
          }
          snapshot = {
            ...snapshot,
            ...(kind === 'models'
              ? {
                  models: normalizeModels(value),
                  choices: normalizeChoices(value),
                  selectionSupported: normalizeChoices(value).length > 0,
                }
              : normalizePlanDetails(value, accountId)),
            observedAt: new Date().toISOString(),
          }
          publish()
        } finally {
          reader.releaseLock()
        }
      })
      .catch(() => {
        /* Observation must never break ChatGPT. */
      })
    return result
  }
}
