import { DEFAULT_GENERATION_TIMEOUT_MS } from './timeouts'
import { DraftBackups } from './draft-backup'
import { parseChatRoute, conversationPath } from './projects'
import {
  ensureProjectTarget,
  openProjectChat,
  moveConversationToProject,
  conversationActionOwned,
  conversationActions,
  conversationRowLinks,
} from './browser-projects'
import { type ImageData } from './generated-image-protocol'
import { MAX_GENERATED_IMAGES } from './generated-image-protocol'
import {
  STREAM_ARM_EVENT,
  STREAM_EVENT,
  StreamEventSchema,
  type StreamEvent,
} from './conversation-stream'
import { attachFiles, assertNoManualAttachments } from './browser-files'
import { selectModel } from './model-selection'
import { DOT_EVENT, DotListSchema, dotMessages, findDotEditor, type Dot } from './dots'
import {
  CONVERSATION_DELETED_EVENT,
  ConversationDeletedSchema,
  CAPABILITY_EVENT,
  CAPABILITY_REQUEST,
  CapabilitiesSchema,
  emptyCapabilities,
} from './capabilities'
import { BrowserRequestSchema, type BrowserEvent, type BrowserRequest } from './protocol'
import {
  DomError,
  isVisible,
  userNodes,
  findEditor,
  writeEditor,
  readPlainDraft,
  findSendButton,
  isGenerating,
  assistantNodes,
  findNewChatButton,
  inspectModels,
  isWorkMode,
} from './chatgpt-dom'

declare const __BRIDGE_TOKEN__: string
declare function GM_xmlhttpRequest(options: {
  method: string
  url: string
  headers: Record<string, string>
  data: string
  timeout: number
  onload: (response: { status: number; responseText: string }) => void
  onerror: () => void
  ontimeout: () => void
}): void
const WS_URL = `ws://127.0.0.1:8875/?token=${encodeURIComponent(__BRIDGE_TOKEN__)}`
const HTTP_URL = 'http://127.0.0.1:8766'
const TIMEOUT_MS = DEFAULT_GENERATION_TIMEOUT_MS
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
// Native errors or verified terminal-output failures; anything else is an unknown outcome.
const DEFINITE_FAILURES = [
  'chatgpt_generation_failed',
  'chatgpt_generation_cancelled',
  'chatgpt_http_error',
  'chatgpt_api_error',
  'image_generation_failed',
  'response_recovery_failed',
]
// Preserve stable guard codes that already prove the generation was never sent.
// Other pre-click failures carry an explicit setup_ prefix, including transport loss.
const DEFINITE_SETUP_FAILURES = new Set([
  'browser_setup_timeout',
  'browser_busy',
  'chat_mode_required',
  'dot_mode_requires_dot_api',
  'composer_not_empty',
  'new_chat_not_found',
  'model_required',
  'editor_not_found',
  'editor_unavailable',
  'model_selector_unavailable',
  'model_unavailable',
  'model_selection_failed',
  'reasoning_selector_unavailable',
  'attachment_draft_present',
  'attachment_input_unavailable',
  'attachment_upload_failed',
  'attachment_upload_timeout',
  'draft_unsupported',
  'draft_clear_failed',
  'draft_storage_unavailable',
  'draft_too_large',
  'draft_backup_conflict',
])
export type HttpBridge = (path: string, data: unknown, browserId: string) => Promise<unknown>
class App {
  private responseStream: {
    requestId: string
    messageId: string | null
    conversationId: string | null
    text: string | null
    terminal: StreamEvent | null
    started: boolean
    imageRefs: Set<string>
    images: Map<string, { downloadUrl?: string; imageData?: ImageData }>
    sentImages: Set<string>
    forwardedText: string | null
    wake?: () => void
    terminalAt: number | null
    background?: boolean
    uncertain: boolean
  } | null = null
  private deletedReceipt: string | null = null
  private navigating = false
  private navigationReady = new Set<string>()
  private dots: Dot[] = []
  private dotsCursor: string | null = null
  private capabilities = emptyCapabilities()
  private socket: WebSocket | null = null
  private active: string | null = null
  private status: HTMLDivElement
  private destroyed = false
  private transport: 'websocket' | 'http' = 'websocket'
  private pollingStarted = false
  private httpConnected = false
  private browserId = (() => {
    try {
      const key = 'localgpt:browser-id'
      const previous = sessionStorage.getItem(key)
      if (previous && /^[a-f0-9-]{36}$/.test(previous)) return previous
      const id = crypto.randomUUID()
      sessionStorage.setItem(key, id)
      return id
    } catch {
      return crypto.randomUUID()
    }
  })()
  private events: Promise<void> = Promise.resolve()
  private coalescedEvents = new Map<string, BrowserEvent>()
  private reconnect: ReturnType<typeof setTimeout> | null = null
  private drafts = new DraftBackups(() => sessionStorage)
  private recovery: HTMLDivElement
  private recoveryValue = ''
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  private lastManualEdit = -Infinity
  private markManualEdit = () => {
    this.lastManualEdit = Date.now()
  }
  constructor(private httpBridge?: HttpBridge) {
    window.addEventListener('input', this.markManualEdit, true)
    window.addEventListener('keydown', this.markManualEdit, true)
    window.addEventListener(STREAM_EVENT, (event) => {
      try {
        const parsed = StreamEventSchema.safeParse(
          JSON.parse((event as CustomEvent<string>).detail),
        )
        const state = this.responseStream
        if (
          !parsed.success ||
          !state ||
          parsed.data.requestId !== state.requestId ||
          state.terminal?.kind === 'error'
        )
          return
        const incoming = parsed.data
        if (
          (state.messageId && state.messageId !== incoming.messageId) ||
          (state.conversationId &&
            incoming.conversationId &&
            state.conversationId !== incoming.conversationId)
        ) {
          state.terminal = { ...incoming, kind: 'error', code: 'conversation_changed' }
          state.wake?.()
          return
        }
        state.messageId = incoming.messageId
        state.conversationId = incoming.conversationId ?? state.conversationId
        state.started = true
        if (
          state.background &&
          incoming.kind === 'error' &&
          !DEFINITE_FAILURES.includes(incoming.code ?? '')
        ) {
          // The native stream outcome is unknown; keep observing and wait.
          state.uncertain = true
          this.send({ type: 'progress', requestId: state.requestId, phase: 'unresponsive' })
          state.wake?.()
          return
        }
        if (incoming.kind === 'progress' && incoming.phase) {
          this.send({ type: 'progress', requestId: state.requestId, phase: incoming.phase })
          this.setStatus(
            incoming.phase === 'thinking'
              ? '思考中'
              : incoming.phase === 'unresponsive'
                ? 'API通信待ち · 状態未確認'
                : incoming.phase === 'answering'
                  ? '回答中'
                  : '処理中',
          )
        }
        if (incoming.kind === 'image_ref' && incoming.fileId) {
          state.imageRefs.add(incoming.fileId)
          if (state.imageRefs.size > MAX_GENERATED_IMAGES)
            state.terminal = { ...incoming, kind: 'error', code: 'too_many_generated_images' }
        } else if (
          incoming.kind === 'image' &&
          incoming.fileId &&
          (incoming.downloadUrl || incoming.imageData)
        ) {
          if (state.imageRefs.has(incoming.fileId))
            state.images.set(incoming.fileId, {
              downloadUrl: incoming.downloadUrl,
              imageData: incoming.imageData,
            })
        } else if (incoming.kind === 'answer' && incoming.text !== undefined && !state.terminal)
          state.text = incoming.text
        else if ((incoming.kind === 'stop' && !state.terminal) || incoming.kind === 'error') {
          state.terminal = incoming
          state.terminalAt = Date.now()
        }
        state.wake?.()
      } catch {}
    })
    window.addEventListener(CONVERSATION_DELETED_EVENT, (event) => {
      try {
        const parsed = ConversationDeletedSchema.safeParse(
          JSON.parse((event as CustomEvent<string>).detail),
        )
        if (parsed.success) this.deletedReceipt = parsed.data.conversationId
      } catch {}
    })
    window.addEventListener(DOT_EVENT, (event) => {
      try {
        const parsed = DotListSchema.safeParse(
          JSON.parse((event as CustomEvent<string>).detail) as unknown,
        )
        if (parsed.success) {
          this.dots = parsed.data.dots
          this.dotsCursor = parsed.data.cursor
        }
      } catch {}
    })
    window.addEventListener(CAPABILITY_EVENT, (event) => {
      try {
        const parsed = CapabilitiesSchema.safeParse(
          JSON.parse((event as CustomEvent<string>).detail) as unknown,
        )
        if (parsed.success) this.capabilities = parsed.data
      } catch {
        /* Ignore unrelated events. */
      }
    })
    window.dispatchEvent(new CustomEvent(CAPABILITY_REQUEST))
    this.status = document.createElement('div')
    this.status.id = 'chatgpt-local-api-status'
    this.status.style.cssText =
      'position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:8px 12px;border-radius:8px;background:#202020;color:white;font:12px sans-serif;max-width:340px;white-space:pre-wrap;'
    document.body.append(this.status)
    this.recovery = document.createElement('div')
    this.recovery.id = 'localgpt-saved-drafts'
    this.recovery.style.cssText =
      'position:fixed;bottom:68px;right:12px;z-index:2147483647;padding:12px;border-radius:8px;background:#202020;color:white;font:12px sans-serif;max-width:340px;max-height:40vh;overflow:auto;'
    this.recovery.hidden = true
    document.body.append(this.recovery)
    const watch = () => {
      if (this.destroyed) return
      this.recoverDraft()
      this.draftTimer = setTimeout(watch, 1000)
    }
    this.showSavedDrafts()
    this.draftTimer = setTimeout(watch, 1000)
  }
  private showSavedDrafts() {
    try {
      const records = this.drafts.list(),
        value = JSON.stringify(records)
      if (value === this.recoveryValue) return
      this.recoveryValue = value
      this.recovery.replaceChildren()
      this.recovery.hidden = records.length === 0
      if (!records.length) return
      const title = document.createElement('div')
      title.textContent = 'LocalGPT · 保存した下書き（このタブ内）'
      this.recovery.append(title)
      for (const draft of records) {
        const preview = document.createElement('pre')
        preview.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;'
        preview.textContent = draft.text.slice(0, 160)
        const link = document.createElement('a')
        link.href = draft.route
        link.style.color = '#9dccff'
        link.textContent = '元の会話で復元'
        const copy = document.createElement('button')
        copy.type = 'button'
        copy.textContent = '全文をコピー'
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(draft.text)
            copy.textContent = 'コピーしました'
          } catch {
            preview.textContent = draft.text
            copy.textContent = '表示した本文を選択してコピー'
          }
        })
        this.recovery.append(preview, link, document.createTextNode(' '), copy)
      }
    } catch {
      this.recoveryValue = ''
      this.recovery.hidden = false
      this.recovery.textContent =
        'LocalGPT · 下書き保存領域を読み取れません。入力欄を変更せずに保護しています。'
    }
  }
  private recoverDraft() {
    if (
      this.active ||
      this.navigating ||
      this.destroyed ||
      isGenerating(document) ||
      isWorkMode(document)
    )
      return
    try {
      this.drafts.restore(document, location.pathname)
    } catch {
      // An occupied/unsupported editor or failed native edit keeps the durable backup.
    }
    this.showSavedDrafts()
  }
  private setStatus(text: string) {
    this.status.textContent = `LocalGPT · ${text}`
  }
  private acknowledgements = new Map<string, (received: boolean | null) => void>()
  // Resolves true only when the server confirmed it took the event (HTTP reply or WebSocket event_ack).
  // null means the outcome of delivery is unknown (transport failure, timeout, malformed reply).
  private async sendObserved(event: BrowserEvent): Promise<boolean | null> {
    if (this.transport === 'http') {
      try {
        await this.events
        const reply = await this.httpRequest('event', event)
        this.httpConnected = true
        if (
          typeof reply === 'object' &&
          reply !== null &&
          'accepted' in reply &&
          typeof reply.accepted === 'boolean'
        )
          return reply.accepted
        return null
      } catch {
        this.httpConnected = false
        this.responseStream?.wake?.()
        return null
      }
    }
    if (this.socket?.readyState !== WebSocket.OPEN || event.type === 'heartbeat') return null
    const eventId = crypto.randomUUID()
    return new Promise<boolean | null>((resolve) => {
      const done = (received: boolean | null) => {
        clearTimeout(timer)
        this.acknowledgements.delete(eventId)
        resolve(received)
      }
      const timer = setTimeout(() => done(null), 4000)
      this.acknowledgements.set(eventId, done)
      try {
        this.socket!.send(JSON.stringify({ ...event, eventId }))
      } catch {
        done(null)
      }
    })
  }
  private send(event: BrowserEvent) {
    if (this.transport === 'http') {
      const key =
        event.type === 'answer' || event.type === 'progress'
          ? `${event.requestId}:${event.type}`
          : null
      if (key) {
        const alreadyQueued = this.coalescedEvents.has(key)
        this.coalescedEvents.set(key, event)
        if (alreadyQueued) return
      }
      this.events = this.events
        .then(async () => {
          const latest = key ? this.coalescedEvents.get(key)! : event
          if (key) this.coalescedEvents.delete(key)
          await this.httpRequest('event', latest)
        })
        .catch((err) => {
          this.httpConnected = false
          this.responseStream?.wake?.()
          this.setStatus(err instanceof Error ? err.message : 'HTTP event failed')
        })
    } else if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event))
  }
  private waitForStreamEvent(deadline: number) {
    const state = this.responseStream
    if (!state || this.destroyed) return Promise.resolve()
    if (!Number.isFinite(deadline)) deadline = Date.now() + 1000
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        if (state.wake === finish) delete state.wake
        resolve()
      }
      const timer = setTimeout(finish, Math.max(1, deadline - Date.now()))
      state.wake = finish
    })
  }
  private async until<T>(read: () => T | null | false, deadline: number): Promise<T> {
    while (Date.now() < deadline) {
      if (this.destroyed || !this.connected())
        throw new DomError('browser_disconnected', 'Local server disconnected.')
      const value = read()
      if (value) return value
      await sleep(100)
    }
    throw new DomError('browser_timeout', 'Timed out waiting for the ChatGPT page.')
  }
  private async runDot(request: Extract<BrowserRequest, { type: 'dots' }>) {
    if (this.active) {
      this.send({
        type: 'error',
        requestId: request.requestId,
        code: 'browser_busy',
        message: 'Another browser operation is running.',
      })
      return
    }
    this.active = request.requestId
    const operation = request.operation
    try {
      window.dispatchEvent(new CustomEvent(CAPABILITY_REQUEST))
      const selected = this.dots.find((dot) => location.pathname === `/dots/${dot.threadId}`)
      if (operation.action === 'list') {
        this.send({
          type: 'dots',
          requestId: request.requestId,
          result: {
            action: 'list',
            dots: this.dots,
            cursor: this.dotsCursor,
            source: 'chatgpt_api',
            selected: selected?.id ?? null,
          },
        })
        return
      }
      const dot = this.dots.find((dot) => dot.id === operation.dotId)
      if (!dot)
        throw new DomError(
          'dot_not_found',
          'Dot was not observed in this account. Reload ChatGPT to observe the dots list.',
        )
      if (operation.action === 'select') {
        if (selected?.id === dot.id) {
          this.send({
            type: 'dots',
            requestId: request.requestId,
            result: { action: 'select', dot, status: 'selected' },
          })
          return
        }
        const draft = document.querySelector<HTMLElement | HTMLTextAreaElement>(
          '[role="textbox"][contenteditable="true"], textarea',
        )
        if (draft) assertNoManualAttachments(draft)
        if (
          (draft instanceof HTMLTextAreaElement ? draft.value : (draft?.textContent ?? '')).trim()
        )
          throw new DomError('composer_not_empty', 'An unsent draft is present.')
        if (isGenerating(document))
          throw new DomError('browser_busy', 'ChatGPT is generating a response.')
        this.send({
          type: 'dots',
          requestId: request.requestId,
          result: { action: 'select', dot, status: 'navigation_requested' },
        })
        await this.events
        location.assign(`/dots/${dot.threadId}`)
        return
      }
      if (selected?.id !== dot.id)
        throw new DomError(
          'dot_not_selected',
          'Select the requested dot first, then wait for ChatGPT to reconnect.',
        )
      const pane = document.querySelector('main.thread-pane')
      if (!pane) throw new DomError('dot_not_ready', 'Dot conversation is still loading.')
      if (operation.action === 'messages') {
        let messages = dotMessages(document)
        if (operation.afterMessageId) {
          const index = messages.findIndex((message) => message.id === operation.afterMessageId)
          if (index < 0)
            throw new DomError(
              'message_cursor_not_visible',
              'Message cursor is not currently rendered; refusing to return unrelated history.',
            )
          messages = messages.slice(index + 1)
        }
        this.send({
          type: 'dots',
          requestId: request.requestId,
          result: {
            action: 'messages',
            dotId: dot.id,
            messages: messages.slice(-operation.limit),
            source: 'visible_ui',
            scope: 'rendered_messages',
            complete: false,
          },
        })
        return
      }
      if (dot.paused)
        throw new DomError(
          'dot_paused',
          'The dot is paused. Resume it in ChatGPT before messaging.',
        )
      const editor = findDotEditor(document)
      if (!editor) throw new DomError('editor_not_found', 'Dot message editor was not found.')
      const reply = pane.querySelector(
        '[data-reply-to], .reply-preview, [aria-label="Cancel reply"]',
      )
      if (reply) throw new DomError('reply_draft_present', 'A manual reply is being composed.')
      assertNoManualAttachments(editor)
      const before = new Set(dotMessages(document).map((m) => m.id))
      const assertDot = () => {
        if (
          location.pathname !== `/dots/${dot.threadId}` ||
          !pane.isConnected ||
          !editor.isConnected ||
          findDotEditor(document) !== editor
        )
          throw new DomError('conversation_changed', 'The selected dot conversation changed.')
      }
      assertDot()
      writeEditor(document, operation.text, editor)
      const send = await this.until(() => {
        const button = pane.querySelector<HTMLButtonElement>('button[aria-label="Send"]')
        return button && !button.disabled ? button : null
      }, Date.now() + 5000)
      assertDot()
      send.click()
      const sent = await this.until(() => {
        assertDot()
        return (
          dotMessages(document).find(
            (m) =>
              m.role === 'user' && !before.has(m.id) && m.text.trim() === operation.text.trim(),
          ) || null
        )
      }, Date.now() + 10000)
      this.send({
        type: 'dots',
        requestId: request.requestId,
        result: { action: 'send', dotId: dot.id, messageId: sent.id, status: 'sent' },
      })
    } catch (error) {
      this.send({
        type: 'error',
        requestId: request.requestId,
        code: error instanceof DomError ? error.code : 'dot_error',
        message: error instanceof Error ? error.message : 'Dot operation failed.',
      })
    } finally {
      this.active = null
    }
  }
  private async run(request: BrowserRequest) {
    if (request.type === 'event_ack') {
      if (request.requestId === this.active)
        this.acknowledgements.get(request.eventId)?.(request.accepted)
      return
    }
    if (request.type === 'navigation_ready') {
      this.navigationReady.add(request.requestId)
      return
    }
    if (request.type === 'dots') {
      await this.runDot(request)
      return
    }
    if (request.type === 'move_conversation') {
      await this.runMove(request)
      return
    }
    if (request.type === 'delete_conversation') {
      await this.runDelete(request)
      return
    }
    if (request.type === 'capabilities') {
      window.dispatchEvent(new CustomEvent(CAPABILITY_REQUEST))
      this.send({ type: 'capabilities', requestId: request.requestId, ...this.capabilities })
      return
    }
    if (request.type === 'models') {
      try {
        this.send({
          type: 'models',
          requestId: request.requestId,
          ...(await inspectModels(document)),
        })
      } catch {
        this.send({
          type: 'error',
          requestId: request.requestId,
          code: 'model_selector_unavailable',
          message: 'Unable to read the model selector.',
        })
      }
      return
    }
    if (this.active) {
      this.send({
        type: 'error',
        requestId: request.requestId,
        code: 'browser_busy',
        message: 'A browser request is already running.',
      })
      return
    }
    this.active = request.requestId
    this.setStatus('処理中')
    const background = request.backgroundJob === true
    // Foreground requests keep their fixed deadline; only job setup follows the server's bound.
    const setupDeadline = Date.now() + (background ? (request.timeoutMs ?? TIMEOUT_MS) : TIMEOUT_MS)
    let dispatched = false
    // Bounded through setup and dispatch; an async job has no wall deadline once actually sent.
    let deadline = setupDeadline
    try {
      const currentEditor = await this.until(
        () => {
          try {
            return findEditor(document)
          } catch {
            return null
          }
        },
        Math.min(setupDeadline, Date.now() + 10000),
      )
      assertNoManualAttachments(currentEditor)
      if (isGenerating(document))
        throw new DomError('browser_busy', 'ChatGPT is already generating a response.')
      if (isWorkMode(document))
        throw new DomError(
          'chat_mode_required',
          'Switch ChatGPT to Chat mode before using LocalGPT.',
        )
      this.drafts.suspend(document, location.pathname)
      this.showSavedDrafts()
      let capturedReady: HTMLElement = currentEditor
      const assertReady = () => {
        let editor: HTMLElement
        try {
          editor = findEditor(document)
          capturedReady = editor
        } catch (err) {
          if (!capturedReady.isConnected) throw err
          editor = capturedReady
        }
        assertNoManualAttachments(editor)
        if (readPlainDraft(editor) !== '')
          throw new DomError('composer_not_empty', 'An unsent draft is present.')
        if (isGenerating(document))
          throw new DomError('browser_busy', 'ChatGPT is already generating a response.')
      }
      const projectId = request.projectName
        ? await ensureProjectTarget(
            document,
            request.projectName,
            this.until.bind(this),
            Math.min(deadline, Date.now() + 15000),
            assertReady,
            request.projectId,
          )
        : undefined
      if (request.projectId && request.projectId !== projectId)
        throw new DomError('project_mismatch', 'The selected project identity changed.')
      if (
        request.conversationId &&
        parseChatRoute(location.pathname)?.conversationId !== request.conversationId
      ) {
        this.navigating = true
        this.send({
          type: 'navigate',
          requestId: request.requestId,
          conversationId: request.conversationId,
        })
        await this.events
        if (this.transport === 'websocket')
          await this.until(() => this.navigationReady.delete(request.requestId), Date.now() + 5000)
        location.assign(conversationPath(request.conversationId, request.projectId))
        return
      }
      if (/^\/dots\//.test(location.pathname))
        throw new DomError(
          'dot_mode_requires_dot_api',
          'Use the dedicated dots API for a dot conversation.',
        )
      if (isWorkMode(document))
        throw new DomError(
          'chat_mode_required',
          'Switch ChatGPT to Chat mode before using LocalGPT.',
        )
      if (isGenerating(document))
        throw new DomError('browser_busy', 'ChatGPT is already generating a response.')
      // Never clear a user's manual draft or edit an existing message.
      const current = findEditor(document)
      assertNoManualAttachments(current)
      if (readPlainDraft(current) !== '')
        throw new DomError('composer_not_empty', 'An unsent draft is present.')
      if (projectId && request.conversationId)
        await moveConversationToProject(
          document,
          request.conversationId,
          request.projectName!,
          projectId,
          assertReady,
          this.until.bind(this),
          Math.min(deadline, Date.now() + 15000),
        )
      if (projectId && request.newChat)
        await openProjectChat(
          document,
          request.projectName!,
          projectId,
          this.until.bind(this),
          Math.min(deadline, Date.now() + 10000),
          assertReady,
        )
      if (
        !projectId &&
        request.newChat &&
        (assistantNodes(document).length > 0 ||
          userNodes(document).length > 0 ||
          /\/c\/[^/]+/.test(location.pathname))
      ) {
        const button = findNewChatButton(document)
        if (!button) throw new DomError('new_chat_not_found', 'New chat control was not found.')
        const previousPath = location.pathname
        const wasConversationRoute = /\/c\/[^/]+/.test(previousPath)
        button.click()
        await this.until(
          () => {
            if (wasConversationRoute && location.pathname === previousPath) return false
            if (assistantNodes(document).length || userNodes(document).length) return false
            try {
              const editor = findEditor(document)
              return readPlainDraft(editor) !== '' ? false : editor
            } catch {
              return false
            }
          },
          Math.min(deadline, Date.now() + 10000),
        )
      }
      let expectedPath = location.pathname
      const initialRoute = parseChatRoute(expectedPath)
      const assertConversation = (allowNewConversation = false) => {
        // Once the native send is correlated, response ownership no longer depends on the visible chat.
        if (allowNewConversation && this.responseStream?.started) return
        if (location.pathname === expectedPath) return
        const route = parseChatRoute(location.pathname)
        if (
          allowNewConversation &&
          !initialRoute?.conversationId &&
          route?.projectId === (projectId ?? null)
        ) {
          const id = this.responseStream?.conversationId
          if (!id && route.conversationId) return
          if (id && route.conversationId === id) {
            expectedPath = location.pathname
            return
          }
        }
        throw new DomError(
          'conversation_changed',
          'The ChatGPT conversation changed before the request was identified.',
        )
      }
      if (request.model)
        await selectModel(document, this.capabilities, request.model, request.reasoning?.effort)
      else if (request.reasoning)
        throw new DomError('model_required', 'Specify a model ID when selecting reasoning effort.')
      assertConversation()
      assertReady()
      const editor = findEditor(document)
      writeEditor(document, request.text, editor)
      if (request.files?.length)
        await attachFiles(document, request.files, () => assertConversation())
      const send = await this.until(
        () => {
          const button = findSendButton(document)
          return button && !button.disabled ? button : null
        },
        Math.min(deadline, Date.now() + 10000),
      )
      assertConversation()
      if (!editor.isConnected || findEditor(document) !== editor)
        throw new DomError('conversation_changed', 'The message editor changed before sending.')
      this.responseStream = {
        requestId: request.requestId,
        messageId: null,
        conversationId: request.conversationId ?? null,
        text: null,
        terminal: null,
        started: false,
        imageRefs: new Set(),
        images: new Map(),
        sentImages: new Set(),
        forwardedText: null,
        terminalAt: null,
        background,
        uncertain: false,
      }
      window.dispatchEvent(
        new CustomEvent(STREAM_ARM_EVENT, {
          detail: JSON.stringify({
            requestId: request.requestId,
            text: request.text,
            newChat: request.newChat,
            timeoutMs: request.timeoutMs ?? TIMEOUT_MS,
            ...(background ? { backgroundJob: true } : {}),
            ...(projectId ? { projectId } : {}),
          }),
        }),
      )
      // A click can invoke page handlers before throwing; once attempted, unsent is no longer proven.
      dispatched = true
      send.click()
      if (background) deadline = Infinity
      let lastText = ''
      let changedRouteAt: number | null = null
      const observationDeadline = Math.min(setupDeadline, Date.now() + 10000)
      while (Date.now() < deadline) {
        if (this.destroyed || (!background && !this.connected()))
          throw new DomError('browser_disconnected', 'Local server disconnected.')
        const state = this.responseStream!
        if (background && !state.started && Date.now() >= observationDeadline) {
          this.send({ type: 'progress', requestId: request.requestId, phase: 'unresponsive' })
          await this.waitForStreamEvent(Date.now() + 1000)
          continue
        }
        if (!state.started && Date.now() >= observationDeadline)
          throw new DomError(
            'response_stream_unavailable',
            'The sent request was not observed. Update the LocalGPT extension and reload ChatGPT.',
          )
        if (location.pathname !== expectedPath && !state.conversationId && !state.started) {
          changedRouteAt ??= Date.now()
          if (Date.now() - changedRouteAt >= 2000)
            throw new DomError(
              'conversation_changed',
              'The new conversation was not identified by the API.',
            )
        }
        assertConversation(true)
        if (request.conversationId && state.conversationId !== request.conversationId)
          throw new DomError('conversation_changed', 'The API returned a different conversation.')
        if (
          state.terminal?.kind === 'error' &&
          (!background || DEFINITE_FAILURES.includes(state.terminal.code ?? ''))
        )
          throw new DomError(
            state.terminal.code ?? 'chatgpt_api_error',
            'ChatGPT response communication failed or was incomplete.',
          )
        if (state.conversationId && state.text !== null && state.text !== lastText) {
          lastText = state.text
        }
        if (background && !this.connected()) {
          // Keep observing ChatGPT locally; replay accumulated data once reconnected.
          await this.waitForStreamEvent(Infinity)
          continue
        }
        if (state.conversationId)
          for (const [fileId, image] of state.images) {
            if (state.sentImages.has(fileId)) continue
            const imageEvent: BrowserEvent = {
              type: 'image',
              requestId: request.requestId,
              conversationId: state.conversationId,
              fileId,
              ...image,
            }
            if (!background || (await this.sendObserved(imageEvent))) {
              if (!background) this.send(imageEvent)
              state.sentImages.add(fileId)
            }
          }
        if (
          state.conversationId &&
          state.text !== null &&
          state.text !== state.forwardedText &&
          (state.terminal?.kind === 'stop' || state.uncertain) &&
          state.imageRefs.size === state.images.size &&
          state.sentImages.size === state.images.size
        ) {
          const observedText = state.text
          if (!background) {
            this.send({ type: 'answer', requestId: request.requestId, text: observedText })
            state.forwardedText = observedText
          } else if (
            await this.sendObserved({
              type: 'answer',
              requestId: request.requestId,
              text: observedText,
            })
          )
            state.forwardedText = observedText
          else {
            await this.waitForStreamEvent(Date.now() + 1000)
            continue
          }
        }
        if (
          background &&
          state.terminal?.kind === 'error' &&
          !DEFINITE_FAILURES.includes(state.terminal.code ?? '')
        ) {
          this.send({ type: 'progress', requestId: request.requestId, phase: 'unresponsive' })
          await this.waitForStreamEvent(Date.now() + 1000)
          continue
        }
        if (background && state.sentImages.size < state.images.size) {
          await this.waitForStreamEvent(Date.now() + 1000)
          continue
        }
        if (state.terminal?.kind === 'stop') {
          if (state.imageRefs.size !== state.images.size) {
            if (Date.now() - (state.terminalAt ?? Date.now()) > 20000)
              throw new DomError(
                'image_download_unavailable',
                'The generated image download was not observed.',
              )
            await this.waitForStreamEvent(
              Math.min(deadline, (state.terminalAt ?? Date.now()) + 20001),
            )
            continue
          }
          if (!state.conversationId || (!lastText.trim() && !state.images.size))
            throw new DomError(
              'response_incomplete',
              'The API did not return a completed text response.',
            )
          const stopEvent: BrowserEvent = {
            type: 'stop',
            requestId: request.requestId,
            conversationId: state.conversationId,
            ...(state.terminal.projectId ? { projectId: state.terminal.projectId } : {}),
          }
          if (background && !(await this.sendObserved(stopEvent))) {
            await this.waitForStreamEvent(Date.now() + 1000)
            continue
          }
          if (!background) this.send(stopEvent)
          this.setStatus('接続済み · 完了')
          return
        }
        await this.waitForStreamEvent(
          Math.min(
            deadline,
            ...(!state.started ? [Math.min(observationDeadline, Date.now() + 100)] : []),
            ...(changedRouteAt && !state.started ? [changedRouteAt + 2001] : []),
          ),
        )
      }
      throw new DomError(
        'browser_timeout',
        'No completed ChatGPT response arrived before the timeout.',
      )
    } catch (err) {
      this.navigating = false
      let error =
        err instanceof DomError
          ? err
          : new DomError(
              'browser_error',
              err instanceof Error ? err.message : 'Unknown browser error',
            )
      if (background && !dispatched) {
        if (error.code === 'browser_timeout')
          error = new DomError('browser_setup_timeout', error.message)
        else if (!DEFINITE_SETUP_FAILURES.has(error.code))
          error = new DomError(`setup_${error.code}`, error.message)
      }
      const failure: BrowserEvent = {
        type: 'error',
        requestId: request.requestId,
        code:
          background && dispatched && !DEFINITE_FAILURES.includes(error.code)
            ? `observation_${error.code}`
            : error.code,
        message: error.message,
      }
      if (background) {
        // Retain the active request until ownership is acknowledged; replay events only, never the send.
        // Complete images and partial text are flushed before the error so observed output is not lost.
        while (!this.destroyed) {
          const state = this.responseStream
          if (state?.conversationId) {
            let retryImages = false
            for (const [fileId, image] of state.images) {
              if (state.sentImages.has(fileId)) continue
              if (
                (await this.sendObserved({
                  type: 'image',
                  requestId: request.requestId,
                  conversationId: state.conversationId,
                  fileId,
                  ...image,
                })) !== true
              ) {
                retryImages = true
                break
              }
              state.sentImages.add(fileId)
            }
            if (retryImages) {
              await sleep(1000)
              continue
            }
          }
          if (state?.conversationId && state.text !== null && state.text !== state.forwardedText) {
            const partial = state.text
            if (
              (await this.sendObserved({
                type: 'answer',
                requestId: request.requestId,
                text: partial,
              })) !== true
            ) {
              await sleep(1000)
              continue
            }
            state.forwardedText = partial
          }
          const accepted = await this.sendObserved(failure)
          // An explicit rejection can release this tab only when no send was ever attempted.
          if (accepted === true || (!dispatched && accepted === false)) break
          await sleep(1000)
        }
      } else {
        const state = this.responseStream
        if (state?.conversationId) {
          for (const [fileId, image] of state.images) {
            if (state.sentImages.has(fileId)) continue
            this.send({
              type: 'image',
              requestId: request.requestId,
              conversationId: state.conversationId,
              fileId,
              ...image,
            })
            state.sentImages.add(fileId)
          }
        }
        if (state?.conversationId && state.text !== null && state.text !== state.forwardedText) {
          this.send({ type: 'answer', requestId: request.requestId, text: state.text })
          state.forwardedText = state.text
        }
        this.send(failure)
      }
      this.setStatus(`${error.code}\n${error.message}`)
      console.error('[LocalGPT]', error.code, error.message)
    } finally {
      window.dispatchEvent(new CustomEvent('localgpt:stream-disarm', { detail: request.requestId }))
      this.responseStream?.wake?.()
      this.responseStream = null
      this.active = null
      this.recoverDraft()
    }
  }
  private async runMove(request: Extract<BrowserRequest, { type: 'move_conversation' }>) {
    if (this.active) {
      this.send({
        type: 'error',
        requestId: request.requestId,
        code: 'browser_busy',
        message: 'Another browser operation is running.',
      })
      return
    }
    this.active = request.requestId
    let capturedReady: HTMLElement | null = null
    const assertReady = () => {
      let editor: HTMLElement
      try {
        editor = findEditor(document)
        capturedReady = editor
      } catch (err) {
        if (!capturedReady?.isConnected) throw err
        editor = capturedReady
      }
      assertNoManualAttachments(editor)
      if (
        (editor instanceof HTMLTextAreaElement ? editor.value : (editor.textContent ?? '')).trim()
      )
        throw new DomError('composer_not_empty', 'An unsent draft is present.')
      if (isGenerating(document))
        throw new DomError('browser_busy', 'ChatGPT is generating a response.')
      if (isWorkMode(document)) throw new DomError('chat_mode_required', 'Switch to Chat mode.')
    }
    try {
      assertReady()
      const deadline = Date.now() + 25000
      const projectId = await ensureProjectTarget(
        document,
        request.projectName,
        this.until.bind(this),
        deadline,
        assertReady,
        request.projectId,
      )
      if (request.projectId && request.projectId !== projectId)
        throw new DomError('project_mismatch', 'The selected project identity changed.')
      const currentRoute = parseChatRoute(location.pathname)
      if (
        currentRoute?.conversationId !== request.conversationId ||
        (request.projectId && currentRoute.projectId !== request.projectId)
      ) {
        this.navigating = true
        this.send({
          type: 'navigate',
          requestId: request.requestId,
          conversationId: request.conversationId,
        })
        await this.events
        if (this.transport === 'websocket')
          await this.until(() => this.navigationReady.delete(request.requestId), Date.now() + 5000)
        assertReady()
        location.assign(conversationPath(request.conversationId, request.projectId))
        return
      }
      await moveConversationToProject(
        document,
        request.conversationId,
        request.projectName,
        projectId,
        assertReady,
        this.until.bind(this),
        deadline,
      )
      this.send({
        type: 'conversation_project',
        requestId: request.requestId,
        conversationId: request.conversationId,
        projectId,
      })
      this.setStatus('プロジェクトに集約しました')
    } catch (err) {
      this.navigating = false
      const error =
        err instanceof DomError
          ? err
          : new DomError(
              'project_move_failed',
              err instanceof Error ? err.message : 'Project move failed',
            )
      this.send({
        type: 'error',
        requestId: request.requestId,
        code: error.code,
        message: error.message,
      })
    } finally {
      this.active = null
    }
  }
  private async runDelete(request: Extract<BrowserRequest, { type: 'delete_conversation' }>) {
    if (this.active) {
      this.send({
        type: 'error',
        requestId: request.requestId,
        code: 'browser_busy',
        message: 'Another browser operation is running.',
      })
      return
    }
    this.active = request.requestId
    this.setStatus('会話を削除中')
    const deadline = Date.now() + 20000
    const targetPath = conversationPath(request.conversationId, request.projectId)
    const assertTarget = () => {
      if (parseChatRoute(location.pathname)?.conversationId !== request.conversationId)
        throw new DomError('conversation_changed', 'Refusing to delete a different conversation.')
    }
    const headerRoots = ['main', '[data-testid="app-shell-header-context-menu-surface"]']
    const HEADER_MORE_ROOTS = headerRoots.join(', ')
    const HEADER_MORE_BUTTONS = headerRoots.map((root) => `${root} button`).join(', ')
    const action = (root: ParentNode, selector: string, name: RegExp) => {
      const matches = [...root.querySelectorAll<HTMLElement>(selector)].filter(
        (node) =>
          isVisible(node) &&
          name.test((node.getAttribute('aria-label') ?? node.textContent ?? '').trim()),
      )
      return matches.length === 1 ? matches[0]! : null
    }
    let capturedEditor: HTMLElement | null = null
    const assertReady = (modalOpen = false) => {
      const editor = modalOpen ? capturedEditor : findEditor(document)
      if (!editor?.isConnected || editor.ownerDocument !== document)
        throw new DomError('editor_not_found', 'The message editor changed during deletion.')
      capturedEditor = editor
      assertNoManualAttachments(editor)
      if (
        (editor instanceof HTMLTextAreaElement ? editor.value : (editor.textContent ?? '')).trim()
      )
        throw new DomError('composer_not_empty', 'An unsent draft is present.')
      if (isGenerating(document))
        throw new DomError('browser_busy', 'ChatGPT is generating a response.')
      if (isWorkMode(document) || /^\/dots\//.test(location.pathname))
        throw new DomError(
          'chat_mode_required',
          'Switch to Chat mode before deleting a conversation.',
        )
    }
    try {
      assertReady()
      if (
        [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')].some(
          isVisible,
        )
      )
        throw new DomError(
          'browser_ui_busy',
          'Close the open menu or dialog before deleting a conversation.',
        )
      if (parseChatRoute(location.pathname)?.conversationId !== request.conversationId) {
        this.navigating = true
        this.send({
          type: 'navigate',
          requestId: request.requestId,
          conversationId: request.conversationId,
        })
        await this.events
        if (this.transport === 'websocket')
          await this.until(() => this.navigationReady.delete(request.requestId), Date.now() + 5000)
        assertReady()
        location.assign(targetPath)
        return
      }
      const picked = await this.until(() => {
        const row = conversationActions(document, request.conversationId)
        if (row) return { button: row, row: true }
        const header = action(document, HEADER_MORE_BUTTONS, /^(More|その他|その他の操作)$/)
        return header ? { button: header, row: false } : null
      }, deadline)
      const more = picked.button
      const assertAction = () => {
        assertTarget()
        const valid = picked.row
          ? conversationActionOwned(document, request.conversationId, more)
          : more.isConnected && !!more.closest(HEADER_MORE_ROOTS)
        if (!valid)
          throw new DomError(
            'conversation_changed',
            'The conversation action no longer belongs to the target conversation.',
          )
      }
      assertAction()
      assertReady()
      more.click()
      const remove = await this.until(
        () =>
          action(
            document,
            '[role="menu"] [role="menuitem"], [role="menu"] button',
            /^(Delete|削除|チャットを削除)$/,
          ),
        deadline,
      )
      assertAction()
      assertReady()
      remove.click()
      const dialog = await this.until(() => {
        const matches = [
          ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
        ].filter(isVisible)
        if (matches.length !== 1) return null
        const heading = matches[0]!.querySelector('h1, h2, h3, [role="heading"]')?.textContent ?? ''
        return /delete.*chat|チャット.*削除|会話.*削除/i.test(heading) ? matches[0]! : null
      }, deadline)
      const confirm = action(dialog, 'button', /^(Delete|削除|チャットを削除)$/)
      if (!confirm)
        throw new DomError(
          'delete_confirmation_unavailable',
          'The chat deletion confirmation could not be identified.',
        )
      assertAction()
      assertReady(true)
      this.deletedReceipt = null
      confirm.click()
      await this.until(
        () =>
          this.deletedReceipt === request.conversationId &&
          parseChatRoute(location.pathname)?.conversationId !== request.conversationId &&
          !dialog.isConnected &&
          !conversationRowLinks(document, request.conversationId).length,
        deadline,
      )
      this.send({
        type: 'conversation_deleted',
        requestId: request.requestId,
        conversationId: request.conversationId,
      })
      this.setStatus('会話を削除しました')
    } catch (err) {
      this.navigating = false
      const error =
        err instanceof DomError
          ? err
          : new DomError('browser_error', err instanceof Error ? err.message : 'Deletion failed')
      this.send({
        type: 'error',
        requestId: request.requestId,
        code: error.code,
        message: error.message,
      })
      this.setStatus(`${error.code}\n${error.message}`)
    } finally {
      this.active = null
    }
  }
  private connected() {
    return this.transport === 'http'
      ? this.httpConnected
      : this.socket?.readyState === WebSocket.OPEN
  }
  private httpRequest(path: string, data: unknown): Promise<unknown> {
    if (this.httpBridge) return this.httpBridge(path, data, this.browserId)
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('Tampermonkey GM_xmlhttpRequest permission is missing.'))
        return
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: `${HTTP_URL}/bridge/${path}`,
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Token': __BRIDGE_TOKEN__,
          'X-Browser-Id': this.browserId,
        },
        data: JSON.stringify(data),
        timeout: 4000,
        onload(response) {
          if (response.status !== 200) {
            reject(
              new Error(
                `Local HTTP bridge returned ${response.status}. Rebuild/reinstall if the pairing key changed.`,
              ),
            )
            return
          }
          try {
            resolve(JSON.parse(response.responseText) as unknown)
          } catch {
            reject(new Error('Invalid bridge JSON'))
          }
        },
        onerror: () => reject(new Error('Cannot connect to local server on 8766.')),
        ontimeout: () => reject(new Error('Local HTTP bridge timed out.')),
      })
    })
  }
  private safeToReload(): boolean {
    if (
      this.destroyed ||
      this.active ||
      this.navigating ||
      this.responseStream ||
      Date.now() - this.lastManualEdit < 5000 ||
      isGenerating(document) ||
      isWorkMode(document)
    )
      return false
    try {
      if (this.drafts.list().length) return false
      const editor = findEditor(document)
      assertNoManualAttachments(editor)
      if (readPlainDraft(editor) !== '') return false
      for (const node of document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], textarea, [contenteditable="true"]',
      ))
        if (node !== editor && isVisible(node)) return false
      return true
    } catch {
      return false
    }
  }
  private async reloadWhenSafe() {
    this.setStatus('拡張機能を更新しました。安全な状態でChatGPTを再読み込みします。')
    while (!this.destroyed) {
      if (this.safeToReload()) {
        this.stop()
        location.reload()
        return
      }
      await sleep(300)
    }
  }
  private async tryExtensionUpdate(value: unknown): Promise<boolean> {
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      typeof value.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(value.version)
    )
      return false
    try {
      const key = 'localgpt:update-attempt'
      if (sessionStorage.getItem(key) === value.version || !this.safeToReload()) return false
      const ready = await this.httpRequest('update-ready', { version: value.version })
      if (!ready || typeof ready !== 'object' || !('ready' in ready) || ready.ready !== true)
        return false
      // A person may have started typing while the server was granting the lease.
      if (!this.safeToReload()) return false
      sessionStorage.setItem(key, value.version)
      const result = await this.httpRequest('reload', { version: value.version })
      if (
        !result ||
        typeof result !== 'object' ||
        !('reloading' in result) ||
        result.reloading !== true
      )
        throw new Error('Extension reload was not confirmed')
      // Let the acknowledged worker reload finish before replacing the page observer.
      await sleep(450)
      await this.reloadWhenSafe()
      return true
    } catch {
      this.setStatus('拡張機能の再読み込みが必要です。入力欄は保持しています。')
      return false
    }
  }
  private async poll() {
    if (this.pollingStarted || this.destroyed) return
    this.pollingStarted = true
    this.transport = 'http'
    this.socket?.close()
    while (!this.destroyed) {
      try {
        if (this.navigating) {
          await sleep(100)
          continue
        }
        if (this.active) {
          await this.httpRequest('event', { type: 'heartbeat' })
          this.httpConnected = true
          this.responseStream?.wake?.()
          await sleep(700)
          continue
        }
        const value = await this.httpRequest('poll', {})
        if (this.navigating) continue
        this.httpConnected = true
        if (!this.active) this.setStatus('接続済み · HTTP 8766')
        if (typeof value !== 'object' || value === null || !('request' in value))
          throw new Error('Invalid poll response')
        if (value.request !== null) this.receive(value.request)
        else if ('update' in value && (await this.tryExtensionUpdate(value.update))) return
        await sleep(700)
      } catch (err) {
        this.httpConnected = false
        this.responseStream?.wake?.()
        this.setStatus(err instanceof Error ? err.message : 'Local HTTP connection error')
        if (
          this.httpBridge &&
          err instanceof Error &&
          /Extension context invalidated/i.test(err.message)
        ) {
          await this.reloadWhenSafe()
          return
        }
        await sleep(3000)
      }
    }
  }
  private receive(value: unknown) {
    const result = BrowserRequestSchema.safeParse(value)
    if (!result.success) {
      this.setStatus('invalid_server_message · データ形式が不正です')
      return
    }
    void this.run(result.data)
  }
  connect() {
    if (this.destroyed) return
    if (this.httpBridge) {
      void this.poll()
      return
    }
    this.setStatus('接続中 · 8875')
    try {
      this.socket = new WebSocket(`${WS_URL}&browserId=${encodeURIComponent(this.browserId)}`)
    } catch {
      void this.poll()
      return
    }
    const socket = this.socket
    const fallback = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) void this.poll()
    }, 2000)
    this.socket.onopen = () => {
      clearTimeout(fallback)
      this.setStatus('接続済み · 8875')
    }
    this.socket.onmessage = (event) => {
      let value: unknown
      try {
        value = JSON.parse(String(event.data))
      } catch {
        this.setStatus('invalid_server_message · JSONが不正です')
        return
      }
      this.receive(value)
    }
    this.socket.onerror = () => {
      clearTimeout(fallback)
      this.responseStream?.wake?.()
      void this.poll()
    }
    this.socket.onclose = () => {
      clearTimeout(fallback)
      this.responseStream?.wake?.()
      if (this.destroyed || this.transport === 'http') return
      this.setStatus('未接続 · 8875 / 再接続待ち')
      this.reconnect = setTimeout(() => this.connect(), 3000)
    }
  }
  stop() {
    this.destroyed = true
    window.removeEventListener('input', this.markManualEdit, true)
    window.removeEventListener('keydown', this.markManualEdit, true)
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.responseStream?.wake?.()
    if (this.reconnect) clearTimeout(this.reconnect)
    this.socket?.close()
  }
}
export function startBrowserApp(httpBridge?: HttpBridge) {
  if (location.hostname !== 'chatgpt.com') return
  if (document.getElementById('chatgpt-local-api-status')) return
  const app = new App(httpBridge)
  app.connect()
  window.addEventListener('pagehide', () => app.stop(), { once: true })
}
