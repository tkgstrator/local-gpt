import { attachLocalMcpTools, readLocalMcpConfig, type LocalMcpConfig } from './localmcp'
import { filePrompt, loadFiles } from './attachments'
import { createSessionStore, CreateSessionSchema } from './sessions'
import { DotActionSchema } from './dots'
import express from 'express'
import { createMcpServer } from './mcp'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ResponsesRequestSchema, toChatRequest, createResponsesWriter } from './responses'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Server } from 'bun'
interface BrowserSocket {
  readyState: number
  send(text: string, callback?: (err?: Error) => void): void
}
interface SocketData {
  client: BrowserSocket | null
  lane: BrowserLane
}
interface BrowserLane {
  id: string
  browser: BrowserSocket | null
  pending: Pending | null
  polling: { id: string; seenAt: number } | null
  queued: BrowserRequest | null
}
import {
  BrowserEventSchema,
  ChatRequestSchema,
  type BrowserRequest,
  type BrowserEvent,
} from './protocol'

interface Options {
  host: string
  httpPort: number
  wsPort: number
  timeoutMs: number
  bridgeToken?: string
  pollingLeaseMs?: number
  sessionsFile?: string
  localMcp?: LocalMcpConfig
}
interface Pending {
  requestId: string
  sessionId?: string
  navigating?: boolean
  event: (event: BrowserEvent) => void
  fail: (status: number, code: string, message: string) => void
}
export function createService(options: Options) {
  const sessions = createSessionStore(options.sessionsFile)
  const app = express()
  const http = createServer(app)
  let wsServer: Server<SocketData> | null = null
  const lanes = new Map<string, BrowserLane>()
  const sessionOwners = new Map<string, string>()
  const dotOwners = new Map<string, string>()
  let lastDotLane: string | null = null
  let legacyOwner: string | null = null
  const laneFor = (id: string) => {
    let lane = lanes.get(id)
    if (!lane) {
      lane = { id, browser: null, pending: null, polling: null, queued: null }
      lanes.set(id, lane)
    }
    return lane
  }
  const availableLane = (sessionId?: string) => {
    const owner = sessionId ? lanes.get(sessionOwners.get(sessionId) ?? '') : undefined
    return owner && connected(owner) && !owner.pending
      ? owner
      : ([...lanes.values()].find((lane) => connected(lane) && !lane.pending) ??
          [...lanes.values()].find((lane) => connected(lane)) ??
          laneFor('disconnected'))
  }
  app.use(express.json({ limit: '1mb' }))
  const wsConnected = (lane: BrowserLane) => lane.browser?.readyState === 1
  const pollingLeaseMs = options.pollingLeaseMs ?? 5000
  const pollingConnected = (lane: BrowserLane) =>
    lane.polling !== null &&
    Date.now() - lane.polling.seenAt < (lane.pending?.navigating ? 20000 : pollingLeaseMs)
  const expireLane = (lane: BrowserLane) => {
    if (lane.polling && !pollingConnected(lane)) {
      lane.polling = null
      lane.queued = null
      lane.pending?.fail(503, 'browser_disconnected', 'ChatGPT HTTP browser connection expired.')
    }
  }
  const expirePolling = () => {
    for (const lane of lanes.values()) {
      expireLane(lane)
      if (!connected(lane) && !lane.pending) lanes.delete(lane.id)
    }
  }
  const leaseTimer = setInterval(expirePolling, Math.min(1000, Math.max(10, pollingLeaseMs / 2)))
  leaseTimer.unref()
  const connected = (lane: BrowserLane) => wsConnected(lane) || pollingConnected(lane)
  // Validate every HTTP entry, including bundles containing the pairing key.
  app.use((req, res, next) => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) {
      res.status(403).json({ error: { code: 'invalid_host' } })
      return
    }
    const origin = req.get('Origin')
    if (!origin) {
      next()
      return
    }
    if (
      req.path.startsWith('/bridge/') &&
      (origin === 'https://chatgpt.com' || /^chrome-extension:\/\/[a-p]{32}$/.test(origin))
    ) {
      next()
      return
    }
    let originUrl: URL
    try {
      originUrl = new URL(origin)
    } catch {
      res.status(403).end()
      return
    }
    if (
      originUrl.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname) ||
      originUrl.port !== String((http.address() as { port: number } | null)?.port)
    ) {
      res.status(403).json({ error: { code: 'invalid_origin' } })
      return
    }
    next()
  })
  // Each Streamable HTTP request gets a stateless transport, with no session retention.
  app.post('/mcp', async (req, res) => {
    const address = http.address()
    if (!address || typeof address === 'string') {
      res.status(503).end()
      return
    }
    const mcp = createMcpServer(`http://127.0.0.1:${address.port}`)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    let upstream: Awaited<ReturnType<typeof attachLocalMcpTools>>
    res.on('close', () => {
      void upstream?.close().catch(() => {})
      void transport.close()
      void mcp.close()
    })
    try {
      upstream = await attachLocalMcpTools(mcp, options.localMcp)
      if (res.destroyed) {
        await upstream?.close()
        return
      }
      await mcp.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch {
      if (!res.headersSent) res.status(500).json({ error: { code: 'mcp_error' } })
    }
  })
  app.get('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST')
    res.status(405).end()
  })
  app.delete('/mcp', (_req, res) => {
    res.setHeader('Allow', 'POST')
    res.status(405).end()
  })
  app.get('/v1/localmcp', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!options.localMcp) {
      res.json({
        configured: false,
        connected: false,
        tools: [],
        chatgptConnection: 'not_verified',
      })
      return
    }
    const probe = createMcpServer('http://127.0.0.1:8766')
    let upstream: Awaited<ReturnType<typeof attachLocalMcpTools>>
    try {
      upstream = await attachLocalMcpTools(probe, options.localMcp)
      res.json(upstream?.status())
    } catch {
      res.status(503).json({
        configured: true,
        connected: false,
        error: 'localmcp_unavailable',
        chatgptConnection: 'not_verified',
      })
    } finally {
      await upstream?.close()
      await probe.close()
    }
  })
  app.get('/v1/sessions', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ object: 'list', data: sessions.list() })
  })
  app.post('/v1/sessions', (req, res) => {
    const parsed = CreateSessionSchema.safeParse(req.body as unknown)
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'invalid_session' } })
      return
    }
    res.status(201).json(sessions.create(parsed.data))
  })
  app.get('/health', (_req, res) => {
    expirePolling()
    const active = [...lanes.values()].filter((lane) => connected(lane))
    res.json({
      status: 'ok',
      browserConnected: active.length > 0,
      transport: active.some((lane) => wsConnected(lane))
        ? 'websocket'
        : active.length
          ? 'http'
          : null,
      busy: active.some((lane) => lane.pending !== null),
      browsers: active.length,
      availableBrowsers: active.filter((lane) => !lane.pending).length,
      wsPort: options.wsPort,
    })
  })
  app.use('/bridge', (req, res, next) => {
    expirePolling()
    if (!options.bridgeToken || req.get('X-Bridge-Token') !== options.bridgeToken) {
      res.status(401).json({ error: { code: 'unauthorized' } })
      return
    }
    const id = req.get('X-Browser-Id')
    if (!id || id.length > 100) {
      res.status(400).json({ error: { code: 'invalid_browser_id' } })
      return
    }
    if (!lanes.has(id) && lanes.size >= 32) {
      res.status(429).json({ error: { code: 'browser_limit' } })
      return
    }
    const lane = laneFor(id)
    res.locals.lane = lane
    if (wsConnected(lane) || (pollingConnected(lane) && lane.polling?.id !== id)) {
      res.status(409).json({ error: { code: 'browser_already_connected' } })
      return
    }
    lane.polling = { id, seenAt: Date.now() }
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.post('/bridge/poll', (_req, res) => {
    const lane = res.locals.lane as BrowserLane
    const request = lane.queued
    lane.queued = null
    res.json({ request })
  })
  app.post('/bridge/event', (req, res) => {
    const lane = res.locals.lane as BrowserLane
    const parsed = BrowserEventSchema.safeParse(req.body as unknown)
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'invalid_browser_message' } })
      return
    }
    if (parsed.data.type !== 'heartbeat' && parsed.data.requestId === lane.pending?.requestId)
      lane.pending.event(parsed.data)
    res.json({ ok: true })
  })
  const extensionVersion = (
    JSON.parse(readFileSync(resolve('extension/manifest.json'), 'utf8')) as { version: string }
  ).version
  if (!/^\d+\.\d+\.\d+$/.test(extensionVersion)) throw new Error('Invalid extension version')
  app.get('/extension', (_req, res) =>
    res.download(
      resolve(`dist/localgpt-extension-${extensionVersion}.zip`),
      `localgpt-extension-${extensionVersion}.zip`,
    ),
  )
  app.get('/userscript', (_req, res) =>
    res.type('application/javascript').sendFile(resolve('dist/chatgpt-api.user.js')),
  )
  app.get('/assets/dashboard.css', (_req, res) => res.sendFile(resolve('dist/dashboard.css')))
  app.get('/assets/dashboard.js', (_req, res) => res.sendFile(resolve('dist/dashboard.js')))
  const info = (_req: express.Request, res: express.Response) =>
    res.sendFile(resolve('dist/dashboard.html'))
  app.get('/', info)
  app.get('/v1/chat/completions', info)
  app.get('/v1/responses', info)
  const receiveBrowserMessage = (raw: string | Buffer, lane: BrowserLane) => {
    let value: unknown
    try {
      value = JSON.parse(raw.toString())
    } catch {
      lane.pending?.fail(502, 'invalid_browser_message', 'Browser sent invalid JSON.')
      return
    }
    const parsed = BrowserEventSchema.safeParse(value)
    if (!parsed.success) {
      lane.pending?.fail(502, 'invalid_browser_message', 'Browser message failed validation.')
      return
    }
    if (parsed.data.type !== 'heartbeat' && parsed.data.requestId === lane.pending?.requestId)
      lane.pending.event(parsed.data)
  }
  app.get('/v1/models', (_req, res) => {
    const lane = availableLane()
    expirePolling()
    const error = (status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } })
    if (!connected(lane)) {
      error(503, 'browser_disconnected', 'Open ChatGPT with LocalGPT enabled.')
      return
    }
    if (lane.pending) {
      error(409, 'browser_busy', 'The browser is processing another request.')
      return
    }
    const requestId = randomUUID()
    let finished = false
    const cleanup = () => {
      finished = true
      clearTimeout(timer)
      if (lane.pending?.requestId === requestId) lane.pending = null
      if (lane.queued?.requestId === requestId) lane.queued = null
    }
    const fail = (status: number, code: string, message: string) => {
      if (finished) return
      cleanup()
      error(status, code, message)
    }
    const timer = setTimeout(
      () => fail(504, 'browser_timeout', 'Timed out reading model names.'),
      Math.min(options.timeoutMs, 10000),
    )
    lane.pending = {
      requestId,
      fail,
      event(event) {
        if (finished || event.type === 'heartbeat') return
        if (event.type === 'error') {
          fail(502, event.code, event.message)
          return
        }
        if (event.type !== 'models') {
          fail(502, 'invalid_browser_message', 'Expected a model observation.')
          return
        }
        cleanup()
        res.json({
          object: 'list',
          data: event.models.map((label) => ({
            id: label,
            object: 'model',
            created: 0,
            owned_by: 'browser',
            display_name: label,
          })),
          selected: event.selected,
          selectionLabel: event.selectionLabel,
          source: event.source,
          scope: 'currently_visible_controls',
          canSelect: false,
        })
      },
    }
    res.on('close', () => {
      if (!finished) cleanup()
    })
    const payload: BrowserRequest = { type: 'models', requestId }
    if (wsConnected(lane))
      lane.browser!.send(JSON.stringify(payload), (err) => {
        if (err) fail(503, 'browser_disconnected', 'Unable to send to browser.')
      })
    else lane.queued = payload
  })
  app.get('/v1/capabilities', (_req, res) => {
    const lane = availableLane()
    expirePolling()
    const error = (status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } })
    if (!connected(lane)) {
      error(503, 'browser_disconnected', 'Open ChatGPT with LocalGPT enabled.')
      return
    }
    if (lane.pending) {
      error(409, 'browser_busy', 'The browser is processing another request.')
      return
    }
    const requestId = randomUUID()
    let finished = false
    const cleanup = () => {
      finished = true
      clearTimeout(timer)
      if (lane.pending?.requestId === requestId) lane.pending = null
      if (lane.queued?.requestId === requestId) lane.queued = null
    }
    const fail = (status: number, code: string, message: string) => {
      if (finished) return
      cleanup()
      error(status, code, message)
    }
    const timer = setTimeout(
      () => fail(504, 'browser_timeout', 'Timed out reading browser capabilities.'),
      Math.min(options.timeoutMs, 10000),
    )
    lane.pending = {
      requestId,
      fail,
      event(event) {
        if (finished || event.type === 'heartbeat') return
        if (event.type === 'error') {
          fail(502, event.code, event.message)
          return
        }
        if (event.type !== 'capabilities') {
          fail(502, 'invalid_browser_message', 'Expected browser capabilities.')
          return
        }
        cleanup()
        const { type: _type, requestId: _id, ...snapshot } = event
        res.setHeader('Cache-Control', 'no-store')
        res.json(snapshot)
      },
    }
    res.on('close', () => {
      if (!finished) cleanup()
    })
    const payload: BrowserRequest = { type: 'capabilities', requestId }
    if (wsConnected(lane))
      lane.browser!.send(JSON.stringify(payload), (err) => {
        if (err) fail(503, 'browser_disconnected', 'Unable to send to browser.')
      })
    else lane.queued = payload
  })
  app.all(['/v1/dots', '/v1/dots/select', '/v1/dots/messages'], (req, res) => {
    let value: unknown
    if (req.path === '/v1/dots' && req.method === 'GET') value = { action: 'list' }
    else if (req.path === '/v1/dots/select' && req.method === 'POST')
      value = { ...req.body, action: 'select' }
    else if (req.path === '/v1/dots/messages' && req.method === 'POST')
      value = { ...req.body, action: 'send' }
    else if (req.path === '/v1/dots/messages' && req.method === 'GET')
      value = {
        action: 'messages',
        dotId: req.query.dotId,
        ...(req.query.afterMessageId ? { afterMessageId: req.query.afterMessageId } : {}),
        ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
      }
    else {
      res.status(405).end()
      return
    }
    const operation = DotActionSchema.safeParse(value)
    if (!operation.success) {
      res.status(400).json({
        error: {
          code: 'invalid_dot_request',
          message:
            'Supply an observed dotId, nonblank text for send, and an optional rendered message cursor.',
        },
      })
      return
    }
    expirePolling()
    const ownerId =
      operation.data.action === 'list' ? lastDotLane : dotOwners.get(operation.data.dotId)
    const lane = ownerId ? (lanes.get(ownerId) ?? laneFor('disconnected')) : availableLane()
    const error = (status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } })
    if (!connected(lane)) {
      error(503, 'browser_disconnected', 'Open ChatGPT with LocalGPT enabled.')
      return
    }
    if (lane.pending) {
      error(409, 'browser_busy', 'The browser is processing another request.')
      return
    }
    const requestId = randomUUID()
    let finished = false
    const cleanup = () => {
      finished = true
      clearTimeout(timer)
      if (lane.pending?.requestId === requestId) lane.pending = null
      if (lane.queued?.requestId === requestId) lane.queued = null
    }
    const fail = (status: number, code: string, message: string) => {
      if (finished) return
      cleanup()
      error(status, code, message)
    }
    const timer = setTimeout(
      () =>
        fail(
          504,
          'browser_timeout',
          'Timed out waiting for a dot operation. Sending may already have occurred; do not automatically retry.',
        ),
      Math.min(options.timeoutMs, 18000),
    )
    lane.pending = {
      requestId,
      fail,
      event(event) {
        if (finished || event.type === 'heartbeat') return
        if (event.type === 'error') {
          fail(502, event.code, event.message)
          return
        }
        if (event.type !== 'dots' || event.result.action !== operation.data.action) {
          fail(502, 'invalid_browser_message', 'Expected a matching dot operation.')
          return
        }
        if (operation.data.action !== 'list') {
          const returned =
            event.result.action === 'select'
              ? event.result.dot.id
              : 'dotId' in event.result
                ? event.result.dotId
                : null
          if (returned !== operation.data.dotId) {
            fail(502, 'invalid_browser_message', 'Dot reply was for a different dot.')
            return
          }
        }
        lastDotLane = lane.id
        if (event.result.action === 'list') {
          for (const dot of event.result.dots)
            if (!dotOwners.has(dot.id) || event.result.selected === dot.id)
              dotOwners.set(dot.id, lane.id)
        } else if (event.result.action === 'select') dotOwners.set(event.result.dot.id, lane.id)
        cleanup()
        res.setHeader('Cache-Control', 'no-store')
        res.json(event.result)
      },
    }
    res.on('close', () => {
      if (!finished) cleanup()
    })
    const payload: BrowserRequest = { type: 'dots', requestId, operation: operation.data }
    if (wsConnected(lane))
      lane.browser!.send(JSON.stringify(payload), (err) => {
        if (err) fail(503, 'browser_disconnected', 'Unable to send to browser.')
      })
    else lane.queued = payload
  })
  app.post(['/v1/chat/completions', '/v1/responses'], (req, res) => {
    expirePolling()
    const responsesMode = req.path === '/v1/responses'
    const responsesParsed = responsesMode
      ? ResponsesRequestSchema.safeParse(req.body as unknown)
      : null
    const parsed = responsesMode
      ? responsesParsed!.success
        ? { success: true as const, data: toChatRequest(responsesParsed!.data) }
        : { success: false as const }
      : ChatRequestSchema.safeParse(req.body as unknown)
    const error = (status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message, type: 'browser_api_error' } })
    if (!parsed.success) {
      error(
        400,
        'invalid_request',
        responsesMode
          ? 'Supports text input, instructions, model, reasoning effort, session_id, stream, store:false and newChat. Unsupported fields or blank text are not allowed.'
          : 'messages must contain text messages; stream and newChat must be booleans.',
      )
      return
    }
    const lane =
      !parsed.data.session_id && !parsed.data.newChat && legacyOwner
        ? (lanes.get(legacyOwner) ?? laneFor('disconnected'))
        : availableLane(parsed.data.session_id)
    if (
      [...lanes.values()].some(
        (other) => other.pending && (!parsed.data.session_id || !other.pending.sessionId),
      )
    ) {
      error(409, 'browser_busy', 'Use distinct session_id values for concurrent requests.')
      return
    }
    if (
      parsed.data.session_id &&
      [...lanes.values()].some((other) => other.pending?.sessionId === parsed.data.session_id)
    ) {
      error(409, 'session_busy', 'This session is already generating a response.')
      return
    }
    if (!connected(lane)) {
      error(503, 'browser_disconnected', 'Open ChatGPT with the built userscript enabled.')
      return
    }
    if (lane.pending) {
      error(
        409,
        'browser_busy',
        'All connected ChatGPT tabs are busy. Open another ChatGPT tab for a different session.',
      )
      return
    }
    let files: ReturnType<typeof loadFiles>
    try {
      files = loadFiles(parsed.data.files)
    } catch (err) {
      error(
        400,
        'invalid_attachment',
        err instanceof Error ? err.message : 'Unable to read attachment.',
      )
      return
    }
    const requestId = randomUUID()
    const session = parsed.data.session_id ? sessions.get(parsed.data.session_id) : null
    if (parsed.data.session_id && !session) {
      error(404, 'session_not_found', 'Unknown LocalGPT session ID.')
      return
    }
    const body = {
      ...parsed.data,
      model: parsed.data.model ?? session?.model ?? undefined,
      reasoning:
        parsed.data.reasoning ?? (session?.effort ? { effort: session.effort } : undefined),
      newChat: session ? !session.conversationId : parsed.data.newChat,
    }
    const responsesBody = responsesParsed?.success
      ? { ...responsesParsed.data, model: body.model, reasoning: body.reasoning }
      : null
    const responses = responsesBody
      ? createResponsesWriter((data) => res.write(data), requestId, responsesBody)
      : null
    let text = ''
    let streamingStarted = false
    let finished = false
    const startStream = () => {
      if (streamingStarted) return
      streamingStarted = true
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.flushHeaders()
      responses?.start()
    }
    const cleanup = () => {
      finished = true
      clearTimeout(timer)
      if (lane.pending?.requestId === requestId) lane.pending = null
      if (lane.queued?.requestId === requestId) lane.queued = null
    }
    const fail = (status: number, code: string, message: string) => {
      if (finished) return
      cleanup()
      if (streamingStarted && responses) {
        responses.fail(text, code, message)
        res.end()
      } else if (streamingStarted) {
        res.write(`data: ${JSON.stringify({ error: { code, message } })}\n\ndata: [DONE]\n\n`)
        res.end()
      } else error(status, code, message)
    }
    const timer = setTimeout(
      () => fail(504, 'browser_timeout', 'Timed out waiting for the ChatGPT browser.'),
      options.timeoutMs,
    )
    lane.pending = {
      requestId,
      fail,
      sessionId: body.session_id,
      event(event) {
        if (finished || event.type === 'heartbeat') return
        if (event.type === 'error') {
          fail(502, event.code, event.message)
          return
        }
        if (event.type === 'navigate') {
          if (!session?.conversationId || event.conversationId !== session.conversationId) {
            fail(502, 'invalid_navigation', 'Unexpected conversation navigation.')
            return
          }
          if (lane.pending) lane.pending.navigating = true
          lane.queued = payload
          if (wsConnected(lane))
            lane.browser!.send(JSON.stringify({ type: 'navigation_ready', requestId }))
          return
        }
        if (lane.pending) lane.pending.navigating = false
        if (event.type === 'models' || event.type === 'capabilities' || event.type === 'dots') {
          fail(502, 'invalid_browser_message', 'Unexpected model reply for a generation request.')
          return
        }
        if (event.type === 'answer') {
          if (body.stream) {
            startStream()
            // Streaming can append text, but cannot retract a previous delta.
            if (!event.text.startsWith(text)) {
              fail(502, 'answer_rewritten', 'The streamed answer changed previously emitted text.')
              return
            }
            const delta = event.text.slice(text.length)
            if (delta && responses) responses.delta(delta)
            else if (delta)
              res.write(
                `data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`,
              )
          }
          text = event.text
          return
        }
        if (session) {
          if (!event.conversationId) {
            fail(
              502,
              'conversation_unbound',
              'ChatGPT conversation ID was not captured. Do not automatically resend.',
            )
            return
          }
          try {
            sessions.bind(session.id, event.conversationId, body.model, body.reasoning?.effort)
            sessionOwners.set(session.id, lane.id)
          } catch {
            fail(502, 'session_mismatch', 'Browser replied from a different conversation.')
            return
          }
        }
        if (!body.session_id) legacyOwner = lane.id
        cleanup()
        if (body.stream) {
          startStream()
          if (responses) responses.complete(text)
          else
            res.write(
              `data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
            )
          res.end()
        } else if (responses) res.json(responses.response(text, 'completed'))
        else
          res.json({
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'browser-selected',
            session_id: body.session_id ?? null,
            choices: [
              { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
            ],
          })
      },
    }
    res.on('close', () => {
      if (!finished) cleanup()
    })
    if (body.stream && responses) startStream()
    const payload: BrowserRequest = {
      type: 'request',
      requestId,
      ...(files.some((file) => file.mode === 'upload')
        ? { files: files.filter((file) => file.mode === 'upload') }
        : {}),
      text: [formatMessages(body.messages), filePrompt(files)].filter(Boolean).join('\n\n'),
      newChat: body.newChat,
      ...(body.model ? { model: body.model } : {}),
      ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      ...(session?.conversationId ? { conversationId: session.conversationId } : {}),
    }
    if (wsConnected(lane))
      lane.browser!.send(JSON.stringify(payload), (err) => {
        if (err) fail(503, 'browser_disconnected', 'Unable to send to the browser.')
      })
    else lane.queued = payload
  })
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        typeof err === 'object' && err !== null && 'status' in err && err.status === 413 ? 413 : 400
      res.status(status).json({
        error: { code: 'invalid_json', message: 'Request body must be valid JSON within 1 MB.' },
      })
    },
  )
  return {
    async start() {
      const listen = (server: ReturnType<typeof createServer>, port: number) =>
        new Promise<void>((done, reject) => {
          const onError = (err: Error) => reject(err)
          server.once('error', onError)
          server.listen(port, options.host, () => {
            server.off('error', onError)
            done()
          })
        })
      wsServer = Bun.serve<SocketData>({
        hostname: options.host,
        port: options.wsPort,
        fetch(req, server) {
          expirePolling()
          const origin = req.headers.get('Origin')
          if (origin && origin !== 'https://chatgpt.com' && origin !== 'https://chat.openai.com')
            return new Response('Origin not allowed', { status: 403 })
          if (
            options.bridgeToken &&
            new URL(req.url).searchParams.get('token') !== options.bridgeToken
          )
            return new Response('Pairing token required', { status: 401 })
          const id = new URL(req.url).searchParams.get('browserId') ?? 'legacy-ws'
          if (!id || id.length > 100) return new Response('Invalid browser ID', { status: 400 })
          if (!lanes.has(id) && lanes.size >= 32)
            return new Response('Browser limit', { status: 429 })
          const lane = laneFor(id)
          if (connected(lane))
            return new Response('A browser is already connected', { status: 409 })
          if (server.upgrade(req, { data: { client: null, lane } })) return
          return new Response('WebSocket upgrade required', { status: 400 })
        },
        websocket: {
          open(socket) {
            const lane = socket.data.lane
            const client: BrowserSocket = {
              get readyState() {
                return socket.readyState
              },
              send(text, callback) {
                try {
                  socket.send(text)
                  callback?.()
                } catch (err) {
                  callback?.(err instanceof Error ? err : new Error('WebSocket send failed'))
                }
              },
            }
            socket.data.client = client
            lane.browser = client
            if (lane.queued) {
              const request = lane.queued
              lane.queued = null
              client.send(JSON.stringify(request))
            }
          },
          message(socket, data) {
            const lane = socket.data.lane
            if (socket.data.client === lane.browser) receiveBrowserMessage(data, lane)
          },
          close(socket) {
            const lane = socket.data.lane
            if (socket.data.client === lane.browser) {
              lane.browser = null
              if (!lane.pending?.navigating)
                lane.pending?.fail(503, 'browser_disconnected', 'ChatGPT browser disconnected.')
            }
          },
        },
      })
      try {
        await listen(http, options.httpPort)
      } catch (err) {
        await wsServer.stop(true)
        throw err
      }
      const address = http.address()
      if (!address || typeof address === 'string') throw new Error('No TCP address')
      return { httpPort: address.port, wsPort: wsServer.port }
    },
    async close() {
      sessions.close()
      clearInterval(leaseTimer)
      for (const lane of lanes.values())
        lane.pending?.fail(503, 'server_shutdown', 'Server is shutting down.')
      await wsServer?.stop(true)
      await new Promise<void>((done) => {
        http.close(() => done())
        http.closeAllConnections()
      })
    },
  }
}
function formatMessages(messages: { role: string; content: string }[]) {
  if (messages.length === 1 && messages[0]?.role === 'user') return messages[0].content
  return messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n')
}
if (require.main === module) {
  const service = createService({
    localMcp: readLocalMcpConfig(),
    sessionsFile: process.env.SESSIONS_FILE || resolve('.localgpt-sessions.sqlite'),
    host: process.env.HOST || '127.0.0.1',
    httpPort: Number(process.env.HTTP_PORT || 8766),
    wsPort: Number(process.env.WS_PORT || 8875),
    timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 180000),
    bridgeToken: readFileSync(
      process.env.BRIDGE_TOKEN_FILE || resolve('.bridge-token'),
      'utf8',
    ).trim(),
  })
  service
    .start()
    .then((ports) =>
      console.log(
        `LocalGPT: http://localhost:${ports.httpPort} | Browser WebSocket: ${ports.wsPort}`,
      ),
    )
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exitCode = 1
    })
  const stop = () => {
    void service.close().then(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
