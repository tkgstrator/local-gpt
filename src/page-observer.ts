import { installNativeModelSelection } from './model-selection'
import { DEFAULT_GENERATION_TIMEOUT_MS, PROGRESS_IDLE_TIMEOUT_MS } from './timeouts'
import {
  boundedConversationSnapshot,
  conversationFinalOutput,
  readConversationGraph,
} from './conversation-recovery'
import type { NativeChatDispatcher } from './native-chat'
import { ProjectIdSchema, parseChatRoute } from './projects'
import {
  PROJECT_CHECK_EVENT,
  PROJECT_ARM_EVENT,
  PROJECT_EVENT,
  ProjectReceiptSchema,
} from './browser-projects'
import {
  ImageDownloadUrlSchema,
  ImageFileIdSchema,
  ImageMimeSchema,
  MAX_IMAGE_BYTES,
  type ImageData,
} from './generated-image-protocol'
import {
  STREAM_ARM_EVENT,
  STREAM_EVENT,
  StreamArmSchema,
  observeConversationResponse,
  type StreamIdentity,
  type StreamEvent,
} from './conversation-stream'
import { DOT_EVENT, normalizeDots } from './dots'
import {
  CONVERSATION_DELETED_EVENT,
  ConversationDeletedSchema,
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
// Authentication and same-origin native download URLs stay private. Only validated signed CDN URLs
// or bounded image bytes are exported through the existing sanitized image events.
type PageWindow = Pick<
  Window,
  'location' | 'document' | 'setTimeout' | 'clearTimeout' | 'dispatchEvent' | 'addEventListener'
> & {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  CustomEvent: typeof CustomEvent
  URL: typeof URL
  Headers: typeof Headers
  Request: typeof Request
}
// Match native editor line endings/outer ASCII whitespace without merging distinct internal text.
const submittedText = (text: string) =>
  text.replace(/\r\n?/g, '\n').replace(/^[ \t\n]+|[ \t\n]+$/g, '')

export function installPageObserver(
  page: PageWindow,
  nativeRecovery?: Pick<NativeChatDispatcher, 'readConversationSnapshot'>,
) {
  installNativeModelSelection(page)
  type ImageScope = {
    observerAbort?: AbortController
    identity: StreamIdentity
    refs: Set<string>
    downloads: Map<string, { url: string; conversationId: string | null }>
    nativeImages: Map<string, ImageData>
    nativeDownloads: Map<string, { url: string; headers: Headers; conversationId: string | null }>
    fetching: Map<string, Promise<void>>
    capturing: Map<string, Promise<void>>
    metadataPending: Map<string, Promise<void>>
    sent: Set<string>
    expires: number
    recoveryDeadline?: number
    holdImages: boolean
    failed: boolean
  }
  let imageScope: ImageScope | null = null
  const nativeScopes = new Map<string, ImageScope>()
  const scopeOwned = (scope: ImageScope) =>
    scope === imageScope || nativeScopes.get(scope.identity.requestId) === scope
  const publishStream = (event: StreamEvent) =>
    page.dispatchEvent(new page.CustomEvent(STREAM_EVENT, { detail: JSON.stringify(event) }))
  const scopeActive = (scope: ImageScope, cid = scope.identity.conversationId) =>
    scopeOwned(scope) &&
    !scope.failed &&
    page.location.origin === 'https://chatgpt.com' &&
    Date.now() < Math.min(scope.expires, scope.recoveryDeadline ?? Number.MAX_SAFE_INTEGER) &&
    scope.identity.conversationId === cid
  // Passive observation owns a clone, never the native request or its consumer.
  const observePassive = (scope: ImageScope, work: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController(),
      limit = Date.now() + 15000
    let timer: ReturnType<typeof page.setTimeout> | undefined
    const aborted = new Promise<void>((resolve) =>
      controller.signal.addEventListener('abort', () => resolve(), { once: true }),
    )
    const check = () => {
      if (controller.signal.aborted) return
      if (!scopeActive(scope) || Date.now() >= limit) {
        controller.abort()
        return
      }
      timer = page.setTimeout(
        check,
        Math.min(
          100,
          Math.max(1, limit - Date.now()),
          Math.max(
            1,
            Math.min(scope.expires, scope.recoveryDeadline ?? scope.expires) - Date.now(),
          ),
        ),
      )
    }
    check()
    return Promise.race([work(controller.signal).catch(() => {}), aborted]).finally(() => {
      if (timer !== undefined) page.clearTimeout(timer)
      controller.abort()
    })
  }
  const publishImages = (scope: ImageScope) => {
    if (!scopeActive(scope) || scope.holdImages || !scope.identity.conversationId) return
    for (const fileId of scope.refs) {
      if (!scopeActive(scope) || scope.holdImages) return
      fetchNativeImage(scope, fileId)
      const native = scope.nativeImages.get(fileId)
      if (native && !scope.sent.has(fileId)) {
        scope.sent.add(fileId)
        publishStream({ ...scope.identity, kind: 'image', fileId, imageData: native })
        continue
      }
      const download = scope.downloads.get(fileId)
      if (
        !download ||
        scope.sent.has(fileId) ||
        (download.conversationId && download.conversationId !== scope.identity.conversationId)
      )
        continue
      scope.sent.add(fileId)
      publishStream({ ...scope.identity, kind: 'image', fileId, downloadUrl: download.url })
    }
  }
  const memberships = new Map<string, string>()
  let projectCheck: { conversationId: string; projectId: string; expires: number } | null = null
  const rememberProject = (cid: string, pid: string) => {
    memberships.delete(cid)
    memberships.set(cid, pid)
    if (memberships.size > 32) memberships.delete(memberships.keys().next().value!)
    if (
      projectCheck &&
      Date.now() < projectCheck.expires &&
      projectCheck.conversationId === cid &&
      projectCheck.projectId === pid
    ) {
      projectCheck = null
      page.dispatchEvent(
        new page.CustomEvent(PROJECT_EVENT, {
          detail: JSON.stringify({ conversationId: cid, projectId: pid }),
        }),
      )
    }
  }
  page.addEventListener(PROJECT_CHECK_EVENT, (event) => {
    try {
      const value = ProjectReceiptSchema.safeParse(
        JSON.parse((event as CustomEvent<string>).detail),
      )
      if (value.success) projectCheck = { ...value.data, expires: Date.now() + 30000 }
      if (value.success && memberships.get(value.data.conversationId) === value.data.projectId) {
        projectCheck = null
        page.dispatchEvent(
          new page.CustomEvent(PROJECT_EVENT, { detail: JSON.stringify(value.data) }),
        )
      }
    } catch {}
  })
  let projectArm: { conversationId: string; projectId: string; expires: number } | null = null
  page.addEventListener(PROJECT_ARM_EVENT, (event) => {
    try {
      const parsed = ProjectReceiptSchema.safeParse(
        JSON.parse((event as CustomEvent<string>).detail),
      )
      if (parsed.success) projectArm = { ...parsed.data, expires: Date.now() + 30000 }
    } catch {}
  })
  page.addEventListener('localgpt:project-disarm', () => {
    projectArm = null
    projectCheck = null
  })
  type Arm = ReturnType<typeof StreamArmSchema.parse>
  let armed: Arm | null = null
  const nativeArms = new Map<string, Arm>()
  page.addEventListener(STREAM_ARM_EVENT, (event) => {
    try {
      const parsed = StreamArmSchema.safeParse(JSON.parse((event as CustomEvent<string>).detail))
      if (!parsed.success) return
      if (parsed.data.native) {
        if (
          nativeArms.has(parsed.data.requestId) ||
          nativeScopes.has(parsed.data.requestId) ||
          [...nativeArms.values()].some(
            (a) => a.nativeUserMessageId === parsed.data.nativeUserMessageId,
          ) ||
          [...nativeScopes.values()].some(
            (a) => a.identity.nativeUserMessageId === parsed.data.nativeUserMessageId,
          )
        )
          return
        nativeArms.set(parsed.data.requestId, parsed.data)
      } else {
        armed = parsed.data
        imageScope = null
      }
    } catch {}
  })
  page.addEventListener('localgpt:stream-disarm', (event) => {
    const id = (event as CustomEvent<string>).detail
    if (id === armed?.requestId) armed = null
    if (id === imageScope?.identity.requestId) {
      imageScope.observerAbort?.abort()
      imageScope = null
    }
    nativeArms.delete(id)
    nativeScopes.get(id)?.observerAbort?.abort()
    nativeScopes.delete(id)
  })
  page.addEventListener('localgpt:native-result', (event) => {
    try {
      const receipt = JSON.parse((event as CustomEvent<string>).detail)
      if (receipt.kind !== 'identity') return
      const arm = nativeArms.get(receipt.requestId)
      const scope = nativeScopes.get(receipt.requestId)
      if (
        receipt.nativeUserMessageId !==
        (arm?.nativeUserMessageId ?? scope?.identity.nativeUserMessageId)
      )
        return
      const parsed = SubmittedTurnSchema.safeParse({
        messageId: receipt.nativeUserMessageId,
        conversationId: receipt.conversationId,
      })
      if (!parsed.success || !parsed.data.conversationId) return
      const expected =
        arm?.conversationId ?? arm?.serverConversationId ?? scope?.identity.conversationId
      if (expected && expected !== parsed.data.conversationId) return
      if (arm) arm.conversationId = parsed.data.conversationId
      if (scope) scope.identity.conversationId = parsed.data.conversationId
    } catch {}
  })
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
  const captureNativeImage = (
    scope: ImageScope,
    fileId: string,
    response: Response,
    owned = false,
  ): Promise<void> => {
    const pending = scope.capturing.get(fileId)
    if (pending || scope.nativeImages.has(fileId) || !scopeActive(scope)) {
      return (async () => {
        if (owned) await response.body?.cancel().catch(() => {})
        await pending
      })()
    }
    const cid = scope.identity.conversationId
    const captureActive = () =>
      scopeActive(scope) && (!cid || scope.identity.conversationId === cid)
    const collect = async (signal?: AbortSignal) => {
      if (signal?.aborted || !captureActive()) return
      const source = owned ? response : response.clone()
      const mimeType = ImageMimeSchema.safeParse(
        response.headers.get('content-type')?.split(';')[0]?.trim(),
      )
      const reader = source.body?.getReader()
      if (!reader) return
      const cancel = () => {
        void reader.cancel().catch(() => {})
      }
      signal?.addEventListener('abort', cancel, { once: true })
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        if (
          !response.ok ||
          !mimeType.success ||
          Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES
        )
          return
        for (;;) {
          const { done, value } = await reader.read()
          if (signal?.aborted || !captureActive()) return
          if (done) break
          size += value.byteLength
          if (size > MAX_IMAGE_BYTES) return
          chunks.push(value)
        }
        if (!size || signal?.aborted || !captureActive()) return
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
        let binary = ''
        for (let i = 0; i < bytes.length; i += 32768)
          binary += String.fromCharCode(...bytes.subarray(i, i + 32768))
        scope.nativeImages.set(fileId, { mimeType: mimeType.data, data: btoa(binary) })
        const unmatched = [...scope.nativeImages.keys()].filter((id) => !scope.refs.has(id))
        for (const id of unmatched.slice(0, Math.max(0, unmatched.length - 8)))
          scope.nativeImages.delete(id)
        publishImages(scope)
      } finally {
        signal?.removeEventListener('abort', cancel)
        const cancelling = reader.cancel().catch(() => {})
        if (owned) await cancelling
        reader.releaseLock()
      }
    }
    const task = (owned ? collect() : observePassive(scope, collect)).finally(() => {
      if (scope.capturing.get(fileId) === task) scope.capturing.delete(fileId)
    })
    scope.capturing.set(fileId, task)
    return task
  }
  const fetchNativeImage = (scope: ImageScope, fileId: string) => {
    const download = scope.nativeDownloads.get(fileId)
    if (
      !download ||
      !scope.refs.has(fileId) ||
      !scope.identity.conversationId ||
      (download.conversationId && download.conversationId !== scope.identity.conversationId) ||
      scope.sent.has(fileId) ||
      scope.nativeImages.has(fileId) ||
      scope.fetching.has(fileId) ||
      scope.capturing.has(fileId) ||
      scope.fetching.size >= 4 ||
      !scopeActive(scope)
    )
      return
    const cid = scope.identity.conversationId
    const invalidateDownload = () => {
      if (scope.nativeDownloads.get(fileId) === download) scope.nativeDownloads.delete(fileId)
    }
    const task = original
      .call(page, download.url, {
        method: 'GET',
        headers: download.headers,
        credentials: 'include',
        redirect: 'error',
        signal: AbortSignal.timeout(
          Math.min(
            15000,
            Math.max(
              1,
              Math.min(scope.expires, scope.recoveryDeadline ?? scope.expires) - Date.now(),
            ),
          ),
        ),
      })
      .then(async (response) => {
        if (!scopeActive(scope, cid)) {
          await response.body?.cancel().catch(() => {})
          return
        }
        await captureNativeImage(scope, fileId, response, true)
        if (!scope.nativeImages.has(fileId)) invalidateDownload()
      })
      .catch(() => {
        invalidateDownload()
      })
      .finally(() => {
        scope.fetching.delete(fileId)
      })
    scope.fetching.set(fileId, task)
  }
  const privateHeaders = (source: HeadersInit | undefined) => {
    const native = new page.Headers(source),
      headers = new page.Headers()
    for (const name of ['authorization', 'chatgpt-account-id']) {
      const value = native.get(name)
      if (value) headers.set(name, value)
    }
    return headers
  }
  const captureImageDownload = async (
    scope: ImageScope,
    fileId: string,
    cid: string | null,
    response: Response,
    headers: Headers,
    passiveSignal?: AbortSignal,
  ) => {
    const value = await readConversationGraph(response, 100000, {
      awaitCancellation: !passiveSignal,
      signal: passiveSignal,
    })
    if (
      passiveSignal?.aborted ||
      !scopeActive(scope) ||
      (cid && scope.identity.conversationId && cid !== scope.identity.conversationId) ||
      !value ||
      typeof value !== 'object' ||
      !('download_url' in value) ||
      typeof value.download_url !== 'string'
    )
      return
    const signed = ImageDownloadUrlSchema.safeParse(value.download_url)
    if (signed.success) scope.downloads.set(fileId, { url: signed.data, conversationId: cid })
    else {
      let native: URL
      try {
        native = new URL(value.download_url, 'https://chatgpt.com')
      } catch {
        return
      }
      if (
        native.origin !== 'https://chatgpt.com' ||
        native.username ||
        native.password ||
        native.pathname !== '/backend-api/estuary/content' ||
        native.searchParams.getAll('id').length !== 1 ||
        native.searchParams.get('id') !== fileId
      )
        return
      scope.nativeDownloads.set(fileId, { url: native.href, headers, conversationId: cid })
    }
    for (const cache of [scope.downloads, scope.nativeDownloads]) {
      const unmatched = [...cache.keys()].filter((id) => !scope.refs.has(id))
      for (const id of unmatched.slice(0, Math.max(0, unmatched.length - 8))) cache.delete(id)
    }
    publishImages(scope)
  }
  const resolveRecoveredImage = async (
    scope: ImageScope,
    fileId: string,
    cid: string,
    headers: Headers,
  ) => {
    if (!scopeActive(scope, cid)) return false
    await scope.capturing.get(fileId)
    if (!scopeActive(scope, cid)) return false
    await scope.metadataPending.get(fileId)
    if (!scopeActive(scope, cid)) return false
    for (const cache of [scope.downloads, scope.nativeDownloads]) {
      const entry = cache.get(fileId)
      if (entry?.conversationId && entry.conversationId !== cid) cache.delete(fileId)
    }
    if (
      !scope.sent.has(fileId) &&
      !scope.nativeImages.has(fileId) &&
      !scope.downloads.has(fileId) &&
      !scope.nativeDownloads.has(fileId)
    ) {
      const task = original
        .call(
          page,
          `https://chatgpt.com/backend-api/files/download/${fileId}?conversation_id=${cid}`,
          {
            method: 'GET',
            headers,
            credentials: 'include',
            redirect: 'error',
            signal: AbortSignal.timeout(
              Math.min(15000, Math.max(1, (scope.recoveryDeadline ?? scope.expires) - Date.now())),
            ),
          },
        )
        .then(async (response) => {
          if (!scopeActive(scope, cid)) {
            await response.body?.cancel().catch(() => {})
            return
          }
          await captureImageDownload(scope, fileId, cid, response, headers)
        })
        .catch(() => {})
        .finally(() => {
          scope.metadataPending.delete(fileId)
        })
      scope.metadataPending.set(fileId, task)
      await task
      if (!scopeActive(scope, cid)) return false
    }
    publishImages(scope)
    await scope.fetching.get(fileId)
    if (!scopeActive(scope, cid)) return false
    await scope.capturing.get(fileId)
    if (!scopeActive(scope, cid)) return false
    return scope.sent.has(fileId)
  }
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
        (url.pathname === '/backend-api/f/conversation' ||
          /^\/backend-api\/conversation\/[a-f0-9-]{36}$/.test(url.pathname)) &&
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
            gizmo_id?: unknown
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
            const selectedArm =
              [...nativeArms.values()].find(
                (a) => a.nativeUserMessageId === parsed.data.messageId,
              ) ?? armed
            if (
              selectedArm &&
              (selectedArm.native ||
                (Array.isArray(message?.content?.parts) &&
                  submittedText(
                    message.content.parts.filter((part) => typeof part === 'string').join(''),
                  ) === submittedText(selectedArm.text)))
            ) {
              const arm = selectedArm
              const requestId = arm.requestId
              const expectedProject = arm.projectId
              const expectedNewChat = arm.newChat
              const timeoutMs = arm.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS
              const backgroundJob = arm.backgroundJob === true
              const observedProject = ProjectIdSchema.safeParse(value.gizmo_id)
              if (arm.native) nativeArms.delete(requestId)
              else armed = null
              const expectedCid = arm.conversationId ?? arm.serverConversationId
              if (arm.native && expectedCid && expectedCid !== parsed.data.conversationId) {
                publishStream({
                  requestId,
                  ...parsed.data,
                  nativeUserMessageId: arm.nativeUserMessageId,
                  kind: 'error',
                  code: 'conversation_changed',
                })
                return
              }
              if (expectedNewChat && value.conversation_id != null) {
                publishStream({
                  requestId,
                  ...parsed.data,
                  kind: 'error',
                  code: 'conversation_changed',
                })
                return
              }
              if (
                expectedProject &&
                (!observedProject.success || observedProject.data !== expectedProject)
              ) {
                publishStream({
                  requestId,
                  ...parsed.data,
                  kind: 'error',
                  code: 'project_mismatch',
                })
                return
              }
              const identity: StreamIdentity = {
                requestId,
                ...parsed.data,
                ...(arm.native ? { nativeUserMessageId: arm.nativeUserMessageId } : {}),
                ...(observedProject.success ? { projectId: observedProject.data } : {}),
              }
              const scope: ImageScope = {
                identity,
                refs: new Set(),
                downloads: new Map(),
                nativeImages: new Map(),
                nativeDownloads: new Map(),
                fetching: new Map(),
                capturing: new Map(),
                metadataPending: new Map(),
                sent: new Set(),
                expires: backgroundJob ? Number.MAX_SAFE_INTEGER : Date.now() + timeoutMs + 5000,
                holdImages: false,
                failed: false,
                observerAbort: new AbortController(),
              }
              if (arm.native) nativeScopes.set(requestId, scope)
              else imageScope = scope
              let observedConversationId: string | null = null
              let observedText = ''
              const observedNodes = new Set<string>()
              let recovering = false
              let terminal = false
              // Native graphs use the owned authenticated SDK loader; image reads
              // never replay completion tokens. Legacy recovery keeps its headers.
              const recoveryHeaders = arm.native
                ? new page.Headers()
                : privateHeaders(
                    init?.headers ?? (input instanceof page.Request ? input.headers : undefined),
                  )
              const recover = async () => {
                const deadline = backgroundJob ? scope.expires : scope.expires - 5000
                scope.recoveryDeadline = deadline
                while (!terminal && Date.now() < deadline) {
                  if (
                    !scopeOwned(scope) ||
                    Date.now() > scope.expires ||
                    page.location.origin !== 'https://chatgpt.com'
                  )
                    return
                  const route = parseChatRoute(page.location.pathname)
                  const cid =
                    observedConversationId ??
                    (arm.native
                      ? identity.conversationId
                      : !route?.provisionalId
                        ? route?.conversationId
                        : null) ??
                    null
                  if (cid && (!identity.conversationId || identity.conversationId === cid)) {
                    try {
                      let graph: unknown
                      if (arm.native) {
                        if (!nativeRecovery || !identity.nativeUserMessageId) return
                        graph = boundedConversationSnapshot(
                          await nativeRecovery.readConversationSnapshot(
                            requestId,
                            identity.nativeUserMessageId,
                            cid,
                          ),
                        )
                      } else {
                        const response = await original.call(
                          page,
                          `https://chatgpt.com/backend-api/conversation/${cid}`,
                          {
                            method: 'GET',
                            headers: recoveryHeaders,
                            credentials: 'include',
                            redirect: 'error',
                            signal: AbortSignal.timeout(
                              Math.min(15000, Math.max(1, deadline - Date.now())),
                            ),
                          },
                        )
                        if (!scopeActive(scope)) {
                          await response.body?.cancel().catch(() => {})
                          return
                        }
                        graph = await readConversationGraph(response)
                      }
                      if (terminal || !scopeActive(scope)) return
                      const output = conversationFinalOutput(graph, cid, identity.messageId, {
                        native: arm.native,
                        text: observedText,
                        fileIds: scope.refs,
                        messageIds: observedNodes,
                      })
                      if (terminal || !scopeActive(scope)) return
                      if (output && 'error' in output) {
                        publish({
                          ...identity,
                          conversationId: cid,
                          kind: 'error',
                          code: output.error,
                          ...(arm.native ? { terminalEvidence: true as const } : {}),
                        })
                        return
                      }
                      if (output) {
                        identity.conversationId = cid
                        scope.holdImages = true
                        for (const fileId of output.fileIds) {
                          if (!scope.refs.has(fileId))
                            publish({ ...identity, kind: 'image_ref', fileId })
                        }
                        scope.holdImages = false
                        let resolved = true
                        for (const fileId of output.fileIds) {
                          if (!(await resolveRecoveredImage(scope, fileId, cid, recoveryHeaders))) {
                            resolved = false
                            break
                          }
                          if (!scopeActive(scope, cid)) return
                        }
                        if (!scopeActive(scope, cid)) return
                        if (!resolved) {
                          await new Promise<void>((resolve) =>
                            page.setTimeout(
                              resolve,
                              Math.min(5000, Math.max(1, deadline - Date.now())),
                            ),
                          )
                          continue
                        }
                        if (output.text.trim())
                          publish({ ...identity, kind: 'answer', text: output.text })
                        publish({
                          ...identity,
                          conversationId: cid,
                          kind: 'stop',
                          ...(arm.native ? { terminalEvidence: true as const } : {}),
                        })
                        return
                      }
                    } catch {}
                  }
                  await new Promise<void>((resolve) =>
                    page.setTimeout(resolve, Math.min(5000, Math.max(1, deadline - Date.now()))),
                  )
                }
              }
              let stopHeaderWatch = () => {}
              const publish = (event: StreamEvent) => {
                if (!scopeOwned(scope) || scope.failed || terminal) return
                if (
                  arm.native &&
                  event.conversationId &&
                  identity.conversationId &&
                  event.conversationId !== identity.conversationId
                ) {
                  scope.failed = true
                  stopHeaderWatch()
                  publishStream({ ...identity, kind: 'error', code: 'conversation_changed' })
                  return
                }
                if (
                  arm.native &&
                  event.kind === 'progress' &&
                  event.phase === 'unresponsive' &&
                  !recovering
                ) {
                  recovering = true
                  void recover()
                }
                if (event.kind === 'stop' || (event.kind === 'error' && event.terminalEvidence)) {
                  terminal = true
                  stopHeaderWatch()
                }
                if (event.kind === 'answer') observedText = event.text ?? observedText
                if (
                  event.kind === 'error' &&
                  ((arm.native && !event.terminalEvidence) ||
                    [
                      'unsupported_response_stream',
                      'unsupported_response_content',
                      'response_incomplete',
                      'response_stream_interrupted',
                      'response_stream_timeout',
                      'response_stream_too_large',
                      'unsupported_image_asset',
                      'too_many_generated_images',
                    ].includes(event.code ?? ''))
                ) {
                  publishStream({
                    ...event,
                    kind: 'progress',
                    code: undefined,
                    phase: 'unresponsive',
                  })
                  if (!recovering) {
                    recovering = true
                    void recover()
                  }
                  return
                }
                if (event.conversationId) scope.identity.conversationId = event.conversationId
                if (event.kind === 'error') scope.failed = true
                if (event.kind === 'image_ref' && event.fileId) scope.refs.add(event.fileId)
                if (event.kind === 'stop' && event.conversationId && identity.projectId)
                  rememberProject(event.conversationId, identity.projectId)
                publishStream(event)
                publishImages(scope)
              }
              publish({ ...identity, kind: 'started' })
              // Native POSTs whose headers never arrive have no body idle monitor yet:
              // publish unresponsive once so the guarded exact UID-CID recovery starts.
              let headersSettled = false
              let headerWatch: ReturnType<typeof page.setTimeout> | undefined
              stopHeaderWatch = () => {
                headersSettled = true
                if (headerWatch !== undefined) page.clearTimeout(headerWatch)
                headerWatch = undefined
                scope.observerAbort?.signal.removeEventListener('abort', stopHeaderWatch)
              }
              if (arm.native) {
                scope.observerAbort?.signal.addEventListener('abort', stopHeaderWatch, {
                  once: true,
                })
                const headerStart = Date.now()
                const tick = () => {
                  headerWatch = undefined
                  if (
                    headersSettled ||
                    terminal ||
                    recovering ||
                    scope.failed ||
                    scope.observerAbort?.signal.aborted ||
                    !scopeOwned(scope) ||
                    Date.now() > scope.expires
                  ) {
                    stopHeaderWatch()
                    return
                  }
                  if (Date.now() - headerStart >= PROGRESS_IDLE_TIMEOUT_MS) {
                    publish({ ...identity, kind: 'progress', phase: 'unresponsive' })
                    return
                  }
                  headerWatch = page.setTimeout(tick, 1000)
                }
                headerWatch = page.setTimeout(tick, 1000)
              }
              void result
                .then((response) => {
                  stopHeaderWatch()
                  if (
                    arm.native &&
                    (terminal ||
                      scope.failed ||
                      !scopeOwned(scope) ||
                      scope.observerAbort?.signal.aborted ||
                      Date.now() > scope.expires)
                  )
                    return
                  return observeConversationResponse(response.clone(), identity, publish, {
                    timeoutMs,
                    backgroundJob,
                    signal: scope.observerAbort?.signal,
                    onConversationId: (cid) => {
                      observedConversationId = cid
                    },
                    onOutputNode: (id) => {
                      observedNodes.add(id)
                    },
                  })
                })
                .catch(() => {
                  stopHeaderWatch()
                  publish({
                    ...identity,
                    kind: 'error',
                    code: 'response_stream_interrupted',
                  })
                })
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
    const fileDownload =
      url.origin === 'https://chatgpt.com'
        ? /^\/backend-api\/files\/download\/(file[_-][a-zA-Z0-9_-]+)$/.exec(url.pathname)
        : null
    const eligible = [...nativeScopes.values()].filter((s) => scopeActive(s))
    const passiveFile =
      fileDownload?.[1] ??
      (url.pathname === '/backend-api/estuary/content' ? url.searchParams.get('id') : null)
    const passiveCid = url.searchParams.get('conversation_id')
    const matches = eligible.filter(
      (s) =>
        passiveFile &&
        s.refs.has(passiveFile) &&
        (!passiveCid || passiveCid === s.identity.conversationId),
    )
    const scope = matches.length === 1 ? matches[0] : matches.length ? null : imageScope
    if (fileDownload && scope && Date.now() < scope.expires) {
      const fileId = ImageFileIdSchema.safeParse(fileDownload[1])
      const conversationId = url.searchParams.get('conversation_id')
      if (fileId.success && !scope.metadataPending.has(fileId.data)) {
        const headers = scope.identity.nativeUserMessageId
          ? new page.Headers()
          : privateHeaders(
              init?.headers ?? (input instanceof page.Request ? input.headers : undefined),
            )
        const task = observePassive(scope, async (signal) => {
          const response = await result
          if (signal.aborted || !scopeActive(scope)) return
          await captureImageDownload(
            scope,
            fileId.data,
            conversationId,
            response.clone(),
            headers,
            signal,
          )
        }).finally(() => {
          if (scope.metadataPending.get(fileId.data) === task)
            scope.metadataPending.delete(fileId.data)
        })
        scope.metadataPending.set(fileId.data, task)
      }
    }
    if (
      scope &&
      url.origin === 'https://chatgpt.com' &&
      url.pathname === '/backend-api/estuary/content'
    ) {
      const fileId = ImageFileIdSchema.safeParse(url.searchParams.get('id'))
      if (
        fileId.success &&
        url.searchParams.getAll('id').length === 1 &&
        Date.now() < scope.expires
      )
        void result
          .then((response) => captureNativeImage(scope, fileId.data, response))
          .catch(() => {})
    }

    const deletionMatch =
      url.origin === 'https://chatgpt.com'
        ? /^\/backend-api\/conversation\/(id\/)?([a-f0-9-]{36})$/.exec(url.pathname)
        : undefined
    const deletionId = deletionMatch?.[2]
    if (deletionId) {
      const method = (
        init?.method ?? (input instanceof page.Request ? input.method : 'GET')
      ).toUpperCase()
      if (deletionMatch?.[1] && method !== 'DELETE') return result
      const body =
        typeof init?.body === 'string'
          ? Promise.resolve(init.body)
          : observedRequest
            ? observedRequest.text()
            : Promise.resolve('')
      if (method === 'GET')
        void result
          .then(async (response) => {
            if (!response.ok || !response.headers.get('content-type')?.includes('json')) return
            const reader = response.clone().body?.getReader()
            if (!reader) return
            let text = '',
              size = 0
            const decoder = new TextDecoder()
            try {
              for (;;) {
                const chunk = await reader.read()
                if (chunk.done) break
                size += chunk.value.byteLength
                if (size > 8_000_000) return
                text += decoder.decode(chunk.value, { stream: true })
              }
              text += decoder.decode()
              const value = JSON.parse(text) as { gizmo_id?: unknown }
              const receipt = ProjectReceiptSchema.safeParse({
                conversationId: deletionId,
                projectId: value.gizmo_id,
              })
              if (receipt.success)
                rememberProject(receipt.data.conversationId, receipt.data.projectId)
              else memberships.delete(deletionId)
            } finally {
              void reader.cancel().catch(() => {})
              reader.releaseLock()
            }
          })
          .catch(() => {})
      void Promise.all([result, body])
        .then(([response, text]) => {
          if (!response.ok) return
          if (method !== 'DELETE') {
            if (method !== 'PATCH' || text.length > 10000) return
            const value = JSON.parse(text) as {
              is_visible?: unknown
              is_archived?: unknown
              gizmo_id?: unknown
            }
            const parsedProject = ProjectIdSchema.safeParse(value.gizmo_id)
            if (parsedProject.success) rememberProject(deletionId, parsedProject.data)
            else if ('gizmo_id' in value) memberships.delete(deletionId)
            const moving = projectArm
            if (
              moving &&
              Date.now() < moving.expires &&
              moving.conversationId === deletionId &&
              value.gizmo_id === moving.projectId
            ) {
              page.dispatchEvent(
                new page.CustomEvent(PROJECT_EVENT, {
                  detail: JSON.stringify({
                    conversationId: deletionId,
                    projectId: moving.projectId,
                  }),
                }),
              )
              projectArm = null
              return
            }
            if (value.is_visible !== false || value.is_archived === true) return
          }
          memberships.delete(deletionId)
          const parsed = ConversationDeletedSchema.safeParse({ conversationId: deletionId })
          if (parsed.success)
            page.dispatchEvent(
              new page.CustomEvent(CONVERSATION_DELETED_EVENT, {
                detail: JSON.stringify(parsed.data),
              }),
            )
        })
        .catch(() => {
          /* Observation must never break ChatGPT. */
        })
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
