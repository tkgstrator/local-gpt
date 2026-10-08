import type { NativeContract } from './native-chat'
import type { BrowserFile } from './attachment-protocol'
import { observeNativeAssets } from './native-assets'

type Obj = Record<string, any>
type NativeFunction = (...args: any[]) => any
export type NativeAdapterPage = Pick<Window, 'document' | 'performance' | 'location'> & {
  File?: typeof File
  atob?: typeof atob
  createImageBitmap?: typeof createImageBitmap
}
export type NativeAdapterDependencies = {
  loadModule?: (url: string) => Promise<unknown>
  decodeImage?: (file: File) => Promise<{ width: number; height: number; close?: () => void }>
}
export type NativeBuildContext = { nativeUserMessageId: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PROJECT = /^g-p-[0-9a-f]{32}$/
const MAX_BYTES = 8 * 1024 * 1024
const own = (o: Obj, key: string) => Object.prototype.hasOwnProperty.call(o, key)
const object = (v: unknown): v is Obj => typeof v === 'object' && v !== null
function fail(code: string): never {
  throw new Error(code)
}
function unique<T>(values: Iterable<T>, name: string): T {
  const set = new Set(values)
  if (set.size !== 1) fail(`native_${name}_${set.size ? 'ambiguous' : 'unavailable'}`)
  return [...set][0]!
}

async function exportsFromPage(page: NativeAdapterPage, load: (url: string) => Promise<unknown>) {
  const observed = [
    ...observeNativeAssets(page),
    ...[...page.document.querySelectorAll<HTMLScriptElement>('script[src]')].map((s) => s.src),
  ]
  observed.push(
    ...[...page.document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"][href]')].map(
      (s) => s.href,
    ),
  )
  observed.push(...page.performance.getEntriesByType('resource').map((r) => r.name))
  const runtimes = new Set<Obj>()
  for (const value of new Set(observed)) {
    let url: URL
    try {
      url = new URL(value, page.location.origin)
    } catch {
      continue
    }
    if (
      url.origin !== page.location.origin ||
      !/^\/cdn\/assets\/[^/]+\.js$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      continue
    let namespace: any
    try {
      namespace = await load(url.href)
    } catch {
      continue
    }
    const runtime = namespace?.__webpack_require__
    if ((typeof runtime === 'function' || object(runtime)) && object(runtime.c))
      runtimes.add(runtime)
  }
  const runtime = unique(runtimes, 'runtime')
  const namespaces = new Set<Obj>()
  for (const cached of Object.values(runtime.c)) {
    if (!object(cached) || !object(cached.exports)) continue
    const exp = cached.exports
    // Rspack's async export symbol exposes the resolved namespace, not a loader.
    if (typeof exp.then !== 'function') namespaces.add(exp)
    if (typeof runtime.aE === 'symbol') {
      const asyncNamespace = (exp as Record<PropertyKey, unknown>)[runtime.aE]
      if (object(asyncNamespace) && typeof asyncNamespace.then !== 'function')
        namespaces.add(asyncNamespace)
    }
  }
  const completion = unique(
    [...namespaces].map((n) => n.submitChatGPTCompletion).filter((v) => typeof v === 'function'),
    'completion',
  ) as NativeFunction
  const upload = unique(
    [...namespaces]
      .map((n) => n.uploadChatGptConversationFile)
      .filter((v) => typeof v === 'function'),
    'uploader',
  ) as NativeFunction
  const builders = new Set<NativeFunction>()
  for (const namespace of namespaces) {
    if (namespace.submitChatGPTCompletion !== completion) continue
    for (const fn of Object.values(namespace)) {
      if (typeof fn !== 'function' || fn === completion || fn === upload) continue
      const source = Function.prototype.toString.call(fn)
      if (
        fn.constructor?.name === 'AsyncFunction' ||
        /^\s*async\b/.test(source) ||
        /\bawait\b/.test(source)
      )
        continue
      if (
        [
          'extraDeveloperInstructionMessages',
          'content_type',
          'user',
          'prompt',
          'attachments',
          'extraDeveloperInstructions',
          'oneTurnDeveloperInstructions',
          'systemHints',
        ].every((marker) => source.includes(marker))
      )
        builders.add(fn as NativeFunction)
    }
  }
  const refetches = new Set<NativeFunction>()
  for (const namespace of namespaces)
    for (const fn of Object.values(namespace)) {
      if (typeof fn !== 'function') continue
      const source = Function.prototype.toString.call(fn)
      if (
        [
          'chatgpt_conversation_refetch_started',
          'chatgpt_conversation_refetch_completed',
          'onSnapshotApply',
          'throwOnError',
          'preserveAsyncStatus',
          'mapping',
        ].every((marker) => source.includes(marker))
      )
        refetches.add(fn as NativeFunction)
    }
  return {
    completion,
    upload,
    builder: unique(builders, 'builder'),
    refetch: unique(refetches, 'refetch'),
  }
}

function isStore(value: unknown): value is Obj {
  if (!object(value)) return false
  if (
    ![
      'chain',
      'getOwnValue',
      'node',
      'queryClient',
      'scope',
      'value',
      'get',
      'query',
      'set',
      'watch',
      'when',
    ].every((k) => own(value, k))
  )
    return false
  return object(value.scope) && object(value.queryClient)
}
function hookStores(fiber: Obj) {
  const stores = new Set<Obj>(),
    seen = new Set<Obj>()
  let hook = fiber.memoizedState
  for (let count = 0; object(hook); count++, hook = hook.next) {
    // Native composer/owner hooks currently exceed 600/790 entries respectively.
    if (count >= 2048 || seen.has(hook)) fail('native_react_hooks_invalid')
    seen.add(hook)
    const ref = hook.memoizedState
    if (object(ref) && own(ref, 'current') && isStore(ref.current)) stores.add(ref.current)
  }
  return [...stores]
}
function ancestors(fiber: Obj) {
  const result: Obj[] = [],
    seen = new Set<Obj>()
  for (let next: any = fiber; object(next); next = next.return) {
    // The live app currently nests the composer under more than 300 providers.
    if (result.length >= 2048 || seen.has(next)) fail('native_react_tree_invalid')
    seen.add(next)
    result.push(next)
  }
  return result
}
function currentFiber(form: any) {
  const attached = unique(
    Object.keys(form)
      .filter((k) => k.startsWith('__reactFiber$'))
      .map((k) => form[k])
      .filter(object),
    'react_fiber',
  )
  const lineage = ancestors(attached)
  const root = lineage.find((f) => f.tag === 3 && object(f.stateNode?.current))
  if (!root) fail('native_react_root_unavailable')
  // DOM expando fibers can remain on the alternate after a commit. Resolve from
  // root.current by host-node identity; never trust their stale ancestor props.
  const current = root.stateNode.current
  const pending: Obj[] = [current],
    seen = new Set<Obj>(),
    matches: Obj[] = []
  while (pending.length) {
    const node = pending.pop()!
    if (seen.has(node)) fail('native_react_tree_invalid')
    seen.add(node)
    if (seen.size > 20000) fail('native_react_tree_limit')
    if (node.stateNode === form) matches.push(node)
    if (object(node.sibling)) pending.push(node.sibling)
    if (object(node.child)) pending.push(node.child)
  }
  return unique(matches, 'current_form')
}
function association(page: NativeAdapterPage) {
  const matches: { form: any; store: Obj; models: Obj; selected: Obj }[] = []
  for (const form of page.document.querySelectorAll('form')) {
    if (!Object.keys(form).some((k) => k.startsWith('__reactFiber$'))) continue
    const lineage = ancestors(currentFiber(form))
    const index = lineage.findIndex(
      (f) =>
        object(f.memoizedProps) &&
        typeof f.memoizedProps.onSubmit === 'function' &&
        own(f.memoizedProps, 'models') &&
        own(f.memoizedProps, 'selectedModel'),
    )
    if (index < 0) continue
    const composer = lineage[index]!,
      props = composer.memoizedProps
    const composerStore = hookStores(composer)[0]
    if (!composerStore) fail('native_composer_store_unavailable')
    const owner = lineage
      .slice(index + 1)
      .find(
        (f) =>
          object(f.memoizedProps) &&
          ['composerController', 'onServerThreadIdChange', 'getExtraDeveloperInstructions'].every(
            (k) => own(f.memoizedProps, k),
          ),
      )
    if (!owner) fail('native_store_root_unavailable')
    const store = unique(
      hookStores(owner).filter(
        (s) => s.scope === composerStore.scope && s.queryClient === composerStore.queryClient,
      ),
      'store',
    )
    validateModels(props.models, props.selectedModel)
    matches.push({ form, store, models: props.models, selected: props.selectedModel })
  }
  return unique(matches, 'composer')
}
function validateModels(models: unknown, selected: unknown) {
  if (
    !object(models) ||
    !Array.isArray(models.versionOptions) ||
    !models.versionOptions.length ||
    !object(selected) ||
    typeof selected.slug !== 'string' ||
    typeof selected.versionId !== 'string' ||
    !(selected.thinkingEffort === null || typeof selected.thinkingEffort === 'string')
  )
    fail('native_models_invalid')
  for (const v of models.versionOptions) {
    if (
      !object(v) ||
      typeof v.id !== 'string' ||
      !Array.isArray(v.slugs) ||
      !v.slugs.every((s: unknown) => typeof s === 'string') ||
      !Array.isArray(v.options) ||
      (v.modelSlugByLane !== undefined &&
        (!object(v.modelSlugByLane) ||
          !Object.values(v.modelSlugByLane).every((s) => typeof s === 'string')))
    )
      fail('native_models_invalid')
    for (const o of v.options)
      if (
        !object(o) ||
        typeof o.slug !== 'string' ||
        typeof o.isAvailable !== 'boolean' ||
        (o.lane !== undefined && typeof o.lane !== 'string') ||
        !(o.thinkingEffort == null || typeof o.thinkingEffort === 'string')
      )
        fail('native_models_invalid')
  }
  validateModel(models, selected.slug, selected.thinkingEffort, selected.versionId)
}
function validateModel(models: Obj, slug: unknown, effort: unknown, versionId?: unknown) {
  if (
    typeof slug !== 'string' ||
    !models.versionOptions.some(
      (v: Obj) =>
        (versionId === undefined || v.id === versionId) &&
        v.slugs.includes(slug) &&
        v.options.some(
          (o: Obj) =>
            o.isAvailable &&
            (o.slug === slug || (o.lane && v.modelSlugByLane?.[o.lane] === slug)) &&
            (o.thinkingEffort ?? null) === (effort ?? null),
        ),
    )
  )
    fail('native_model_unavailable')
}
function projects(page: NativeAdapterPage) {
  return [
    ...page.document.querySelectorAll(
      '[data-app-action-sidebar-project-label][data-app-action-sidebar-project-id]',
    ),
  ].map((row) => {
    const label = row.getAttribute('data-app-action-sidebar-project-label'),
      id = row.getAttribute('data-app-action-sidebar-project-id')
    if (!label || !id || !PROJECT.test(id)) fail('native_project_attributes_invalid')
    return { label, id }
  })
}
function validateProject(page: NativeAdapterPage, id: unknown, label?: unknown) {
  if (typeof id !== 'string' || !PROJECT.test(id)) fail('native_project_unavailable')
  if (label !== undefined && (typeof label !== 'string' || !label.trim()))
    fail('native_project_unavailable')
  const rows = projects(page)
  if (
    label !== undefined &&
    rows.some(
      (row) => (row.id === id && row.label !== label) || (row.label === label && row.id !== id),
    )
  )
    fail('native_project_conflict')
}
function existingSnapshot(value: unknown, conversationId: string, projectId?: string) {
  if (
    !object(value) ||
    value.conversation_id !== conversationId ||
    !object(value.mapping) ||
    Array.isArray(value.mapping) ||
    typeof value.current_node !== 'string' ||
    !UUID.test(value.current_node)
  )
    fail('native_existing_snapshot_invalid')
  if (
    value.gizmo_id != null &&
    (typeof value.gizmo_id !== 'string' || !PROJECT.test(value.gizmo_id))
  )
    fail('native_existing_project_invalid')
  if (projectId !== undefined && value.gizmo_id !== projectId)
    fail('native_existing_project_mismatch')
  // The observed SDK uses 4 for UNREAD after an async reply. That flag alone
  // proves no completion; the visible terminal text parent is validated below.
  if (
    !own(value, 'async_status') ||
    (value.async_status !== null && value.async_status !== 4) ||
    (value.read_only != null && value.read_only !== false) ||
    (value.is_read_only != null && value.is_read_only !== false) ||
    (value.is_archived !== undefined && value.is_archived !== false) ||
    (value.archived !== undefined && value.archived !== false)
  )
    fail('native_existing_not_admissible')
  const node = value.mapping[value.current_node],
    message = node?.message
  if (
    !own(value.mapping, value.current_node) ||
    !object(node) ||
    node.id !== value.current_node ||
    !object(message) ||
    message.id !== value.current_node ||
    !object(message.author) ||
    message.author.role !== 'assistant' ||
    message.channel !== 'final' ||
    message.recipient !== 'all' ||
    message.status !== 'finished_successfully' ||
    message.end_turn !== true ||
    !object(message.content) ||
    message.content.content_type !== 'text' ||
    !Array.isArray(message.content.parts) ||
    !message.content.parts.length ||
    !message.content.parts.every((part: unknown) => typeof part === 'string') ||
    !message.content.parts.some((part: string) => part.trim()) ||
    !object(message.metadata) ||
    (message.metadata.is_visually_hidden_from_conversation !== undefined &&
      message.metadata.is_visually_hidden_from_conversation !== false)
  )
    fail('native_existing_parent_invalid')
  return {
    conversationId,
    parentMessageId: value.current_node,
    ...(value.gizmo_id != null ? { projectId: value.gizmo_id as string } : {}),
  }
}
function bytes(page: NativeAdapterPage, file: BrowserFile) {
  if (
    !file.name ||
    file.name.length > 255 ||
    !file.mime ||
    file.mime.length > 100 ||
    file.base64.length > 11184812 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)
  )
    fail('native_file_invalid')
  let decoded: string
  try {
    decoded = (page.atob ?? globalThis.atob)(file.base64)
  } catch {
    fail('native_file_invalid')
  }
  if (decoded.length > MAX_BYTES) fail('native_file_invalid')
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0))
}
function uploadReference(result: unknown): Obj {
  if (
    !object(result) ||
    typeof result.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(result.id) ||
    typeof result.name !== 'string' ||
    !result.name ||
    typeof result.mimeType !== 'string' ||
    !result.mimeType ||
    !Number.isSafeInteger(result.size) ||
    result.size < 0 ||
    result.size > MAX_BYTES
  )
    fail('native_upload_result_invalid')
  for (const flag of ['retrievalIndexingUnavailable', 'libraryStorageLimitFallback'])
    if (result[flag] !== undefined && typeof result[flag] !== 'boolean')
      fail('native_upload_result_invalid')
  if (
    (result.projectId !== undefined &&
      (typeof result.projectId !== 'string' || !PROJECT.test(result.projectId))) ||
    (result.libraryFileId !== undefined &&
      (typeof result.libraryFileId !== 'string' || !result.libraryFileId)) ||
    (result.durationSeconds !== undefined &&
      (!Number.isFinite(result.durationSeconds) || result.durationSeconds < 0))
  )
    fail('native_upload_result_invalid')
  return result
}
function validateUpload(page: NativeAdapterPage, value: unknown, file: BrowserFile) {
  const result = uploadReference(value)
  if (
    result.name !== file.name ||
    result.mimeType.split(';')[0]!.trim().toLowerCase() !==
      file.mime.split(';')[0]!.trim().toLowerCase() ||
    result.size !== bytes(page, file).length
  )
    fail('native_upload_result_invalid')
  if (
    file.mime.startsWith('image/') &&
    (!Number.isSafeInteger(result.width) ||
      !Number.isSafeInteger(result.height) ||
      result.width <= 0 ||
      result.height <= 0 ||
      result.width > 32768 ||
      result.height > 32768 ||
      result.width * result.height > 40000000)
  )
    fail('native_image_dimensions_invalid')
  return result
}
function prepared(value: unknown, prompt: string, allowTrim = false) {
  if (
    !object(value) ||
    !Array.isArray(value.extraDeveloperInstructionMessages) ||
    value.extraDeveloperInstructionMessages.length ||
    !object(value.message)
  )
    fail('native_prepared_invalid')
  const m = value.message
  if (
    !UUID.test(m.id) ||
    !object(m.author) ||
    m.author.role !== 'user' ||
    !object(m.author.metadata) ||
    m.author.name !== null ||
    m.channel !== null ||
    m.end_turn !== null ||
    m.update_time !== null ||
    m.recipient !== 'all' ||
    m.status !== 'finished_successfully' ||
    m.weight !== 1 ||
    !Number.isFinite(m.create_time) ||
    !object(m.metadata) ||
    !object(m.content) ||
    !['text', 'multimodal_text'].includes(m.content.content_type) ||
    !Array.isArray(m.content.parts)
  )
    fail('native_prepared_invalid')
  const text = m.content.parts.filter((p: unknown) => typeof p === 'string')
  if (text.length !== 1 || (text[0] !== prompt && !(allowTrim && text[0] === prompt.trim())))
    fail('native_prompt_mismatch')
  return value
}
function canonical(value: unknown): string {
  try {
    return JSON.stringify(value, (_, v) =>
      object(v) && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => v[k] !== undefined)
              .map((k) => [k, v[k]]),
          )
        : v,
    )
  } catch {
    fail('native_prepared_invalid')
  }
}
function messageKey(message: Obj) {
  const { id: _id, ...fields } = message
  return canonical(fields)
}
function validateAttachments(message: Obj, uploads: unknown[]) {
  const assets = message.message.content.parts.filter((part: unknown) => typeof part !== 'string')
  if (!uploads.length) {
    if (assets.length) fail('native_upload_message_mismatch')
    return
  }
  const refs = message.message.metadata.attachments
  if (
    !Array.isArray(refs) ||
    refs.length !== uploads.length ||
    !uploads.every((u: any, i) => {
      const ref = refs[i]
      return (
        object(ref) &&
        ref.id === u.id &&
        ref.name === u.name &&
        ref.mime_type === u.mimeType &&
        ref.size === u.size &&
        ref.library_file_id === u.libraryFileId &&
        ref.retrieval_indexing_unavailable === u.retrievalIndexingUnavailable &&
        ref.width === u.width &&
        ref.height === u.height
      )
    })
  )
    fail('native_upload_message_mismatch')
  const images = uploads.filter(
    (u: any) => typeof u.mimeType === 'string' && u.mimeType.startsWith('image/'),
  ) as Obj[]
  if (
    assets.length !== images.length ||
    !images.every((u, i) => {
      const asset = assets[i]
      return (
        object(asset) &&
        asset.content_type === 'image_asset_pointer' &&
        asset.asset_pointer ===
          (u.id.startsWith('file_') ? `sediment://${u.id}` : `file-service://${u.id}`) &&
        asset.width === u.width &&
        asset.height === u.height &&
        asset.size_bytes === u.size
      )
    })
  )
    fail('native_upload_message_mismatch')
}

export async function discoverVerifiedNativeContract(
  page: NativeAdapterPage,
  dependencies: NativeAdapterDependencies = {},
): Promise<
  NativeContract & {
    build: (text: string, uploads: unknown[], context?: NativeBuildContext) => unknown
    prepareExistingConversation: (
      conversationId: string,
      projectId?: string,
    ) => Promise<{ conversationId: string; parentMessageId: string; projectId?: string }>
  }
> {
  const native = await exportsFromPage(
    page,
    dependencies.loadModule ?? ((url) => import(/* @vite-ignore */ url)),
  )
  const associated = association(page)
  const rawScope = associated.store.scope,
    queryClient = associated.store.queryClient
  const models = structuredClone(associated.models),
    selected = structuredClone(associated.selected)
  const projectRows = projects(page)
  const builtMessages = new Map<string, Obj[]>()
  let preparedCount = 0
  const assertCurrent = (scope: unknown = associated.store) => {
    const now = association(page)
    if (
      scope !== associated.store ||
      now.form !== associated.form ||
      now.store !== associated.store ||
      now.store.scope !== rawScope ||
      now.store.queryClient !== queryClient
    )
      fail('native_store_stale')
    return now
  }
  const makeFile = (file: BrowserFile) =>
    new (page.File ?? globalThis.File)([bytes(page, file)], file.name, { type: file.mime })
  return {
    scope: associated.store,
    models,
    selected,
    projectRows,
    makeFile,
    async readConversationSnapshot(conversationId: string, signal: AbortSignal) {
      assertCurrent()
      if (!UUID.test(conversationId) || signal.aborted) fail('native_recovery_input_invalid')
      const snapshot = await native.refetch(
        associated.store,
        conversationId,
        'localgpt-native-recovery',
        // Waiting for local idle also waits on async turns, whose completion is
        // precisely what this authenticated snapshot read must discover.
        { signal, deferWhileStreaming: false, throwOnError: true },
      )
      assertCurrent()
      if (signal.aborted) fail('native_recovery_aborted')
      return snapshot
    },
    async prepareExistingConversation(conversationId: string, projectId?: string) {
      assertCurrent()
      if (typeof conversationId !== 'string' || !UUID.test(conversationId))
        fail('native_existing_conversation_invalid')
      if (projectId !== undefined) validateProject(page, projectId)
      const snapshot = await native.refetch(
        associated.store,
        conversationId,
        'localgpt-native-prepare',
        { throwOnError: true },
      )
      assertCurrent()
      return existingSnapshot(snapshot, conversationId, projectId)
    },
    validateUpload: (result, file) => validateUpload(page, result, file),
    validatePreparedUploads: validateAttachments,
    build(text: string, uploads: unknown[], context?: NativeBuildContext) {
      assertCurrent()
      if (typeof text !== 'string' || !text.trim() || !Array.isArray(uploads))
        fail('native_builder_input_invalid')
      if (context && !UUID.test(context.nativeUserMessageId)) fail('native_message_id_invalid')
      for (const u of uploads) uploadReference(u)
      const result = prepared(
        native.builder({
          prompt: text,
          attachments: uploads,
          extraDeveloperInstructions: [],
          oneTurnDeveloperInstructions: [],
          systemHints: [],
        }),
        text,
        true,
      )
      // The observed builder trims text. Keep the caller's original prompt without
      // dropping any native message fields or using the manual composer value.
      const content = {
        ...result.message.content,
        parts: result.message.content.parts.map((part: unknown) =>
          typeof part === 'string' ? text : part,
        ),
      }
      const value = {
        ...result,
        message: {
          ...result.message,
          content,
          ...(context ? { id: context.nativeUserMessageId } : {}),
        },
      }
      validateAttachments(value, uploads)
      if (preparedCount >= 1000) fail('native_prepared_capacity')
      const key = messageKey(value.message),
        entries = builtMessages.get(key) ?? []
      entries.push(value)
      builtMessages.set(key, entries)
      preparedCount++
      return value
    },
    async upload(scope: unknown, file: File, options: Obj) {
      const now = assertCurrent(scope)
      if (
        !object(options) ||
        options.isTemporaryChat !== false ||
        options.storeInLibrary !== false ||
        !object(options.model) ||
        typeof options.model.versionId !== 'string'
      )
        fail('native_upload_context_required')
      validateModel(
        now.models,
        options.model.slug,
        options.model.thinkingEffort,
        options.model.versionId,
      )
      const ctx = options.composerContext
      if (!object(ctx)) fail('native_upload_context_required')
      if (
        typeof ctx.isProjectThread !== 'boolean' ||
        typeof ctx.messageId !== 'string' ||
        !UUID.test(ctx.messageId) ||
        ctx.isProjectThread !== (ctx.projectId !== undefined) ||
        (ctx.conversationId !== undefined &&
          (typeof ctx.conversationId !== 'string' || !UUID.test(ctx.conversationId)))
      )
        fail('native_upload_context_invalid')
      if (ctx.projectId !== undefined) validateProject(page, ctx.projectId, ctx.projectName)
      if (!(file instanceof (page.File ?? globalThis.File)) || file.size > MAX_BYTES)
        fail('native_file_invalid')
      let dimensions: { width: number; height: number } | undefined
      if (file.type.startsWith('image/')) {
        const decode =
          dependencies.decodeImage ??
          (page.createImageBitmap ? (f: File) => page.createImageBitmap!(f) : undefined)
        if (!decode) fail('native_image_decoder_unavailable')
        let timer: ReturnType<typeof setTimeout> | undefined,
          timedOut = false
        const decoding = Promise.resolve()
          .then(() => decode(file))
          .then((image) => {
            if (timedOut) image.close?.()
            return image
          })
        try {
          const image = await Promise.race([
            decoding,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true
                reject(new Error('native_image_decode_timeout'))
              }, 5000)
            }),
          ])
          try {
            if (
              !Number.isSafeInteger(image.width) ||
              !Number.isSafeInteger(image.height) ||
              image.width <= 0 ||
              image.height <= 0 ||
              image.width > 32768 ||
              image.height > 32768 ||
              image.width * image.height > 40000000
            )
              fail('native_image_dimensions_invalid')
            dimensions = { width: image.width, height: image.height }
          } finally {
            image.close?.()
          }
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      assertCurrent(scope)
      const result = uploadReference(await native.upload(scope, file, options))
      if (
        result.name !== file.name ||
        result.mimeType !== file.type ||
        result.size !== file.size ||
        (result.projectId !== undefined && result.projectId !== options.composerContext.projectId)
      )
        fail('native_upload_result_invalid')
      return dimensions ? { ...result, ...dimensions } : result
    },
    submit(scope: unknown, options: Obj) {
      const now = assertCurrent(scope)
      if (!object(options) || typeof options.prompt !== 'string')
        fail('native_submit_options_invalid')
      validateModel(now.models, options.model, options.thinkingEffort)
      if (options.conversationId !== undefined && !UUID.test(options.conversationId))
        fail('native_conversation_invalid')
      if (options.projectId !== undefined)
        validateProject(page, options.projectId, options.projectName)
      else if (options.projectName !== undefined) fail('native_project_unavailable')
      let messages = options.userCompletionMessages
      const message = Array.isArray(messages)
        ? messages.length === 1
          ? messages[0]
          : undefined
        : messages?.message
      if (!object(message)) fail('native_prepared_invalid')
      const key = messageKey(message),
        entries = builtMessages.get(key)
      if (!entries?.length) fail('native_prepared_unowned')
      const topLevel = (v: Obj) => {
        const { message: _message, ...fields } = v
        return canonical(fields)
      }
      let entryIndex = 0
      if (Array.isArray(messages)) {
        // The core's schema parser clones the message and replaces its UUID.
        // Match every other native field; never correlate by prompt alone.
        if (entries.some((v) => topLevel(v) !== topLevel(entries[0]!)))
          fail('native_prepared_ambiguous')
        messages = { ...entries[0], message }
      } else {
        entryIndex = entries.findIndex((v) => topLevel(v) === topLevel(messages))
        if (entryIndex < 0) fail('native_prepared_unowned')
      }
      prepared(messages, options.prompt)
      entries.splice(entryIndex, 1)
      preparedCount--
      if (!entries.length) builtMessages.delete(key)
      // Native callbacks and the returned receipt indicate possible dispatch only.
      // Do not catch/retry native errors or infer remote termination here.
      return native.completion(scope, {
        ...options,
        userCompletionMessages: messages,
        requireDispatchAcceptance: true,
        requireResponseAcceptance: false,
      })
    },
  }
}
