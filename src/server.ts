import { createResponseJobStore, ResponseJobStorageError, type ResponseJob } from './response-jobs'
import { DEFAULT_GENERATION_TIMEOUT_MS } from './timeouts'
import { createImageStore } from './generated-images'
import { MAX_GENERATED_IMAGES, type GeneratedImage } from './generated-image-protocol'
import { attachLocalMcpTools, readLocalMcpConfig, type LocalMcpConfig } from './localmcp'
import { filePrompt, loadFiles } from './attachments'
import { createSessionStore, CreateSessionSchema, DeleteSessionSchema } from './sessions'
import { DotActionSchema } from './dots'
import express from 'express'
import { createMcpServer } from './mcp'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ResponsesRequestSchema, toChatRequest, createResponsesWriter } from './responses'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
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
  nativeProtocol?: boolean
}
interface BrowserLane {
  id: string
  browser: BrowserSocket | null
  pending: Pending | null
  polling: { id: string; seenAt: number } | null
  queued: BrowserRequest | null
  nativeReady: boolean
  nativeAdvertised: boolean
  readinessRequestId?: string
  readinessRetryAt?: number
  readinessRetryTimer?: ReturnType<typeof setTimeout>
  nativeQueue: BrowserRequest[]
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
  nativeReadinessTimeoutMs?: number
  updateLeaseMs?: number
  responseJobsDir?: string
  sessionsFile?: string
  imagesDir?: string
  imagesHostDir?: string
  imageFetcher?: typeof fetch
  localMcp?: LocalMcpConfig
}
interface GenerationSink {
  status(code: number): GenerationSink
  json(value: unknown): unknown
  setHeader(name: string, value: string): unknown
  flushHeaders(): void
  write(chunk: string): unknown
  end(): unknown
  on(event: 'close', listener: () => void): unknown
  answer?(text: string): void
  admitted?(context: {
    requestId: string
    browserId: string
    sessionId?: string
    conversationId?: string
  }): void
  progress?(phase: 'processing' | 'thinking' | 'answering' | 'unresponsive'): void
  backgroundJob?: boolean
  jobId?: string
}
interface Pending {
  requestId: string
  sessionId?: string
  navigating?: boolean
  background?: boolean
  suspend?: () => void
  event: (event: BrowserEvent) => void | Promise<void>
  fail: (status: number, code: string, message: string) => void
}
export function createService(options: Options) {
  const jobs = createResponseJobStore({ dir: options.responseJobsDir })
  const restoredUnknown = jobs
    .list()
    .some((job) => job.status === 'in_progress' && job.context?.mode !== 'native')
  const sessions = createSessionStore(options.sessionsFile)
  const imagesStore = createImageStore(
    options.imagesDir ?? resolve('.localgpt-images'),
    options.imagesHostDir,
    options.imageFetcher,
  )
  const app = express()
  const http = createServer(app)
  let wsServer: Server<SocketData> | null = null
  const lanes = new Map<string, BrowserLane>()
  const handledRequests = new Map<string, Set<string>>()
  type NativeContext = NonNullable<ResponseJob['context']>
  interface NativeGeneration {
    jobId: string
    context: NativeContext
    event?: (event: BrowserEvent) => Promise<boolean>
    detached?: () => void
    chain: Promise<unknown>
    durableIntent?: boolean
    durableIdentity?: boolean
    localRefusal?: (code: string, message: string) => void
  }
  const nativeGenerations = new Map<string, NativeGeneration>()
  const nativeSessionOwners = new Map<string, string>()
  const nativeConversationOwners = new Map<string, string>()
  const receiptKey = (event: BrowserEvent) => {
    // eventId identifies one transport ACK attempt, not the durable receipt.
    const { eventId: _eventId, ...receipt } = event
    return createHash('sha256').update(JSON.stringify(receipt)).digest('hex')
  }
  for (const job of jobs.list()) {
    const context = job.context
    if (context?.mode !== 'native' || !context.nativeUserMessageId) continue
    if (job.status === 'in_progress') {
      nativeGenerations.set(context.requestId, {
        jobId: job.id,
        context,
        chain: Promise.resolve(),
        durableIntent:
          context.lifecycle === 'possible_dispatch' || context.lifecycle === 'identified',
        durableIdentity:
          context.lifecycle === 'identified' && Boolean(context.serverConversationId),
      })
      if (context.sessionId) nativeSessionOwners.set(context.sessionId, context.requestId)
      const cid = context.serverConversationId ?? context.conversationId
      if (cid) nativeConversationOwners.set(cid, context.requestId)
    } else if (context.receipts?.length) {
      handledRequests.set(context.browserId + '/' + context.requestId, new Set(context.receipts))
    }
  }
  const dotOwners = new Map<string, string>()
  let sharedBrowserId: string | null =
    nativeGenerations.values().next().value?.context.browserId ?? null
  let updateLease: { browserId: string; expiresAt: number; known: Set<string> } | null = null
  const browserUpdating = () => {
    if (updateLease && updateLease.expiresAt <= Date.now()) updateLease = null
    return updateLease !== null
  }
  const laneFor = (id: string) => {
    let lane = lanes.get(id)
    if (!lane) {
      lane = {
        id,
        browser: null,
        pending: null,
        polling: null,
        queued: null,
        nativeReady: false,
        nativeAdvertised: false,
        nativeQueue: [],
      }
      lanes.set(id, lane)
    }
    return lane
  }
  // ChatGPT tabs share account UI state; permit one browser operation service-wide.
  const browserBusy = () =>
    browserUpdating() ||
    restoredUnknown ||
    nativeGenerations.size > 0 ||
    [...lanes.values()].some((lane) => lane.pending !== null || lane.queued !== null)
  const busyMessage =
    'LocalGPT is processing another browser operation. Wait for it to finish before retrying.'
  const availableLane = () => {
    const shared = sharedBrowserId ? laneFor(sharedBrowserId) : undefined
    // Keep a connected or in-flight shared lane. Native records alone never pin new requests;
    // they keep their own browserId, so old receipts still route to the original owner.
    if (shared && (connected(shared) || shared.pending || shared.queued)) return shared
    const candidates = [...lanes.values()].filter((lane) => connected(lane))
    const replacement = candidates.find((lane) => lane.nativeReady) ?? candidates[0]
    sharedBrowserId = replacement?.id ?? null
    return replacement ?? laneFor('disconnected')
  }
  app.use('/bridge/event', express.json({ limit: '12mb' }))
  app.use(express.json({ limit: '1mb' }))
  const wsConnected = (lane: BrowserLane) => lane.browser?.readyState === 1
  const pollingLeaseMs = options.pollingLeaseMs ?? 5000
  const clearReadinessProbe = (lane: BrowserLane) => {
    clearTimeout(lane.readinessRetryTimer)
    lane.readinessRetryTimer = undefined
    lane.readinessRequestId = undefined
    lane.readinessRetryAt = 0
  }
  const beginReadinessProbe = (lane: BrowserLane): BrowserRequest => {
    clearReadinessProbe(lane)
    const requestId = randomUUID()
    lane.readinessRequestId = requestId
    lane.readinessRetryTimer = setTimeout(() => {
      if (lane.readinessRequestId !== requestId || lane.nativeReady) return
      clearReadinessProbe(lane)
      if (wsConnected(lane)) lane.browser!.send(JSON.stringify(beginReadinessProbe(lane)))
    }, options.nativeReadinessTimeoutMs ?? 15000)
    lane.readinessRetryTimer.unref()
    return { type: 'native_readiness', requestId }
  }
  const pollingConnected = (lane: BrowserLane) =>
    lane.polling !== null &&
    Date.now() - lane.polling.seenAt < (lane.pending?.navigating ? 20000 : pollingLeaseMs)
  const expireLane = (lane: BrowserLane) => {
    if (lane.polling && !pollingConnected(lane)) {
      lane.polling = null
      lane.nativeReady = false
      clearReadinessProbe(lane)
      for (const request of [...lane.nativeQueue]) {
        const record = nativeGenerations.get(request.requestId)
        if (!record || record.context.lifecycle !== 'pre_dispatch' || record.durableIntent) continue
        const error = {
          code: 'native_dispatch_undelivered',
          message:
            'The polling connection expired before this request was delivered; the native SDK was not invoked.',
        }
        const context = { ...record.context, lifecycle: 'terminal' as const }
        try {
          jobs.terminalChecked(record.jobId, context, { error })
        } catch {
          jobs.progress(record.jobId, 'unresponsive')
          continue
        }
        record.context = context
        record.localRefusal?.(error.code, error.message)
        releaseNative(record)
      }
      for (const record of nativeGenerations.values())
        if (record.context.browserId === lane.id) jobs.progress(record.jobId, 'unresponsive')
      const undelivered = lane.pending && lane.queued?.requestId === lane.pending.requestId
      lane.queued = null
      if (undelivered)
        lane.pending?.fail(
          503,
          'browser_undelivered',
          'ChatGPT HTTP browser connection expired before the request was delivered.',
        )
      else if (lane.pending?.background) lane.pending.suspend?.()
      else
        lane.pending?.fail(503, 'browser_disconnected', 'ChatGPT HTTP browser connection expired.')
    }
  }
  const expirePolling = () => {
    for (const lane of lanes.values()) {
      expireLane(lane)
      if (
        !connected(lane) &&
        !lane.pending &&
        ![...nativeGenerations.values()].some((record) => record.context.browserId === lane.id)
      )
        lanes.delete(lane.id)
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
  app.use('/v1', (req, res, next) => {
    const operatesBrowser =
      (req.method === 'POST' && req.path !== '/sessions') ||
      (req.method === 'GET' && ['/models', '/capabilities'].includes(req.path))
    if (operatesBrowser && browserUpdating()) {
      res.status(409).json({
        error: {
          code: 'browser_updating',
          message: 'The browser extension is updating; retry after it reconnects.',
        },
      })
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
      enableJsonResponse: false,
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
    const shared = availableLane()
    res.json({
      status: 'ok',
      browserConnected: active.length > 0,
      transport: wsConnected(shared) ? 'websocket' : pollingConnected(shared) ? 'http' : null,
      busy: browserBusy(),
      nativeReady: shared.nativeReady,
      activeGenerations: nativeGenerations.size,
      canStartIndependentGeneration: shared.nativeReady && !nativeBlocked() && connected(shared),
      updating: browserUpdating(),
      browsers: active.length,
      sharedBrowserId: connected(shared) || shared.pending ? shared.id : null,
      availableBrowsers: active.length > 0 && !browserBusy() ? 1 : 0,
      wsPort: options.wsPort,
    })
  })
  app.post('/v1/sessions/project', (req, res) => {
    const parsed = DeleteSessionSchema.safeParse(req.body as unknown)
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'invalid_session' } })
      return
    }
    const session = sessions.get(parsed.data.session_id)
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found' } })
      return
    }
    if (!session.projectName) {
      res.status(400).json({ error: { code: 'project_target_disabled' } })
      return
    }
    if (!session.conversationId) {
      res.json(session)
      return
    }
    expirePolling()
    if (browserBusy()) {
      res.status(409).json({ error: { code: 'browser_busy', message: busyMessage } })
      return
    }
    const lane = availableLane()
    if (!connected(lane)) {
      res.status(503).json({ error: { code: 'browser_disconnected' } })
      return
    }
    const requestId = randomUUID()
    const payload: BrowserRequest = {
      type: 'move_conversation',
      requestId,
      conversationId: session.conversationId,
      projectName: session.projectName,
      ...(session.projectId ? { projectId: session.projectId } : {}),
    }
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
      res.status(status).json({ error: { code, message } })
    }
    const timer = setTimeout(
      () =>
        fail(
          504,
          'browser_timeout',
          'Project movement may already have happened. Do not automatically retry.',
        ),
      Math.min(options.timeoutMs, 30000),
    )
    lane.pending = {
      requestId,
      sessionId: session.id,
      fail,
      event(event) {
        if (finished || event.type === 'heartbeat') return
        if (event.type === 'error') {
          fail(502, event.code, event.message)
          return
        }
        if (event.type === 'navigate' && event.conversationId === session.conversationId) {
          if (lane.pending) lane.pending.navigating = true
          lane.queued = payload
          if (wsConnected(lane))
            lane.browser!.send(JSON.stringify({ type: 'navigation_ready', requestId }))
          return
        }
        if (
          event.type !== 'conversation_project' ||
          event.conversationId !== session.conversationId
        ) {
          fail(
            502,
            'invalid_browser_message',
            'Expected project confirmation for the bound conversation.',
          )
          return
        }
        const updated = sessions.setProject(session.id, session.projectName, event.projectId)
        cleanup()
        res.setHeader('Cache-Control', 'no-store')
        res.json(updated)
      },
    }
    res.on('close', () => {
      if (!finished) cleanup()
    })
    if (wsConnected(lane))
      lane.browser!.send(JSON.stringify(payload), (err) => {
        if (err) fail(503, 'browser_disconnected', 'Unable to send to browser.')
      })
    else lane.queued = payload
  })
  app.post('/v1/sessions/delete', (req, res) => {
    const parsed = DeleteSessionSchema.safeParse(req.body as unknown)
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'invalid_session' } })
      return
    }
    const session = sessions.get(parsed.data.session_id)
    if (!session) {
      res.status(404).json({ error: { code: 'session_not_found' } })
      return
    }
    expirePolling()
    if (
      nativeSessionOwners.has(session.id) ||
      [...lanes.values()].some((lane) => lane.pending?.sessionId === session.id)
    ) {
      res.status(409).json({ error: { code: 'browser_busy', message: busyMessage } })
      return
    }
    const deleted = (conversationDeleted: boolean) => {
      sessions.delete(session.id)
      res.setHeader('Cache-Control', 'no-store')
      res.json({ session_id: session.id, deleted: true, conversationDeleted })
    }
    if (!session.conversationId) {
      deleted(false)
      return
    }
    const lane = availableLane()
    if (browserBusy()) {
      res.status(409).json({ error: { code: 'browser_busy', message: busyMessage } })
      return
    }
    if (!connected(lane)) {
      res.status(503).json({ error: { code: 'browser_disconnected' } })
      return
    }
    const requestId = randomUUID()
    const payload: BrowserRequest = {
      type: 'delete_conversation',
      requestId,
      conversationId: session.conversationId,
      ...(session.projectId ? { projectId: session.projectId } : {}),
    }
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
      res.status(status).json({ error: { code, message } })
    }
    const timer = setTimeout(
      () =>
        fail(
          504,
          'browser_timeout',
          'Deletion may already have happened. Inspect the browser before retrying.',
        ),
      Math.min(options.timeoutMs, 30000),
    )
    lane.pending = {
      requestId,
      sessionId: session.id,
      fail,
      event(event) {
        if (finished || event.type === 'heartbeat') return
        if (event.type === 'error') {
          fail(502, event.code, event.message)
          return
        }
        if (event.type === 'navigate' && event.conversationId === session.conversationId) {
          if (lane.pending) lane.pending.navigating = true
          lane.queued = payload
          if (wsConnected(lane))
            lane.browser!.send(JSON.stringify({ type: 'navigation_ready', requestId }))
          return
        }
        if (
          event.type !== 'conversation_deleted' ||
          event.conversationId !== session.conversationId
        ) {
          fail(
            502,
            'invalid_browser_message',
            'Expected deletion confirmation for the bound conversation.',
          )
          return
        }
        cleanup()
        deleted(true)
      },
    }
    res.on('close', () => {
      if (!finished) cleanup()
    })
    if (wsConnected(lane))
      lane.browser!.send(JSON.stringify(payload), (err) => {
        if (err) fail(503, 'browser_disconnected', 'Unable to send to browser.')
      })
    else lane.queued = payload
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
  app.post('/bridge/update-ready', (req, res) => {
    const body = req.body as unknown
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('version' in body) ||
      typeof body.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(body.version)
    ) {
      res.status(400).json({ error: { code: 'invalid_update' } })
      return
    }
    const lane = res.locals.lane as BrowserLane
    if (browserUpdating() && updateLease!.browserId !== lane.id) {
      res.json({ ready: false, reason: 'browser_updating' })
      return
    }
    if (
      restoredUnknown ||
      nativeGenerations.size > 0 ||
      [...lanes.values()].some((l) => l.pending !== null || l.queued !== null)
    ) {
      res.json({ ready: false, reason: 'browser_busy' })
      return
    }
    updateLease = {
      browserId: lane.id,
      expiresAt: Date.now() + (options.updateLeaseMs ?? 15000),
      known: new Set(lanes.keys()),
    }
    res.json({ ready: true })
  })
  app.post('/bridge/poll', (req, res) => {
    const lane = res.locals.lane as BrowserLane
    if (
      browserUpdating() &&
      (updateLease!.browserId === lane.id || !updateLease!.known.has(lane.id))
    )
      updateLease = null
    if (
      req.body?.nativeProtocol === 1 &&
      !lane.nativeReady &&
      !lane.readinessRequestId &&
      Date.now() >= (lane.readinessRetryAt ?? 0)
    ) {
      lane.nativeAdvertised = true
      res.json({ request: beginReadinessProbe(lane) })
      return
    }
    const request = lane.queued ?? lane.nativeQueue.shift() ?? null
    lane.queued = null
    res.json({ request })
  })
  app.post('/bridge/event', async (req, res) => {
    const lane = res.locals.lane as BrowserLane
    const parsed = BrowserEventSchema.safeParse(req.body as unknown)
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'invalid_browser_message' } })
      return
    }
    const event = parsed.data
    res.json({ ok: true, accepted: await handleBrowserEvent(event, lane) })
  })
  const extensionVersion = (
    JSON.parse(readFileSync(resolve('extension/manifest.json'), 'utf8')) as { version: string }
  ).version
  if (!/^\d+\.\d+\.\d+$/.test(extensionVersion)) throw new Error('Invalid extension version')
  app.get('/v1/images/:id', (req, res) => {
    const image = imagesStore.read(req.params.id)
    if (!image) {
      res.status(404).json({ error: { code: 'image_not_found' } })
      return
    }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    res.type(image.metadata.mimeType).sendFile(image.file)
  })
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
  const remember = (lane: BrowserLane, event: Exclude<BrowserEvent, { type: 'heartbeat' }>) => {
    const key = lane.id + '/' + event.requestId
    const receipts = handledRequests.get(key) ?? new Set<string>()
    receipts.add(receiptKey(event))
    if (receipts.size > 1000) receipts.delete(receipts.values().next().value!)
    handledRequests.set(key, receipts)
    if (handledRequests.size > 1000) handledRequests.delete(handledRequests.keys().next().value!)
  }
  const handleBrowserEvent = async (event: BrowserEvent, lane: BrowserLane): Promise<boolean> => {
    if (event.type === 'heartbeat') return false
    if (event.type === 'native_ready') {
      if (event.requestId !== lane.readinessRequestId || !connected(lane)) return false
      lane.nativeReady = event.ready
      lane.nativeAdvertised = true
      clearTimeout(lane.readinessRetryTimer)
      if (!event.ready) {
        clearReadinessProbe(lane)
        lane.readinessRetryAt = Date.now() + 1000
        if (wsConnected(lane))
          lane.readinessRetryTimer = setTimeout(() => {
            if (!wsConnected(lane) || lane.nativeReady || lane.readinessRequestId) return
            lane.browser!.send(JSON.stringify(beginReadinessProbe(lane)))
          }, 1000)
        lane.readinessRetryTimer?.unref()
      }
      return true
    }
    const record = nativeGenerations.get(event.requestId)
    if (record) {
      if (
        record.context.browserId !== lane.id ||
        event.nativeUserMessageId !== record.context.nativeUserMessageId
      )
        return false
      const handling = record.chain.then(() =>
        record.event ? record.event(event) : reconcileNative(record, event),
      )
      record.chain = handling.catch(() => {})
      try {
        return await handling
      } catch {
        jobs.progress(record.jobId, 'unresponsive')
        return false
      }
    }
    if (event.requestId === lane.pending?.requestId) {
      await lane.pending.event(event)
      remember(lane, event)
      return true
    }
    return handledRequests.get(lane.id + '/' + event.requestId)?.has(receiptKey(event)) ?? false
  }
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
    const event = parsed.data
    const handling = handleBrowserEvent(event, lane)
    if (event.type !== 'heartbeat' && event.eventId)
      void handling
        .then((accepted) =>
          lane.browser?.send(
            JSON.stringify({
              type: 'event_ack',
              requestId: event.requestId,
              eventId: event.eventId,
              accepted,
            }),
          ),
        )
        .catch(() => lane.pending?.suspend?.())
  }
  app.get('/v1/models', (_req, res) => {
    const lane = availableLane()
    expirePolling()
    const error = (status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } })
    if (lane.nativeReady ? nativeBlocked() : browserBusy()) {
      error(409, 'browser_busy', busyMessage)
      return
    }
    if (!connected(lane)) {
      error(503, 'browser_disconnected', 'Open ChatGPT with LocalGPT enabled.')
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
    if (lane.nativeReady ? nativeBlocked() : browserBusy()) {
      error(409, 'browser_busy', busyMessage)
      return
    }
    if (!connected(lane)) {
      error(503, 'browser_disconnected', 'Open ChatGPT with LocalGPT enabled.')
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
      operation.data.action === 'list' ? undefined : dotOwners.get(operation.data.dotId)
    const lane = availableLane()
    const error = (status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message } })
    if (browserBusy()) {
      error(409, 'browser_busy', busyMessage)
      return
    }
    if (!connected(lane)) {
      error(503, 'browser_disconnected', 'Open ChatGPT with LocalGPT enabled.')
      return
    }
    if (operation.data.action !== 'list' && ownerId && ownerId !== lane.id) {
      error(
        409,
        'dot_browser_changed',
        'The shared ChatGPT tab changed. List and select the dot again before continuing.',
      )
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
        if (event.result.action === 'list') {
          for (const dot of event.result.dots) dotOwners.set(dot.id, lane.id)
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
  const nativeBlocked = () =>
    browserUpdating() ||
    restoredUnknown ||
    [...lanes.values()].some((lane) => lane.pending !== null || lane.queued !== null)
  const releaseNative = (record: NativeGeneration) => {
    const context = record.context
    nativeGenerations.delete(context.requestId)
    if (context.sessionId && nativeSessionOwners.get(context.sessionId) === context.requestId)
      nativeSessionOwners.delete(context.sessionId)
    for (const [cid, owner] of nativeConversationOwners)
      if (owner === context.requestId) nativeConversationOwners.delete(cid)
    const lane = lanes.get(context.browserId)
    if (lane)
      lane.nativeQueue = lane.nativeQueue.filter(
        (request) => request.requestId !== context.requestId,
      )
    if (context.receipts?.length)
      handledRequests.set(context.browserId + '/' + context.requestId, new Set(context.receipts))
    if (handledRequests.size > 1000) handledRequests.delete(handledRequests.keys().next().value!)
  }
  const checkedReceipt = (record: NativeGeneration, event: BrowserEvent) => {
    const receipt = receiptKey(event)
    const receipts = record.context.receipts ?? []
    record.context.receipts = [...new Set([...receipts, receipt])].slice(-1000)
    jobs.contextChecked(record.jobId, record.context)
  }
  const adoptNativeIdentity = (
    record: NativeGeneration,
    conversationId?: string,
    clientThreadId?: string,
  ) => {
    if (
      clientThreadId &&
      record.context.clientThreadId &&
      record.context.clientThreadId !== clientThreadId
    )
      throw new Error('Native client identity changed')
    if (conversationId) {
      const previous = record.context.serverConversationId ?? record.context.conversationId
      if (previous && previous !== conversationId)
        throw new Error('Native conversation identity changed')
      const owner = nativeConversationOwners.get(conversationId)
      if (owner && owner !== record.context.requestId)
        throw new Error('Native conversation is reserved')
      // Reserve before writing or binding: even a failed receipt write cannot permit a competitor.
      nativeConversationOwners.set(conversationId, record.context.requestId)
      record.context.serverConversationId = conversationId
      record.context.conversationId = conversationId
      record.context.lifecycle = 'identified'
    }
    if (clientThreadId) record.context.clientThreadId = clientThreadId
  }
  const bindNativeSession = (record: NativeGeneration, projectId?: string) => {
    const context = record.context
    if (!context.sessionId) return
    const session = sessions.get(context.sessionId)
    if (!session || !context.serverConversationId)
      throw new Error('Native session identity is unavailable')
    if (session.projectName && !projectId)
      throw new Error('Native project membership is unconfirmed')
    if (session.projectId && projectId !== session.projectId)
      throw new Error('Native project changed')
    if (session.projectName && projectId)
      sessions.setProject(session.id, session.projectName, projectId)
    sessions.bind(session.id, context.serverConversationId, context.model, context.effort)
  }
  const saveNativeImage = async (
    record: NativeGeneration,
    event: Extract<BrowserEvent, { type: 'image' }>,
  ) => {
    if (
      !record.durableIdentity ||
      !record.context.serverConversationId ||
      record.context.serverConversationId !== event.conversationId
    )
      return false
    let images = record.context.images ?? []
    const existing = images.find((image) => image.fileId === event.fileId)
    if (existing && imagesStore.read(existing.id)) {
      checkedReceipt(record, event)
      return true
    }
    if (existing) {
      images = images.filter((image) => image.id !== existing.id)
      record.context.images = images
    }
    const pending = record.context.pendingImageIds ?? []
    if (!pending.includes(event.fileId) && images.length + pending.length >= MAX_GENERATED_IMAGES)
      return false
    record.context.pendingImageIds = [...new Set([...pending, event.fileId])]
    jobs.contextChecked(record.jobId, record.context)
    const image = event.imageData
      ? await imagesStore.saveData(event.fileId, event.imageData)
      : await imagesStore.save(event.fileId, event.downloadUrl!)
    record.context.images = [...images, image]
    record.context.pendingImageIds = (record.context.pendingImageIds ?? []).filter(
      (id) => id !== event.fileId,
    )
    checkedReceipt(record, event)
    return true
  }
  const nativeImagesAvailable = (record: NativeGeneration) => {
    const missing = (record.context.images ?? []).filter((image) => !imagesStore.read(image.id))
    if (!missing.length) return true
    record.context.pendingImageIds = [
      ...new Set([
        ...(record.context.pendingImageIds ?? []),
        ...missing.map((image) => image.fileId),
      ]),
    ]
    jobs.contextChecked(record.jobId, record.context)
    return false
  }
  // Restarted native work is recovered only from the owning browser's exact UUID-bound events.
  const reconcileNative = async (
    record: NativeGeneration,
    event: BrowserEvent,
  ): Promise<boolean> => {
    if (jobs.get(record.jobId)?.status !== 'in_progress')
      return record.context.receipts?.includes(receiptKey(event)) ?? false
    if (event.type === 'native_intent') {
      if (record.context.lifecycle === 'pre_dispatch')
        record.context.lifecycle = 'possible_dispatch'
      checkedReceipt(record, event)
      record.durableIntent = true
      return true
    }
    if (event.type === 'native_dispatch_refused') {
      if (
        !record.durableIntent ||
        record.durableIdentity ||
        record.context.lifecycle !== 'possible_dispatch' ||
        record.context.clientThreadId
      )
        return false
      checkedReceipt(record, event)
      const context = { ...record.context, lifecycle: 'terminal' as const }
      jobs.terminalChecked(record.jobId, context, {
        error: { code: event.code, message: event.message },
      })
      record.context = context
      releaseNative(record)
      return true
    }
    if (event.type === 'native_identity') {
      if (!record.durableIntent) return false
      adoptNativeIdentity(record, event.conversationId, event.clientThreadId)
      checkedReceipt(record, event)
      if (event.conversationId) record.durableIdentity = true
      if (record.context.sessionId && event.conversationId)
        sessions.bind(
          record.context.sessionId,
          event.conversationId,
          record.context.model,
          record.context.effort,
        )
      return true
    }
    if (event.type === 'image') return saveNativeImage(record, event)
    if (event.type === 'answer') {
      if (!record.durableIdentity) return false
      jobs.answer(record.jobId, event.text)
      checkedReceipt(record, event)
      return true
    }
    if (event.type === 'progress') {
      jobs.progress(record.jobId, event.phase)
      checkedReceipt(record, event)
      return true
    }
    if (event.type === 'error' && !event.terminalEvidence && !event.preDispatch) {
      jobs.progress(record.jobId, 'unresponsive')
      checkedReceipt(record, event)
      return true
    }
    if (event.type === 'stop' && event.terminalEvidence && event.conversationId) {
      if (!record.durableIdentity || event.conversationId !== record.context.serverConversationId)
        return false
      if (record.context.pendingImageIds?.length || !nativeImagesAvailable(record)) return false
      adoptNativeIdentity(record, event.conversationId)
      checkedReceipt(record, event)
      bindNativeSession(record, event.projectId)
      const writer = createResponsesWriter(() => {}, record.context.requestId, {
        input: 'Recovered native response',
        stream: false,
        store: false,
        newChat: true,
        ...(record.context.model ? { model: record.context.model } : {}),
        ...(record.context.sessionId ? { session_id: record.context.sessionId } : {}),
      })
      const context = { ...record.context, lifecycle: 'terminal' as const }
      jobs.terminalChecked(record.jobId, context, {
        result: writer.response(
          jobs.text(record.jobId),
          'completed',
          null,
          record.context.images ?? [],
        ),
      })
      record.context = context
      releaseNative(record)
      return true
    }
    if (
      event.type === 'error' &&
      ((event.terminalEvidence && record.durableIntent) ||
        (event.preDispatch && record.context.lifecycle === 'pre_dispatch'))
    ) {
      checkedReceipt(record, event)
      const context = { ...record.context, lifecycle: 'terminal' as const }
      jobs.terminalChecked(record.jobId, context, {
        error: { code: event.code, message: event.message },
      })
      record.context = context
      releaseNative(record)
      return true
    }
    return false
  }
  const generateNative = (
    lane: BrowserLane,
    body: ReturnType<typeof ChatRequestSchema.parse>,
    responsesBody: ReturnType<typeof ResponsesRequestSchema.parse> | null,
    res: GenerationSink,
  ) => {
    const reject = (status: number, code: string, message: string) =>
      res.status(status).json({ error: { code, message, type: 'browser_api_error' } })
    if (nativeBlocked()) {
      reject(409, 'browser_busy', busyMessage)
      return
    }
    if (!lane.nativeReady) {
      reject(
        503,
        'native_unavailable',
        'Native ChatGPT dispatch is not ready; no request was sent.',
      )
      return
    }
    if (!connected(lane)) {
      reject(503, 'browser_disconnected', 'The owning ChatGPT browser is disconnected.')
      return
    }
    const session = body.session_id ? sessions.get(body.session_id) : null
    if (body.session_id && !session) {
      reject(404, 'session_not_found', 'Unknown LocalGPT session ID.')
      return
    }
    if (!session && !body.newChat) {
      reject(
        400,
        'native_target_required',
        'Native continuation requires a session with a validated conversation ID.',
      )
      return
    }
    const cid = session?.conversationId ?? undefined
    if (
      (body.session_id && nativeSessionOwners.has(body.session_id)) ||
      (cid && nativeConversationOwners.has(cid))
    ) {
      reject(409, 'browser_busy', 'This session or conversation already has an owned generation.')
      return
    }
    let files: ReturnType<typeof loadFiles>
    try {
      files = loadFiles(body.files)
    } catch (error) {
      reject(
        400,
        'invalid_attachment',
        error instanceof Error ? error.message : 'Unable to read attachment.',
      )
      return
    }
    if (!jobs.durable) {
      reject(
        503,
        'response_job_storage_unavailable',
        'Native generation requires durable response job storage; no request was sent.',
      )
      return
    }
    const requestId = randomUUID()
    const nativeUserMessageId = randomUUID()
    body = {
      ...body,
      model: body.model ?? session?.model ?? undefined,
      reasoning: body.reasoning ?? (session?.effort ? { effort: session.effort } : undefined),
      newChat: session ? !session.conversationId : body.newChat,
    }
    let jobId: string
    const context: NativeContext = {
      requestId,
      browserId: lane.id,
      mode: 'native',
      lifecycle: 'pre_dispatch',
      nativeUserMessageId,
      ...(body.session_id ? { sessionId: body.session_id } : {}),
      ...(cid ? { conversationId: cid, serverConversationId: cid } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.reasoning ? { effort: body.reasoning.effort } : {}),
      ...(session?.projectName ? { projectName: session.projectName } : {}),
      ...(session?.projectId ? { projectId: session.projectId } : {}),
      receipts: [],
    }
    try {
      jobId = res.jobId ?? jobs.create(context).id
      if (res.jobId) jobs.contextChecked(jobId, context)
    } catch {
      reject(
        503,
        'response_job_storage_unavailable',
        'Native dispatch intent could not be saved; no request was sent.',
      )
      return
    }
    const record: NativeGeneration = { jobId, context, chain: Promise.resolve() }
    nativeGenerations.set(requestId, record)
    if (body.session_id) nativeSessionOwners.set(body.session_id, requestId)
    if (cid) nativeConversationOwners.set(cid, requestId)
    res.admitted?.({
      requestId,
      browserId: lane.id,
      ...(body.session_id ? { sessionId: body.session_id } : {}),
      ...(cid ? { conversationId: cid } : {}),
    })
    res.setHeader('X-Response-Job-Id', jobId)
    let detached = false
    let finished = false
    let text = ''
    let streamingStarted = false
    const writer = responsesBody
      ? createResponsesWriter(
          (data) => {
            if (!detached) res.write(data)
          },
          requestId,
          { ...responsesBody, model: body.model, reasoning: body.reasoning },
        )
      : null
    const startStream = () => {
      if (streamingStarted || detached) return
      streamingStarted = true
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.flushHeaders()
      writer?.start()
    }
    const failConsumer = (status: number, code: string, message: string) => {
      if (detached || res.backgroundJob) return
      if (streamingStarted) {
        if (writer) writer.fail(text, code, message)
        else res.write(`data: ${JSON.stringify({ error: { code, message } })}\n\ndata: [DONE]\n\n`)
        res.end()
      } else reject(status, code, message)
      detached = true
    }
    const timer = res.backgroundJob
      ? undefined
      : setTimeout(() => {
          jobs.progress(jobId, 'unresponsive')
          failConsumer(
            504,
            'browser_timeout',
            'Native generation outcome is unknown. Poll the response job; do not resend.',
          )
        }, options.timeoutMs)
    record.detached = () => {
      detached = true
      clearTimeout(timer)
      jobs.progress(jobId, 'unresponsive')
    }
    record.localRefusal = (code, message) => {
      finished = true
      clearTimeout(timer)
      failConsumer(503, code, message)
    }
    res.on('close', () => {
      if (!finished) {
        detached = true
        clearTimeout(timer)
      }
    })
    record.event = async (event) => {
      if (finished) return record.context.receipts?.includes(receiptKey(event)) ?? false
      if (event.type === 'native_dispatch_refused') {
        const accepted = await reconcileNative(record, event)
        if (accepted) {
          finished = true
          clearTimeout(timer)
          failConsumer(502, event.code, event.message)
        }
        return accepted
      }
      if (
        event.type === 'native_intent' ||
        event.type === 'native_identity' ||
        event.type === 'progress'
      )
        return reconcileNative(record, event)
      if (event.type === 'answer') {
        if (!record.durableIdentity) return false
        jobs.answer(jobId, event.text)
        jobs.progress(jobId, 'answering')
        checkedReceipt(record, event)
        const previousText = text
        text = event.text
        if (body.stream && !detached) {
          if (!event.text.startsWith(previousText)) {
            failConsumer(
              502,
              'answer_rewritten',
              'The streamed answer changed; poll the response job.',
            )
            return true
          }
          startStream()
          const delta = event.text.slice(previousText.length)
          if (delta && writer) writer.delta(delta)
          else if (delta)
            res.write(
              `data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`,
            )
        }
        return true
      }
      if (event.type === 'image') return saveNativeImage(record, event)
      if (event.type === 'error') {
        const terminal =
          (event.terminalEvidence && record.durableIntent) ||
          (event.preDispatch && record.context.lifecycle === 'pre_dispatch')
        if (!terminal) {
          jobs.progress(jobId, 'unresponsive')
          checkedReceipt(record, event)
          failConsumer(502, event.code, event.message + ' Poll the response job; do not resend.')
          return true
        }
        checkedReceipt(record, event)
        const terminalContext = { ...record.context, lifecycle: 'terminal' as const }
        jobs.terminalChecked(jobId, terminalContext, {
          error: { code: event.code, message: event.message },
        })
        record.context = terminalContext
        finished = true
        clearTimeout(timer)
        releaseNative(record)
        failConsumer(502, event.code, event.message)
        return true
      }
      if (
        event.type !== 'stop' ||
        !event.terminalEvidence ||
        !event.conversationId ||
        !record.durableIdentity ||
        event.conversationId !== record.context.serverConversationId ||
        record.context.pendingImageIds?.length ||
        !nativeImagesAvailable(record)
      )
        return false
      adoptNativeIdentity(record, event.conversationId)
      checkedReceipt(record, event)
      bindNativeSession(record, event.projectId)
      const images = record.context.images ?? []
      const result = writer
        ? writer.response(text, 'completed', null, images)
        : {
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? 'browser-selected',
            session_id: body.session_id ?? null,
            images,
            choices: [
              { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
            ],
          }
      const terminalContext = { ...record.context, lifecycle: 'terminal' as const }
      jobs.terminalChecked(jobId, terminalContext, { result })
      record.context = terminalContext
      finished = true
      clearTimeout(timer)
      releaseNative(record)
      if (!detached && !res.backgroundJob) {
        if (body.stream) {
          startStream()
          if (writer) writer.complete(text, images)
          else
            res.write(
              `data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
            )
          res.end()
        } else res.json(result)
      }
      return true
    }
    const payload: BrowserRequest = {
      type: 'request',
      requestId,
      native: true,
      nativeUserMessageId,
      backgroundJob: true,
      timeoutMs: options.timeoutMs,
      text: [formatMessages(body.messages), filePrompt(files)].filter(Boolean).join('\n\n'),
      newChat: body.newChat,
      ...(files.some((file) => file.mode === 'upload')
        ? { files: files.filter((file) => file.mode === 'upload') }
        : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      ...(cid ? { conversationId: cid } : {}),
      ...(session?.projectName ? { projectName: session.projectName } : {}),
      ...(session?.projectId ? { projectId: session.projectId } : {}),
    }
    // The page must acknowledge native_intent before invoking the completion core.
    // This pre-dispatch record already reserves the identities; the intent ACK is the possible-send barrier.
    if (wsConnected(lane))
      lane.browser!.send(JSON.stringify(payload), (error) => {
        if (error) {
          jobs.progress(jobId, 'unresponsive')
          failConsumer(
            503,
            'browser_disconnected',
            'Native dispatch delivery is uncertain. Poll the job; do not resend.',
          )
        }
      })
    else lane.nativeQueue.push(payload)
  }
  const generate = (
    req: Pick<express.Request, 'body' | 'path'>,
    res: GenerationSink,
    forceResponses = false,
  ) => {
    expirePolling()
    const responsesMode = forceResponses || req.path === '/v1/responses'
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
    const lane = availableLane()
    if (lane.nativeAdvertised) {
      generateNative(lane, parsed.data, responsesParsed?.success ? responsesParsed.data : null, res)
      return
    }
    if (browserBusy()) {
      error(409, 'browser_busy', busyMessage)
      return
    }
    if (!connected(lane)) {
      error(503, 'browser_disconnected', 'Open ChatGPT with the built userscript enabled.')
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
    const imageDownloads: Promise<GeneratedImage | null>[] = []
    const imageIds = new Set<string>()
    const downloadAbort = new AbortController()
    let imageConversation: string | null = null
    let completing = false
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
      downloadAbort.abort()
      clearTimeout(timer)
      if (lane.pending?.requestId === requestId) lane.pending = null
      if (lane.queued?.requestId === requestId) lane.queued = null
    }
    const fail = (status: number, code: string, message: string) => {
      if (finished) return
      if (res.backgroundJob && ['browser_disconnected', 'invalid_browser_message'].includes(code)) {
        res.progress?.('unresponsive')
        return
      }
      console.error(
        JSON.stringify({
          event: 'generation_failed',
          requestId,
          code,
          status,
          receivedText: text.length > 0,
          receivedImages: imageIds.size,
        }),
      )
      cleanup()
      if (streamingStarted && responses) {
        responses.fail(text, code, message)
        res.end()
      } else if (streamingStarted) {
        res.write(`data: ${JSON.stringify({ error: { code, message } })}\n\ndata: [DONE]\n\n`)
        res.end()
      } else error(status, code, message)
    }
    const background = res.backgroundJob === true
    // Async jobs have no wall deadline: ChatGPT may still be working.
    const timer = background
      ? undefined
      : setTimeout(
          () =>
            fail(
              504,
              'browser_timeout',
              'The response deadline expired. ChatGPT may still be working; the outcome is unknown. Do not automatically resend.',
            ),
          options.timeoutMs,
        )
    lane.pending = {
      requestId,
      fail,
      background,
      suspend: () => {
        if (!finished) res.progress?.('unresponsive')
      },
      sessionId: body.session_id,
      async event(event) {
        if (finished || event.type === 'heartbeat') return
        if (event.type === 'error') {
          if (
            background &&
            (event.code.startsWith('observation_') ||
              [
                'browser_timeout',
                'browser_disconnected',
                'response_stream_incomplete',
                'unsupported_response_stream',
                'unsupported_response_content',
                'response_stream_too_large',
                'response_incomplete',
                'response_stream_unavailable',
                'stream_interrupted',
                'response_stream_interrupted',
                'response_stream_timeout',
              ].includes(event.code))
          ) {
            res.progress?.('unresponsive')
            return
          }
          fail(502, event.code, event.message)
          return
        }
        if (event.type === 'progress') {
          res.progress?.(event.phase)
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
        if (
          event.type === 'native_ready' ||
          event.type === 'native_intent' ||
          event.type === 'native_dispatch_refused' ||
          event.type === 'native_identity' ||
          event.type === 'models' ||
          event.type === 'capabilities' ||
          event.type === 'dots' ||
          event.type === 'conversation_deleted' ||
          event.type === 'conversation_project'
        ) {
          fail(502, 'invalid_browser_message', 'Unexpected model reply for a generation request.')
          return
        }
        if (event.type === 'image') {
          if (
            completing ||
            (session?.conversationId && session.conversationId !== event.conversationId) ||
            (imageConversation && imageConversation !== event.conversationId)
          ) {
            fail(502, 'image_mismatch', 'Unexpected image conversation or late image.')
            return
          }
          imageConversation = event.conversationId
          if (imageIds.has(event.fileId)) return
          if (imageIds.size >= MAX_GENERATED_IMAGES) {
            fail(502, 'too_many_generated_images', 'At most four generated images are supported.')
            return
          }
          imageIds.add(event.fileId)
          imageDownloads.push(
            (event.imageData
              ? imagesStore.saveData(event.fileId, event.imageData)
              : imagesStore.save(event.fileId, event.downloadUrl!, downloadAbort.signal)
            ).catch(() => {
              fail(
                502,
                'image_download_failed',
                'The generated image could not be downloaded and saved.',
              )
              return null
            }),
          )
          return
        }
        if (event.type === 'answer') {
          res.answer?.(event.text)
          res.progress?.('answering')
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
        if (completing) return
        completing = true
        if (imageConversation && imageConversation !== event.conversationId) {
          fail(502, 'image_mismatch', 'Image and response conversations differ.')
          return
        }
        const images = (await Promise.all(imageDownloads)).filter(
          (image): image is GeneratedImage => image !== null,
        )
        if (finished) return
        if (session) {
          if (!event.conversationId) {
            fail(
              502,
              'conversation_unbound',
              'ChatGPT conversation ID was not captured. Do not automatically resend.',
            )
            return
          }
          if (session.conversationId && session.conversationId !== event.conversationId) {
            fail(502, 'session_mismatch', 'Browser replied from a different conversation.')
            return
          }
          if (session.projectName && !event.projectId) {
            fail(
              502,
              'project_unconfirmed',
              'Project membership was not confirmed. Do not automatically resend.',
            )
            return
          }
          if (session.projectId && event.projectId !== session.projectId) {
            fail(502, 'project_mismatch', 'Browser replied from a different project.')
            return
          }
          try {
            if (session.projectName && event.projectId)
              sessions.setProject(session.id, session.projectName, event.projectId)
            sessions.bind(session.id, event.conversationId, body.model, body.reasoning?.effort)
          } catch {
            fail(502, 'session_mismatch', 'Browser replied from a different conversation.')
            return
          }
        }
        cleanup()
        if (body.stream) {
          startStream()
          if (responses) responses.complete(text, images)
          else
            res.write(
              `data: ${JSON.stringify({ id: requestId, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
            )
          res.end()
        } else if (responses) res.json(responses.response(text, 'completed', null, images))
        else
          res.json({
            id: requestId,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'browser-selected',
            session_id: body.session_id ?? null,
            images,
            choices: [
              { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
            ],
          })
      },
    }
    res.admitted?.({
      requestId,
      browserId: lane.id,
      ...(body.session_id ? { sessionId: body.session_id } : {}),
      ...(session?.conversationId ? { conversationId: session.conversationId } : {}),
    })
    res.on('close', () => {
      if (!finished) cleanup()
    })
    if (body.stream && responses) startStream()
    const payload: BrowserRequest = {
      type: 'request',
      requestId,
      timeoutMs: options.timeoutMs,
      ...(background ? { backgroundJob: true } : {}),
      ...(files.some((file) => file.mode === 'upload')
        ? { files: files.filter((file) => file.mode === 'upload') }
        : {}),
      text: [formatMessages(body.messages), filePrompt(files)].filter(Boolean).join('\n\n'),
      newChat: body.newChat,
      ...(body.model ? { model: body.model } : {}),
      ...(body.reasoning ? { reasoning: body.reasoning } : {}),
      ...(session?.conversationId ? { conversationId: session.conversationId } : {}),
      ...(session?.projectName ? { projectName: session.projectName } : {}),
      ...(session?.projectId ? { projectId: session.projectId } : {}),
    }
    if (wsConnected(lane))
      lane.browser!.send(JSON.stringify(payload), (err) => {
        if (err) fail(503, 'browser_disconnected', 'Unable to send to the browser.')
      })
    else lane.queued = payload
  }
  app.post(['/v1/chat/completions', '/v1/responses'], (req, res) => generate(req, res))
  app.post('/v1/response-jobs', (req, res) => {
    const parsed = ResponsesRequestSchema.safeParse(req.body as unknown)
    if (!parsed.success || parsed.data.stream) {
      res.status(400).json({
        error: {
          code: 'invalid_request',
          message: 'Response jobs require a valid non-streaming Responses request.',
        },
      })
      return
    }
    expirePolling()
    const generationLane = availableLane()
    if (generationLane.nativeAdvertised ? nativeBlocked() : browserBusy()) {
      res.status(409).json({ error: { code: 'browser_busy', message: busyMessage } })
      return
    }
    if (generationLane.nativeAdvertised) {
      const session = parsed.data.session_id ? sessions.get(parsed.data.session_id) : null
      if (
        (parsed.data.session_id && nativeSessionOwners.has(parsed.data.session_id)) ||
        (session?.conversationId && nativeConversationOwners.has(session.conversationId))
      ) {
        res.status(409).json({ error: { code: 'browser_busy', message: busyMessage } })
        return
      }
      if (!generationLane.nativeReady) {
        res.status(503).json({
          error: {
            code: 'native_unavailable',
            message: 'Native dispatch is not ready; no request was sent.',
          },
        })
        return
      }
    }
    let job: ReturnType<typeof jobs.create>
    try {
      job = jobs.create()
    } catch (error) {
      res.status(503).json({
        error: {
          code: error instanceof ResponseJobStorageError ? error.code : 'response_job_capacity',
          message:
            error instanceof ResponseJobStorageError
              ? error.message
              : 'Response job capacity reached; wait for completed results to expire.',
        },
      })
      return
    }
    let admitted = false
    let status = 200
    let rejected: unknown
    const sink: GenerationSink = {
      status(code) {
        status = code
        return sink
      },
      json(value) {
        if (!admitted) {
          rejected = value
          return
        }
        if (status >= 400) {
          const failure = value as { error: { code: string; message?: string } }
          jobs.fail(
            job.id,
            failure.error.code,
            failure.error.message ?? 'Response retrieval failed.',
          )
        } else jobs.complete(job.id, value as Record<string, unknown>)
      },
      setHeader() {},
      flushHeaders() {},
      write() {},
      end() {},
      on() {},
      admitted(context) {
        admitted = true
        if (jobs.get(job.id)?.context?.mode !== 'native') jobs.context(job.id, context)
      },
      jobId: job.id,
      backgroundJob: true,
      progress(phase) {
        jobs.progress(job.id, phase)
      },
      answer(text) {
        jobs.answer(job.id, text)
      },
    }
    // Direct synchronous admission shares the browser lock with ordinary responses.
    // The job sink deliberately has no dependency on this HTTP client's lifetime.
    generate({ body: parsed.data, path: '/v1/responses' }, sink, true)
    if (!admitted) {
      jobs.remove(job.id)
      res.status(status).json(rejected)
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.status(202).json(jobs.get(job.id))
  })
  app.get('/v1/response-jobs/:id/events', (req, res) => {
    const id = req.params.id as string
    const waitMs = Number(req.query.wait_ms ?? 25000)
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 60000) {
      res.status(400).json({ error: { code: 'invalid_wait_ms' } })
      return
    }
    const job = jobs.get(id)
    if (!job) {
      res.status(404).json({ error: { code: 'response_job_not_found' } })
      return
    }
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    let closed = false
    let unsubscribe = () => {}
    let timeout: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const finish = () => {
      if (closed) return
      closed = true
      unsubscribe()
      clearTimeout(timeout)
      clearInterval(heartbeat)
      res.end()
    }
    const write = (type: string, value: unknown) => {
      if (closed) return
      if (res.writableLength > 64 * 1024 * 1024) {
        finish()
        return
      }
      res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
    }
    res.on('close', finish)
    unsubscribe = jobs.subscribe(id, (event) => {
      write(event.type, event)
      if (event.type === 'response_job.updated' && event.job.status !== 'in_progress') finish()
    })
    write('response_job.updated', { type: 'response_job.updated', job })
    const text = jobs.text(id)
    if (text)
      write('response.output_text.snapshot', { type: 'response.output_text.snapshot', text })
    if (job.status !== 'in_progress') {
      finish()
      return
    }
    timeout = setTimeout(() => {
      write('response_job.wait_finished', { type: 'response_job.wait_finished', job: jobs.get(id) })
      finish()
    }, waitMs)
    heartbeat = setInterval(() => {
      const snapshot = jobs.get(id)
      // Also report inactivity before native response headers have arrived.
      if (snapshot?.phase === 'unresponsive')
        write('response_job.updated', { type: 'response_job.updated', job: snapshot })
      if (res.writableLength > 64 * 1024 * 1024) {
        finish()
        return
      }
      res.write(': keep-alive\n\n')
    }, 5000)
  })
  app.get('/v1/response-jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id as string)
    res.setHeader('Cache-Control', 'no-store')
    if (!job) {
      res.status(404).json({ error: { code: 'response_job_not_found' } })
      return
    }
    res.json(job)
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
          if (
            server.upgrade(req, {
              data: {
                client: null,
                lane,
                nativeProtocol: new URL(req.url).searchParams.get('nativeProtocol') === '1',
              },
            })
          )
            return
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
            lane.nativeReady = false
            clearReadinessProbe(lane)
            const nativeProtocol = (socket.data as SocketData & { nativeProtocol?: boolean })
              .nativeProtocol
            if (nativeProtocol) {
              lane.nativeAdvertised = true
              client.send(JSON.stringify(beginReadinessProbe(lane)))
            }
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
              lane.nativeReady = false
              clearReadinessProbe(lane)
              lane.nativeQueue = []
              for (const record of nativeGenerations.values())
                if (record.context.browserId === lane.id)
                  jobs.progress(record.jobId, 'unresponsive')
              if (lane.pending?.background) lane.pending.suspend?.()
              else if (!lane.pending?.navigating)
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
      for (const lane of lanes.values()) clearTimeout(lane.readinessRetryTimer)
      for (const record of nativeGenerations.values()) record.detached?.()
      jobs.close()
      sessions.close()
      clearInterval(leaseTimer)
      for (const lane of lanes.values())
        if (lane.pending?.background) lane.pending.suspend?.()
        else lane.pending?.fail(503, 'server_shutdown', 'Server is shutting down.')
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
    imagesDir: process.env.LOCALGPT_IMAGES_DIR || resolve('.localgpt-images'),
    imagesHostDir: process.env.LOCALGPT_IMAGES_HOST_DIR,
    localMcp: readLocalMcpConfig(),
    responseJobsDir: process.env.LOCALGPT_RESPONSE_JOBS_DIR || resolve('.localgpt-response-jobs'),
    sessionsFile: process.env.SESSIONS_FILE || resolve('.localgpt-sessions.sqlite'),
    host: process.env.HOST || '127.0.0.1',
    httpPort: Number(process.env.HTTP_PORT || 8766),
    wsPort: Number(process.env.WS_PORT || 8875),
    timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || DEFAULT_GENERATION_TIMEOUT_MS),
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
