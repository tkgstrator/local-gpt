import { attachFiles, assertNoManualAttachments } from './browser-files'
import { selectModel } from './model-selection'
import { DOT_EVENT, DotListSchema, dotMessages, findDotEditor, type Dot } from './dots'
import {
  TURN_EVENT,
  SubmittedTurnSchema,
  CAPABILITY_EVENT,
  CAPABILITY_REQUEST,
  CapabilitiesSchema,
  emptyCapabilities,
} from './capabilities'
import { BrowserRequestSchema, type BrowserEvent, type BrowserRequest } from './protocol'
import {
  DomError,
  userNodes,
  userTurn,
  findEditor,
  writeEditor,
  findSendButton,
  isGenerating,
  assistantNodes,
  readLatestAnswer,
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
const TIMEOUT_MS = 170000
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export type HttpBridge = (path: string, data: unknown, browserId: string) => Promise<unknown>
class App {
  private submittedReceipt: { messageId: string; conversationId: string | null } | null = null
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
  private reconnect: ReturnType<typeof setTimeout> | null = null
  constructor(private httpBridge?: HttpBridge) {
    window.addEventListener(TURN_EVENT, (event) => {
      try {
        const parsed = SubmittedTurnSchema.safeParse(
          JSON.parse((event as CustomEvent<string>).detail),
        )
        if (parsed.success) this.submittedReceipt = parsed.data
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
  }
  private setStatus(text: string) {
    this.status.textContent = `LocalGPT · ${text}`
  }
  private send(event: BrowserEvent) {
    if (this.transport === 'http') {
      this.events = this.events
        .then(async () => {
          await this.httpRequest('event', event)
        })
        .catch((err) => {
          this.httpConnected = false
          this.setStatus(err instanceof Error ? err.message : 'HTTP event failed')
        })
    } else if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event))
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
    if (request.type === 'navigation_ready') {
      this.navigationReady.add(request.requestId)
      return
    }
    if (request.type === 'dots') {
      await this.runDot(request)
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
    const deadline = Date.now() + TIMEOUT_MS
    try {
      const currentEditor = await this.until(
        () => {
          try {
            return findEditor(document)
          } catch {
            return null
          }
        },
        Math.min(deadline, Date.now() + 10000),
      )
      assertNoManualAttachments(currentEditor)
      const draft =
        currentEditor instanceof HTMLTextAreaElement
          ? currentEditor.value
          : currentEditor.textContent || ''
      if (draft.trim()) throw new DomError('composer_not_empty', 'An unsent draft is present.')
      if (isGenerating(document))
        throw new DomError('browser_busy', 'ChatGPT is already generating a response.')
      if (isWorkMode(document))
        throw new DomError(
          'chat_mode_required',
          'Switch ChatGPT to Chat mode before using LocalGPT.',
        )
      if (request.conversationId && location.pathname !== `/c/${request.conversationId}`) {
        this.navigating = true
        this.send({
          type: 'navigate',
          requestId: request.requestId,
          conversationId: request.conversationId,
        })
        await this.events
        if (this.transport === 'websocket')
          await this.until(() => this.navigationReady.delete(request.requestId), Date.now() + 5000)
        location.assign(`/c/${request.conversationId}`)
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
      if (
        (current instanceof HTMLTextAreaElement ? current.value : current.textContent || '').trim()
      )
        throw new DomError('composer_not_empty', 'An unsent draft is present.')
      if (
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
              const draft =
                editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent || ''
              return draft.trim() ? false : editor
            } catch {
              return false
            }
          },
          Math.min(deadline, Date.now() + 10000),
        )
      }
      let expectedPath = location.pathname
      let submittedTurn: HTMLElement | null = null
      const ownTurn = () =>
        userNodes(document).find(
          (node) => (node.innerText ?? node.textContent ?? '').trim() === request.text.trim(),
        ) ?? null
      const assertConversation = (allowNewConversation = false) => {
        if (location.pathname === expectedPath) return
        if (
          allowNewConversation &&
          !/^\/c\//.test(expectedPath) &&
          /^\/c\/[a-f0-9-]{36}$/.test(location.pathname)
        ) {
          const turn = this.submittedReceipt
            ? userTurn(document, this.submittedReceipt.messageId)
            : ownTurn()
          if (turn && submittedTurn && turn === submittedTurn) {
            submittedTurn = turn
            expectedPath = location.pathname
            return
          }
        }
        throw new DomError(
          'conversation_changed',
          'The ChatGPT conversation changed during the request.',
        )
      }
      if (request.model)
        await selectModel(document, this.capabilities, request.model, request.reasoning?.effort)
      else if (request.reasoning)
        throw new DomError('model_required', 'Specify a model ID when selecting reasoning effort.')
      assertConversation()
      const previous = new Set(assistantNodes(document))
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
      this.submittedReceipt = null
      // Poll immediately after sending; there is no load-event or observer-start race.
      send.click()
      // Capture synchronously, before another UI action can navigate to an old turn.
      submittedTurn = ownTurn()
      let lastText = ''
      let changedAt = Date.now()
      let sawGenerating = false
      let sentAnswer = false
      while (Date.now() < deadline) {
        if (this.destroyed || !this.connected())
          throw new DomError('browser_disconnected', 'Local server disconnected.')
        if (location.pathname === expectedPath && !submittedTurn) submittedTurn = ownTurn()
        if (
          location.pathname !== expectedPath &&
          !/^\/c\//.test(expectedPath) &&
          /^\/c\/[a-f0-9-]{36}$/.test(location.pathname) &&
          !submittedTurn
        ) {
          const arrivalPath = location.pathname
          try {
            submittedTurn = await this.until(() => {
              if (location.pathname !== arrivalPath)
                throw new DomError(
                  'conversation_changed',
                  'Conversation changed before submission was identified.',
                )
              const receipt = this.submittedReceipt
              if (
                !receipt ||
                (receipt.conversationId && arrivalPath !== `/c/${receipt.conversationId}`)
              )
                return null
              return userTurn(document, receipt.messageId)
            }, Date.now() + 2000)
          } catch {
            throw new DomError(
              'conversation_changed',
              'The submitted message could not be identified in this conversation.',
            )
          }
        }
        assertConversation(true)
        const generating = isGenerating(document)
        sawGenerating ||= generating
        const lastNode = assistantNodes(document).at(-1)
        if (lastNode && !previous.has(lastNode)) {
          const text = readLatestAnswer(document)
          if (text !== lastText) {
            lastText = text
            changedAt = Date.now()
            this.send({ type: 'answer', requestId: request.requestId, text })
            sentAnswer = true
          }
          const settledMs = sawGenerating ? 800 : 2500
          if (sentAnswer && !generating && Date.now() - changedAt >= settledMs) {
            const conversationId = location.pathname.match(/^\/c\/([a-f0-9-]{36})$/)?.[1]
            this.send({
              type: 'stop',
              requestId: request.requestId,
              ...(conversationId ? { conversationId } : {}),
            })
            this.setStatus('接続済み · 完了')
            return
          }
        }
        await sleep(150)
      }
      throw new DomError(
        'browser_timeout',
        'No completed ChatGPT response arrived before the timeout.',
      )
    } catch (err) {
      this.navigating = false
      const error =
        err instanceof DomError
          ? err
          : new DomError(
              'browser_error',
              err instanceof Error ? err.message : 'Unknown browser error',
            )
      this.send({
        type: 'error',
        requestId: request.requestId,
        code: error.code,
        message: error.message,
      })
      this.setStatus(`${error.code}\n${error.message}`)
      console.error('[LocalGPT]', error.code, error.message)
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
        await sleep(700)
      } catch (err) {
        this.httpConnected = false
        this.setStatus(err instanceof Error ? err.message : 'Local HTTP connection error')
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
      void this.poll()
    }
    this.socket.onclose = () => {
      clearTimeout(fallback)
      if (this.destroyed || this.transport === 'http') return
      this.setStatus('未接続 · 8875 / 再接続待ち')
      this.reconnect = setTimeout(() => this.connect(), 3000)
    }
  }
  stop() {
    this.destroyed = true
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
