import { z } from 'zod'
import { ProjectIdSchema } from './projects'
import { BrowserRequestSchema, type BrowserRequest } from './protocol'
import type { BrowserFile } from './attachment-protocol'
import { discoverVerifiedNativeContract } from './native-client-adapter'
import { observeNativeAssets } from './native-assets'

export const NATIVE_REQUEST_EVENT = 'localgpt:native-request'
export const NATIVE_RESULT_EVENT = 'localgpt:native-result'
const UUID = z.string().uuid()
const Models = z.object({
  versionOptions: z.array(
    z.object({
      id: z.string(),
      slugs: z.array(z.string()),
      modelSlugByLane: z.record(z.string(), z.string()).optional(),
      options: z.array(
        z.object({
          slug: z.string(),
          lane: z.string().optional(),
          thinkingEffort: z.string().nullable().optional(),
          isAvailable: z.boolean(),
        }),
      ),
    }),
  ),
})
const Selected = z.object({
  slug: z.string(),
  thinkingEffort: z.string().nullable(),
  versionId: z.string(),
})
type Runtime = { c: Record<string, { exports?: unknown }>; aE?: symbol }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
export async function discoverNativeRuntime(
  origin: string,
  observed: string[],
  load: (url: string) => Promise<unknown>,
): Promise<Runtime> {
  const urls = [...new Set(observed)].filter((value) => {
    try {
      const url = new URL(value)
      return (
        url.origin === origin &&
        /^\/cdn\/assets\/[^/]+\.js$/.test(url.pathname) &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  })
  const matches = new Set<Runtime>()
  for (const url of urls) {
    let namespace: unknown
    try {
      namespace = await load(url)
    } catch {
      continue
    }
    if (!record(namespace)) continue
    const runtime = namespace.__webpack_require__
    if ((typeof runtime === 'function' || record(runtime)) && record((runtime as Runtime).c))
      matches.add(runtime as Runtime)
  }
  if (matches.size !== 1)
    throw new Error(matches.size ? 'native_runtime_ambiguous' : 'native_runtime_unavailable')
  return [...matches][0]!
}
type NativeFunction = (...args: any[]) => any
export async function discoverCachedNativeExports(runtime: Runtime) {
  const completions = new Set<NativeFunction>(),
    uploads = new Set<NativeFunction>(),
    builders = new Set<NativeFunction>()
  const namespaces: unknown[] = []
  for (const cached of Object.values(runtime.c)) {
    if (!cached || !record(cached.exports)) continue
    namespaces.push(cached.exports)
    if (runtime.aE) {
      const namespace = (cached.exports as Record<symbol, unknown>)[runtime.aE]
      // Inspect cached namespaces only; never invoke the native module loader.
      if (record(namespace) && typeof namespace.then !== 'function') namespaces.push(namespace)
    }
  }
  for (const namespace of namespaces) {
    if (!record(namespace)) continue
    if (typeof namespace.submitChatGPTCompletion === 'function')
      completions.add(namespace.submitChatGPTCompletion as NativeFunction)
    if (typeof namespace.uploadChatGptConversationFile === 'function')
      uploads.add(namespace.uploadChatGptConversationFile as NativeFunction)
    for (const value of Object.values(namespace)) {
      if (typeof value !== 'function') continue
      const source = Function.prototype.toString.call(value)
      if (
        source.includes('extraDeveloperInstructionMessages') &&
        source.includes('message') &&
        source.includes('content_type') &&
        source.includes('user')
      )
        builders.add(value as NativeFunction)
    }
  }
  if (completions.size > 1 || uploads.size > 1 || builders.size > 1)
    throw new Error('native_exports_ambiguous')
  if (completions.size !== 1 || uploads.size !== 1 || builders.size !== 1)
    throw new Error('native_exports_unavailable')
  return { submit: [...completions][0]!, upload: [...uploads][0]!, builder: [...builders][0]! }
}
export function selectNativeModel(
  modelsValue: unknown,
  selectedValue: unknown,
  requested?: string,
  effort?: string,
) {
  const models = Models.parse(modelsValue),
    selected = Selected.parse(selectedValue)
  if (!requested && effort) throw new Error('native_model_required')
  const model = requested ?? selected.slug
  const candidates = models.versionOptions.flatMap((version) =>
    version.slugs.includes(model)
      ? version.options
          .filter(
            (o) =>
              o.isAvailable &&
              (o.slug === model || (o.lane && version.modelSlugByLane?.[o.lane] === model)),
          )
          .map((o) => ({ ...o, versionId: version.id }))
      : [],
  )
  const preferred = candidates.filter((o) => o.versionId === selected.versionId)
  const matches = preferred.length ? preferred : candidates
  if (!matches.length) throw new Error('native_model_unavailable')
  const availableEfforts = new Set(matches.map((o) => o.thinkingEffort ?? null))
  if (effort === undefined && model !== selected.slug && availableEfforts.size !== 1)
    throw new Error('native_reasoning_required')
  const thinkingEffort =
    effort ?? (model === selected.slug ? selected.thinkingEffort : [...availableEfforts][0]!)
  if (!availableEfforts.has(thinkingEffort)) throw new Error('native_model_unavailable')
  const versions = new Set(
    matches.filter((o) => (o.thinkingEffort ?? null) === thinkingEffort).map((o) => o.versionId),
  )
  if (versions.size !== 1) throw new Error('native_model_version_ambiguous')
  return { model, thinkingEffort, versionId: [...versions][0]! }
}
export function resolveNativeProject(
  rows: { label: string; id: string }[],
  name?: string,
  persisted?: string,
) {
  if (!name && !persisted) return undefined
  if (persisted) {
    ProjectIdSchema.parse(persisted)
    if (
      name &&
      rows.some(
        (r) => (r.id === persisted && r.label !== name) || (r.label === name && r.id !== persisted),
      )
    )
      throw new Error('native_project_mismatch')
    return persisted
  }
  const matches = rows.filter(
    (r) => (!name || r.label === name) && ProjectIdSchema.safeParse(r.id).success,
  )
  if (matches.length !== 1)
    throw new Error(matches.length ? 'native_project_ambiguous' : 'native_project_unavailable')
  if (persisted && matches[0]!.id !== persisted) throw new Error('native_project_mismatch')
  return matches[0]!.id
}
const Prepared = z
  .object({
    extraDeveloperInstructionMessages: z.array(z.unknown()).length(0),
    message: z
      .object({
        id: UUID,
        author: z.object({ role: z.literal('user') }).passthrough(),
        content: z.object({ content_type: z.string(), parts: z.array(z.unknown()) }).passthrough(),
        metadata: z.record(z.string(), z.unknown()),
      })
      .passthrough(),
  })
  .passthrough()
export function validatePreparedMessage(value: unknown, text: string, userId: string) {
  const built = Prepared.parse(value)
  UUID.parse(userId)
  const textParts = built.message.content.parts.filter((p): p is string => typeof p === 'string')
  if (
    textParts.length !== 1 ||
    textParts[0] !== text ||
    !['text', 'multimodal_text'].includes(built.message.content.content_type)
  )
    throw new Error('native_builder_message_mismatch')
  return { ...built, message: { ...built.message, id: userId } }
}
export type NativeReceipt = {
  requestId: string
  kind: 'ready' | 'prepared' | 'identity' | 'error' | 'dispatch_refused'
  ready?: boolean
  nativeUserMessageId?: string
  projectId?: string
  clientThreadId?: string
  conversationId?: string
  code?: string
  message?: string
  preDispatch?: boolean
}
export type NativeContract = {
  scope: unknown
  models: unknown
  selected: unknown
  projectRows: { label: string; id: string }[]
  build: (text: string, uploads: unknown[], context?: { nativeUserMessageId: string }) => unknown
  upload: NativeFunction
  submit: NativeFunction
  validateUpload?: (result: unknown, file: BrowserFile) => unknown
  validatePreparedUploads?: (
    message: ReturnType<typeof validatePreparedMessage>,
    uploads: unknown[],
  ) => void
  readConversationSnapshot?: (conversationId: string, signal: AbortSignal) => Promise<unknown>
  makeFile?: (file: BrowserFile) => File
  prepareExistingConversation?: (
    conversationId: string,
    projectId?: string,
  ) => Promise<{ conversationId: string; parentMessageId: string; projectId?: string }>
}
class NativeDispatchRefusal extends Error {
  constructor(
    message: string,
    readonly preDispatch: boolean,
  ) {
    super(message)
  }
}
type GenerationRequest = Extract<BrowserRequest, { type: 'request' }>
export class NativeChatDispatcher {
  private ledger = new NativeDispatchLedger()
  private preparing = new Set<string>()
  private disarmedPreparations = new Set<string>()
  private owners = new Map<
    string,
    {
      userId: string
      conversationId?: string
      contract: NativeContract
      invalid: boolean
    }
  >()
  private flights = new Map<string, { controller: AbortController; promise: Promise<unknown> }>()

  disarm(requestId: string) {
    if (this.preparing.has(requestId)) this.disarmedPreparations.add(requestId)
    this.owners.delete(requestId)
    this.prepared.delete(requestId)
    this.flights.get(requestId)?.controller.abort()
  }

  async readConversationSnapshot(
    requestId: string,
    userId: string,
    conversationId: string,
  ): Promise<unknown> {
    const owner = this.owners.get(requestId)
    const check = () => {
      if (
        !owner ||
        this.owners.get(requestId) !== owner ||
        owner.invalid ||
        owner.userId !== userId ||
        owner.conversationId !== conversationId ||
        !UUID.safeParse(conversationId).success ||
        !owner.contract.readConversationSnapshot
      )
        throw new Error('native_recovery_not_owned')
    }
    check()
    let flight = this.flights.get(requestId)
    if (!flight) {
      if (this.flights.size >= 32) throw new Error('native_recovery_capacity')
      const controller = new AbortController()
      const promise = Promise.resolve().then(() => {
        check()
        return owner!.contract.readConversationSnapshot!(conversationId, controller.signal)
      })
      flight = { controller, promise }
      this.flights.set(requestId, flight)
      const captured = flight
      // A timed-out waiter must not start another GET while the SDK read is pending.
      void promise
        .finally(() => {
          if (this.flights.get(requestId) === captured) this.flights.delete(requestId)
        })
        .catch(() => {})
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        flight.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            flight!.controller.abort()
            reject(new Error('native_recovery_timeout'))
          }, 15000)
        }),
      ])
      check()
      if (flight.controller.signal.aborted) throw new Error('native_recovery_disarmed')
      return value
    } finally {
      clearTimeout(timer)
    }
  }
  private prepared = new Map<
    string,
    {
      request: GenerationRequest
      contract: NativeContract
      message: ReturnType<typeof validatePreparedMessage>
      model: ReturnType<typeof selectNativeModel>
      projectId?: string
      parentMessageId?: string
    }
  >()
  constructor(
    private discover: () => Promise<NativeContract>,
    private receipt: (value: NativeReceipt) => void,
    private journal: (requestId: string, userId: string) => void,
  ) {}
  async probe(requestId: string) {
    try {
      await this.discover()
      this.receipt({ requestId, kind: 'ready', ready: true })
    } catch (error) {
      this.receipt({
        requestId,
        kind: 'ready',
        ready: false,
        code: error instanceof Error ? error.message : 'native_unavailable',
      })
    }
  }
  async prepare(request: GenerationRequest) {
    const userId = UUID.parse(request.nativeUserMessageId)
    if (!request.native) throw new Error('native_protocol_required')
    if (!request.newChat && !request.conversationId)
      throw new Error('native_existing_target_required')
    if (request.newChat && request.conversationId) throw new Error('native_target_mismatch')
    if (request.conversationId) UUID.parse(request.conversationId)
    this.ledger.prepare(request.requestId, userId)
    if (this.preparing.size + this.prepared.size + this.owners.size >= 32)
      throw new Error('native_request_capacity')
    this.preparing.add(request.requestId)
    const checkPreparing = () => {
      if (this.disarmedPreparations.has(request.requestId))
        throw new Error('native_prepare_disarmed')
    }
    try {
      const contract = await this.discover()
      checkPreparing()
      const model = selectNativeModel(
        contract.models,
        contract.selected,
        request.model,
        request.reasoning?.effort,
      )
      let projectId = resolveNativeProject(
        contract.projectRows,
        request.projectName,
        request.projectId,
      )
      let parentMessageId: string | undefined
      if (request.conversationId) {
        if (!contract.prepareExistingConversation)
          throw new Error('native_existing_preparation_unavailable')
        const existing = await contract.prepareExistingConversation(
          request.conversationId,
          projectId,
        )
        checkPreparing()
        if (
          existing.conversationId !== request.conversationId ||
          (projectId && existing.projectId !== projectId)
        )
          throw new Error('native_existing_identity_mismatch')
        if (!projectId && existing.projectId) projectId = ProjectIdSchema.parse(existing.projectId)
        parentMessageId = UUID.parse(existing.parentMessageId)
      }
      const uploads: unknown[] = []
      if (
        request.files?.length &&
        (!contract.validateUpload || !contract.makeFile || !contract.validatePreparedUploads)
      )
        throw new Error('native_upload_contract_unavailable')
      for (const file of request.files ?? []) {
        checkPreparing()
        const uploaded = await contract.upload(contract.scope, contract.makeFile!(file), {
          isTemporaryChat: false,
          storeInLibrary: false,
          model: {
            slug: model.model,
            thinkingEffort: model.thinkingEffort,
            versionId: model.versionId,
          },
          composerContext: {
            ...(projectId ? { projectId } : {}),
            isProjectThread: Boolean(projectId),
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
            messageId: userId,
          },
        })
        checkPreparing()
        uploads.push(contract.validateUpload!(uploaded, file))
      }
      const message = validatePreparedMessage(
        await contract.build(request.text, uploads, { nativeUserMessageId: userId }),
        request.text,
        userId,
      )
      checkPreparing()
      if (uploads.length) contract.validatePreparedUploads!(message, uploads)
      // No composer values or manual attachments are read into the native payload.
      this.prepared.set(request.requestId, {
        request: { ...request, files: undefined },
        contract,
        message,
        model,
        projectId,
        parentMessageId,
      })
      this.receipt({
        requestId: request.requestId,
        kind: 'prepared',
        nativeUserMessageId: userId,
        ...(projectId ? { projectId } : {}),
      })
    } finally {
      this.preparing.delete(request.requestId)
      this.disarmedPreparations.delete(request.requestId)
    }
  }
  async dispatch(requestId: string, userId: string) {
    this.ledger.check(requestId, userId)
    const prepared = this.prepared.get(requestId)
    if (!prepared || prepared.request.nativeUserMessageId !== userId)
      throw new Error('native_dispatch_identity_mismatch')
    // The caller has already obtained a checked server intent ACK. The local journal
    // is a second barrier against accidental page-side re-dispatch after reconnect.
    this.ledger.check(requestId, userId)
    try {
      this.journal(requestId, userId)
    } catch (error) {
      if (error instanceof NativeDispatchRefusal) throw error
      throw new NativeDispatchRefusal(
        error instanceof Error ? error.message : 'native_journal_failed',
        true,
      )
    }
    this.ledger.attempt(requestId, userId)
    const { request, contract, message, model, projectId, parentMessageId } = prepared
    const owner = { userId, conversationId: request.conversationId, contract, invalid: false }
    this.owners.set(requestId, owner)
    this.prepared.delete(requestId)
    const identity = (clientThreadId?: string, conversationId?: string) => {
      if (
        conversationId &&
        (!UUID.safeParse(conversationId).success ||
          (owner.conversationId && conversationId !== owner.conversationId))
      ) {
        owner.invalid = true
        this.receipt({
          requestId,
          kind: 'error',
          code: 'native_identity_mismatch',
          message: 'Native server conversation identity mismatch.',
          preDispatch: false,
          nativeUserMessageId: userId,
        })
        return
      }
      if (
        clientThreadId !== undefined &&
        (typeof clientThreadId !== 'string' || !clientThreadId || clientThreadId.length > 200)
      )
        return
      if (conversationId) owner.conversationId ??= conversationId
      this.receipt({
        requestId,
        kind: 'identity',
        nativeUserMessageId: userId,
        ...(clientThreadId ? { clientThreadId } : {}),
        ...(conversationId ? { conversationId } : {}),
      })
    }
    // Do not await remote generation here: independent requests share this tab.
    // Acceptance and callbacks prove at most possible dispatch, never termination.
    try {
      void Promise.resolve(
        contract.submit(contract.scope, {
          ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          model: model.model,
          thinkingEffort: model.thinkingEffort,
          ...(projectId ? { projectId } : {}),
          ...(parentMessageId ? { parentMessageId } : {}),
          prompt: request.text,
          userCompletionMessages: message,
          onClientThreadIdChange: (id: string) => identity(id),
          onServerThreadIdChange: (id: string) => identity(undefined, id),
          onCompletion: () => {},
          requireDispatchAcceptance: true,
          requireResponseAcceptance: false,
        }),
      ).catch((error) =>
        this.receipt({
          requestId,
          kind: 'error',
          nativeUserMessageId: userId,
          code: 'native_completion_unknown',
          message: error instanceof Error ? error.message : 'Native completion rejected.',
          preDispatch: false,
        }),
      )
    } catch (error) {
      this.receipt({
        requestId,
        kind: 'error',
        nativeUserMessageId: userId,
        code: 'native_completion_unknown',
        message: error instanceof Error ? error.message : 'Native completion threw.',
        preDispatch: false,
      })
    }
  }
}
type NativePage = Pick<
  Window,
  'document' | 'location' | 'addEventListener' | 'dispatchEvent' | 'sessionStorage' | 'performance'
> & { CustomEvent: typeof CustomEvent }
async function discoverPageNativeContract(page: NativePage): Promise<NativeContract> {
  return discoverVerifiedNativeContract(page)
}
export function installNativeChat(
  page: NativePage,
  discover: () => Promise<NativeContract> = () => discoverPageNativeContract(page),
) {
  observeNativeAssets(page)
  const emit = (receipt: NativeReceipt) =>
    page.dispatchEvent(
      new page.CustomEvent(NATIVE_RESULT_EVENT, { detail: JSON.stringify(receipt) }),
    )
  const key = 'localgpt:native-dispatch-journal'
  const journal = (requestId: string, userId: string) => {
    const raw = page.sessionStorage.getItem(key)
    const entries = raw ? z.record(z.string(), UUID).parse(JSON.parse(raw)) : {}
    if (Object.hasOwn(entries, requestId) || Object.values(entries).includes(userId))
      throw new NativeDispatchRefusal('native_dispatch_already_journaled', false)
    if (Object.keys(entries).length >= 1000) throw new Error('native_dispatch_journal_full')
    entries[requestId] = userId
    const serialized = JSON.stringify(entries)
    page.sessionStorage.setItem(key, serialized)
    if (page.sessionStorage.getItem(key) !== serialized)
      throw new Error('native_dispatch_journal_unavailable')
  }
  const dispatcher = new NativeChatDispatcher(discover, emit, journal)
  const attempted = new Set<string>()
  const Command = z.discriminatedUnion('action', [
    z.object({ action: z.literal('probe'), requestId: z.string().min(1) }),
    z.object({ action: z.literal('prepare') }).passthrough(),
    z.object({
      action: z.literal('dispatch'),
      requestId: z.string().min(1),
      nativeUserMessageId: UUID,
    }),
  ])
  page.addEventListener(NATIVE_REQUEST_EVENT, (event) => {
    let command: z.infer<typeof Command>
    try {
      command = Command.parse(JSON.parse((event as CustomEvent<string>).detail))
    } catch {
      return
    }
    if (command.action === 'probe') {
      void dispatcher.probe(command.requestId)
      return
    }
    if (command.action === 'prepare') {
      const request = BrowserRequestSchema.safeParse({ ...command, type: 'request' })
      if (!request.success || request.data.type !== 'request') return
      const generation = request.data
      void dispatcher.prepare(generation).catch((error) =>
        emit({
          requestId: generation.requestId,
          kind: 'error',
          nativeUserMessageId: generation.nativeUserMessageId,
          code: error instanceof Error ? error.message : 'native_prepare_failed',
          message: 'Native preparation failed before generation.',
          preDispatch: !attempted.has(generation.requestId),
        }),
      )
      return
    }
    const preDispatch = !attempted.has(command.requestId)
    // Duplicate commands are never interpreted as permission to retry generation.
    if (!preDispatch) {
      emit({
        requestId: command.requestId,
        kind: 'error',
        nativeUserMessageId: command.nativeUserMessageId,
        code: 'native_dispatch_already_attempted',
        message: 'Dispatch was already attempted.',
        preDispatch: false,
      })
      return
    }
    attempted.add(command.requestId)
    void dispatcher.dispatch(command.requestId, command.nativeUserMessageId).catch((error) =>
      emit({
        requestId: command.requestId,
        kind:
          error instanceof NativeDispatchRefusal && error.preDispatch
            ? 'dispatch_refused'
            : 'error',
        nativeUserMessageId: command.nativeUserMessageId,
        code: error instanceof Error ? error.message : 'native_dispatch_failed',
        message: 'Native dispatch refused.',
        preDispatch: error instanceof NativeDispatchRefusal && error.preDispatch,
      }),
    )
  })
  page.addEventListener('localgpt:stream-disarm', (event) => {
    const requestId = (event as CustomEvent<unknown>).detail
    if (typeof requestId === 'string') dispatcher.disarm(requestId)
  })
  return dispatcher
}
export class NativeDispatchLedger {
  private entries = new Map<string, { userId: string; attempted: boolean }>()
  prepare(requestId: string, userId: string) {
    if (!requestId || ['__proto__', 'constructor', 'prototype'].includes(requestId))
      throw new Error('native_request_id_invalid')
    if (this.entries.has(requestId)) throw new Error('native_request_already_prepared')
    if (this.entries.size >= 1000) throw new Error('native_ledger_capacity')
    if ([...this.entries.values()].some((entry) => entry.userId === userId))
      throw new Error('native_user_identity_reserved')
    this.entries.set(requestId, { userId, attempted: false })
  }
  check(requestId: string, userId: string) {
    const entry = this.entries.get(requestId)
    if (!entry || entry.userId !== userId)
      throw new NativeDispatchRefusal('native_dispatch_identity_mismatch', false)
    if (entry.attempted) throw new NativeDispatchRefusal('native_dispatch_already_attempted', false)
  }
  attempt(requestId: string, userId: string) {
    this.check(requestId, userId)
    this.entries.get(requestId)!.attempted = true
  }
}
