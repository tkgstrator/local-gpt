import { expect, test } from 'bun:test'
import { discoverVerifiedNativeContract } from '../src/native-client-adapter'
import { validatePreparedMessage } from '../src/native-chat'

const id = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const project = 'g-p-0123456789abcdef0123456789abcdef'
test('preparation passes its abort signal to the SDK and refuses already aborted work', async () => {
  const f = fixture()
  const contract = await discoverVerifiedNativeContract(f.page, f.deps)
  const controller = new AbortController()
  await contract.prepareExistingConversation!(id, project, controller.signal)
  expect(f.calls.at(-1)).toEqual([
    'refetch',
    f.store,
    id,
    'localgpt-native-prepare',
    { throwOnError: true, signal: controller.signal },
  ])
  controller.abort()
  await expect(
    contract.prepareExistingConversation!(id, project, controller.signal),
  ).rejects.toThrow('native_prepare_aborted')
  expect(f.calls).toHaveLength(1)
})
test('preparation discards a late SDK snapshot after cancellation', async () => {
  const f = fixture()
  let finish!: () => void
  let reads = 0
  f.namespace.refetch = async function () {
    const markers =
      'chatgpt_conversation_refetch_started chatgpt_conversation_refetch_completed onSnapshotApply throwOnError preserveAsyncStatus mapping'
    if (String(arguments[2]) === markers) throw Error(markers)
    reads++
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return f.snapshot
  }
  const contract = await discoverVerifiedNativeContract(f.page, f.deps)
  const controller = new AbortController()
  const preparing = contract.prepareExistingConversation!(id, project, controller.signal)
  controller.abort()
  finish()
  await expect(preparing).rejects.toThrow('native_prepare_aborted')
  expect(reads).toBe(1)
  expect(f.calls.some((call) => call[0] === 'send')).toBe(false)
})
test('authenticated recovery refetch uses captured store, exact CID and observed options', async () => {
  const f = fixture()
  const contract = await discoverVerifiedNativeContract(f.page, f.deps)
  const controller = new AbortController()
  expect(await contract.readConversationSnapshot!(id, controller.signal)).toBe(f.snapshot)
  expect(f.calls.at(-1)).toEqual([
    'refetch',
    f.store,
    id,
    'localgpt-native-recovery',
    {
      signal: controller.signal,
      deferWhileStreaming: false,
      throwOnError: true,
    },
  ])
  f.store.scope = {}
  await expect(contract.readConversationSnapshot!(id, controller.signal)).rejects.toThrow('stale')
})
test('recovery reads active native snapshots without waiting for local idle', async () => {
  for (const status of ['active-async-turn', 'active-tpp-turn', 'streaming']) {
    const f = fixture()
    f.namespace.refetch = async function (
      scope: unknown,
      cid: string,
      reason: string,
      options: any,
    ) {
      const markers =
        'chatgpt_conversation_refetch_started chatgpt_conversation_refetch_completed onSnapshotApply throwOnError preserveAsyncStatus mapping'
      if (reason === markers) throw Error(markers)
      f.calls.push(['refetch', scope, cid, reason, options])
      // These are the live SDK's active statuses. Its deferred path cannot read
      // the remote final until the local status has already become idle.
      if (
        options.deferWhileStreaming &&
        ['active-async-turn', 'active-tpp-turn', 'streaming'].includes(status)
      ) {
        await new Promise((_, reject) =>
          options.signal.addEventListener(
            'abort',
            () => reject(Error('SDK deferred behind local status')),
            { once: true },
          ),
        )
      }
      return f.snapshot
    }
    const contract = await discoverVerifiedNativeContract(f.page, f.deps)
    expect(await contract.readConversationSnapshot!(id, AbortSignal.timeout(40))).toBe(f.snapshot)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0][1]).toBe(f.store)
  }
})
test('recovery rejects store changes after SDK await without rebinding', async () => {
  const f = fixture()
  f.namespace.refetch = async function () {
    const markers =
      'chatgpt_conversation_refetch_started chatgpt_conversation_refetch_completed onSnapshotApply throwOnError preserveAsyncStatus mapping'
    if (String(arguments[2]) === markers) throw Error(markers)
    await Promise.resolve()
    f.store.queryClient = {}
    return f.snapshot
  }
  const contract = await discoverVerifiedNativeContract(f.page, f.deps)
  await expect(
    contract.readConversationSnapshot!(id, new AbortController().signal),
  ).rejects.toThrow('stale')
})
test('deep native provider ancestry resolves the current composer and still rejects cycles', async () => {
  const f = fixture()
  const owner = f.root.child
  let parent = f.root
  for (let i = 0; i < 350; i++) {
    const provider: any = { tag: 10, return: parent }
    parent.child = provider
    parent = provider
  }
  parent.child = owner
  owner.return = parent
  expect((await discoverVerifiedNativeContract(f.page, f.deps)).scope).toBe(f.store)
  parent.return = owner
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_react_tree_invalid',
  )
})
test('large native hook lists resolve their store and still reject cycles', async () => {
  const f = fixture()
  for (const fiber of [f.composer, f.owner]) {
    for (let i = 0; i < 900; i++)
      fiber.memoizedState = { memoizedState: null, next: fiber.memoizedState }
  }
  expect((await discoverVerifiedNativeContract(f.page, f.deps)).scope).toBe(f.store)
  f.composer.memoizedState.next = f.composer.memoizedState
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_react_hooks_invalid',
  )
})
// Minimal rendered-DOM stand-in: connected, visible, one positive client rect.
function element(extra: any = {}) {
  const e: any = {
    tagName: 'DIV',
    isConnected: true,
    hidden: false,
    parentElement: null,
    attrs: {},
    style: { display: 'block', visibility: 'visible' },
    rects: [{ width: 100, height: 20 }],
    getAttribute(k: string) {
      return this.attrs[k] ?? null
    },
    getClientRects() {
      return this.rects
    },
    querySelectorAll: () => [],
    closest() {
      for (let n: any = this; n; n = n.parentElement) if (n.tagName === 'FORM') return n
      return null
    },
    ...extra,
  }
  return e
}
function fixture() {
  const calls: any[] = []
  const scope = {},
    queryClient = {}
  const store = {
    scope,
    queryClient,
    chain: new Map(),
    getOwnValue() {},
    node: {},
    value: {},
    get() {},
    query() {},
    set() {},
    watch() {},
    when() {},
  }
  const models = {
    versionOptions: [
      {
        id: 'latest',
        slugs: ['instant'],
        modelSlugByLane: { instant: 'instant' },
        options: [{ slug: 'base', lane: 'instant', isAvailable: true }],
      },
    ],
  }
  const selectedModel = { slug: 'instant', thinkingEffort: null, versionId: 'latest' }
  const root: any = { tag: 3, stateNode: {}, return: null }
  root.stateNode.current = root
  const owner: any = {
    return: root,
    memoizedProps: {
      composerController: {},
      onServerThreadIdChange() {},
      getExtraDeveloperInstructions() {},
    },
    memoizedState: { memoizedState: { current: store }, next: null },
  }
  const composer: any = {
    return: owner,
    memoizedProps: { onSubmit() {}, models, selectedModel },
    memoizedState: { memoizedState: { current: store }, next: null },
  }
  const form: any = element({ tagName: 'FORM', draft: 'MANUAL DRAFT', attachments: ['manual'] })
  const editor: any = element({ parentElement: form })
  form.querySelectorAll = () => [editor]
  const fiber: any = { return: composer, stateNode: form }
  form.__reactFiber$test = fiber
  root.child = owner
  owner.child = composer
  composer.child = fiber
  const builder = function ({
    prompt,
    attachments,
    extraDeveloperInstructions,
    oneTurnDeveloperInstructions,
    systemHints,
  }: any) {
    calls.push([
      'build',
      {
        prompt,
        attachments,
        extraDeveloperInstructions,
        oneTurnDeveloperInstructions,
        systemHints,
      },
    ])
    return {
      extraDeveloperInstructionMessages: [],
      nativeExtra: 'kept',
      message: {
        id,
        author: { metadata: {}, name: null, role: 'user' },
        channel: null,
        content: {
          content_type: attachments.some((u: any) => u.mimeType?.startsWith('image/'))
            ? 'multimodal_text'
            : 'text',
          parts: [
            ...attachments
              .filter((u: any) => u.mimeType?.startsWith('image/'))
              .map((u: any) => ({
                content_type: 'image_asset_pointer',
                asset_pointer: u.id.startsWith('file_')
                  ? 'sediment://' + u.id
                  : 'file-service://' + u.id,
                width: u.width,
                height: u.height,
                size_bytes: u.size,
              })),
            prompt.trim(),
          ],
        },
        create_time: 1,
        end_turn: null,
        metadata: {
          attachments: attachments.map((u: any) => ({
            id: u.id,
            name: u.name,
            mime_type: u.mimeType,
            size: u.size,
            library_file_id: u.libraryFileId,
            retrieval_indexing_unavailable: u.retrievalIndexingUnavailable,
            width: u.width,
            height: u.height,
          })),
        },
        recipient: 'all',
        status: 'finished_successfully',
        update_time: null,
        weight: 1,
      },
    }
  }
  const completion = async function submitChatGPTCompletion(s: any, o: any) {
    // The sender also contains content_type/user/extraDeveloperInstructionMessages.
    calls.push(['send', s, o])
    o.onClientThreadIdChange?.('local-thread')
    return { clientThreadId: 'local-thread' }
  }
  const upload = async function uploadChatGptConversationFile(s: any, f: File, o: any) {
    calls.push(['upload', s, f, o])
    return {
      id: 'file-owned',
      name: f.name,
      mimeType: f.type,
      size: f.size,
      projectId: o.composerContext?.projectId,
      retrievalIndexingUnavailable: false,
    }
  }
  let snapshot: any = {
    conversation_id: id,
    gizmo_id: project,
    current_node: id,
    async_status: null,
    mapping: {
      [id]: {
        id,
        message: {
          id,
          author: { role: 'assistant' },
          channel: 'final',
          recipient: 'all',
          content: { content_type: 'text', parts: ['private response'] },
          status: 'finished_successfully',
          end_turn: true,
          metadata: {},
        },
      },
    },
  }
  const refetch = async function (s: any, cid: string, reason: string, options: any) {
    const markers =
      'chatgpt_conversation_refetch_started chatgpt_conversation_refetch_completed onSnapshotApply throwOnError preserveAsyncStatus mapping'
    if (String(arguments[2]) === markers) throw Error(markers)
    calls.push(['refetch', s, cid, reason, options])
    return snapshot
  }
  const namespace: any = { submitChatGPTCompletion: completion, d: builder, refetch }
  const aE = Symbol('async exports')
  const runtime: any = {
    aE,
    c: {
      arbitrary: { exports: { [aE]: namespace } },
      other: { exports: { uploadChatGptConversationFile: upload } },
    },
  }
  const page: any = {
    location: { origin: 'https://chatgpt.com' },
    performance: { getEntriesByType: () => [{ name: 'https://chatgpt.com/cdn/assets/random.js' }] },
    document: {
      defaultView: { getComputedStyle: (e: any) => e.style },
      querySelectorAll: (selector: string) =>
        selector === 'form'
          ? [form]
          : selector.includes('sidebar-project')
            ? [{ getAttribute: (key: string) => (key.endsWith('label') ? 'LocalGPT' : project) }]
            : [],
    },
    File,
    atob,
    crypto,
  }
  const deps = { loadModule: async () => ({ __webpack_require__: runtime }) }
  return {
    page,
    deps,
    calls,
    store,
    owner,
    composer,
    form,
    fiber,
    root,
    runtime,
    namespace,
    builder,
    refetch,
    get snapshot() {
      return snapshot
    },
    set snapshot(value: any) {
      snapshot = value
    },
  }
}

test('existing preparation uses exact keyed ABI without draft reads, navigation or hidden message exposure', async () => {
  const f = fixture()
  for (const target of [f.form, f.composer.memoizedProps])
    for (const key of ['draft', 'attachments', 'value'])
      Object.defineProperty(target, key, {
        get() {
          throw Error('manual read')
        },
        configurable: true,
      })
  Object.defineProperty(f.page.location, 'href', {
    get() {
      throw Error('route read')
    },
    set() {
      throw Error('navigation')
    },
  })
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  expect(await c.prepareExistingConversation!(id, project)).toEqual({
    conversationId: id,
    parentMessageId: id,
    projectId: project,
  })
  expect(f.calls).toEqual([
    ['refetch', f.store, id, 'localgpt-native-prepare', { throwOnError: true }],
  ])
  const other = '0c80500c-f930-4fca-a571-a68fc25d5a63'
  f.snapshot = { ...f.snapshot, conversation_id: other }
  expect(await c.prepareExistingConversation!(other, project)).toEqual({
    conversationId: other,
    parentMessageId: id,
    projectId: project,
  })
  expect(f.calls[1][2]).toBe(other)
})

test('refetch discovery requires every marker, rejects ambiguity and deduplicates function aliases', async () => {
  const f = fixture()
  f.runtime.c.alias = { exports: { arbitrary: f.refetch } }
  await discoverVerifiedNativeContract(f.page, f.deps)
  f.namespace.refetch = async function () {
    const markers =
      'chatgpt_conversation_refetch_started chatgpt_conversation_refetch_completed onSnapshotApply throwOnError preserveAsyncStatus mapping'
    if (String(arguments[2]) === markers) throw Error(markers)
  }
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_refetch_ambiguous',
  )
  for (const omitted of [
    'chatgpt_conversation_refetch_started',
    'chatgpt_conversation_refetch_completed',
    'onSnapshotApply',
    'throwOnError',
    'preserveAsyncStatus',
    'mapping',
  ]) {
    const g = fixture()
    g.namespace.refetch = new Function(
      `/* ${['chatgpt_conversation_refetch_started', 'chatgpt_conversation_refetch_completed', 'onSnapshotApply', 'throwOnError', 'preserveAsyncStatus', 'mapping'].filter((m) => m !== omitted).join(' ')} */`,
    )
    await expect(discoverVerifiedNativeContract(g.page, g.deps)).rejects.toThrow(
      'native_refetch_unavailable',
    )
    expect(g.calls).toEqual([])
  }
})

test('existing preparation refuses undefined, mismatched, malformed, hidden and nonterminal snapshots', async () => {
  for (const defect of [
    'undefined',
    'cid',
    'project',
    'mapping',
    'current',
    'node',
    'message',
    'role',
    'content',
    'parts',
    'status',
    'end',
    'hidden',
    'active',
    'unknown',
    'missingAdmission',
    'readOnly',
    'nativeReadOnly',
    'hiddenChannel',
    'foreignRecipient',
    'archived',
  ]) {
    const f = fixture(),
      s = f.snapshot,
      m = s.mapping[id].message
    if (defect === 'undefined') f.snapshot = undefined
    if (defect === 'cid') s.conversation_id = '0c80500c-f930-4fca-a571-a68fc25d5a63'
    if (defect === 'project') s.gizmo_id = 'g-p-ffffffffffffffffffffffffffffffff'
    if (defect === 'mapping') s.mapping = []
    if (defect === 'current') s.current_node = 'invalid'
    if (defect === 'node') s.mapping[id].id = 'wrong'
    if (defect === 'message') m.id = 'wrong'
    if (defect === 'role') m.author.role = 'user'
    if (defect === 'content') m.content.content_type = 'multimodal_text'
    if (defect === 'parts') m.content.parts = []
    if (defect === 'status') m.status = 'in_progress'
    if (defect === 'end') m.end_turn = false
    if (defect === 'hidden') m.metadata.is_visually_hidden_from_conversation = true
    if (defect === 'active') s.async_status = 'in_progress'
    if (defect === 'unknown') s.async_status = 'unknown'
    if (defect === 'missingAdmission') delete s.async_status
    if (defect === 'readOnly') s.read_only = true
    if (defect === 'nativeReadOnly') s.is_read_only = true
    if (defect === 'hiddenChannel') m.channel = 'analysis'
    if (defect === 'foreignRecipient') m.recipient = 'python'
    if (defect === 'archived') s.is_archived = true
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    await expect(c.prepareExistingConversation!(id, project)).rejects.toThrow('native_existing')
    expect(f.calls.map((call) => call[0])).toEqual(['refetch'])
  }
})

test('completed unread async conversations retain the exact terminal parent without marking read', async () => {
  const f = fixture()
  f.snapshot.async_status = 4
  f.snapshot.is_read_only = null
  f.snapshot.is_archived = false
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  expect(await c.prepareExistingConversation!(id, project)).toEqual({
    conversationId: id,
    parentMessageId: id,
    projectId: project,
  })
  expect(f.snapshot.async_status).toBe(4)
  expect(f.calls.map((call) => call[0])).toEqual(['refetch'])
})

test('unverified numeric, string and absent async states still refuse continuation', async () => {
  for (const status of [0, 1, 2, 3, 5, 6, 7, 8, '4', 'unknown', undefined]) {
    const f = fixture()
    f.snapshot.async_status = status
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    await expect(c.prepareExistingConversation!(id, project)).rejects.toThrow(
      'native_existing_not_admissible',
    )
    expect(f.calls.map((call) => call[0])).toEqual(['refetch'])
  }
})

test('unread state does not admit unfinished, hidden, non-text or foreign parents', async () => {
  for (const defect of [
    'status',
    'end',
    'hidden',
    'analysis',
    'thoughts',
    'recap',
    'nonText',
    'oldFinal',
    'emptyText',
    'blankText',
    'cid',
    'project',
    'readOnly',
    'archived',
  ]) {
    const f = fixture(),
      s = f.snapshot,
      m = s.mapping[id].message
    s.async_status = 4
    if (defect === 'status') m.status = 'in_progress'
    if (defect === 'end') m.end_turn = false
    if (defect === 'hidden') m.metadata.is_visually_hidden_from_conversation = true
    if (defect === 'analysis') m.channel = 'analysis'
    if (defect === 'thoughts') m.content.content_type = 'thoughts'
    if (defect === 'recap') m.content.content_type = 'reasoning_recap'
    if (defect === 'nonText') m.content.content_type = 'multimodal_text'
    if (defect === 'oldFinal') {
      const old = '0c80500c-f930-4fca-a571-a68fc25d5a63'
      s.mapping[old] = { ...s.mapping[id], id: old, message: { ...structuredClone(m), id: old } }
      m.author.role = 'user'
      expect(s.mapping[old].message.author.role).toBe('assistant')
    }
    if (defect === 'emptyText') m.content.parts = []
    if (defect === 'blankText') m.content.parts = ['  ']
    if (defect === 'cid') s.conversation_id = '0c80500c-f930-4fca-a571-a68fc25d5a63'
    if (defect === 'project') s.gizmo_id = 'g-p-ffffffffffffffffffffffffffffffff'
    if (defect === 'readOnly') s.read_only = true
    if (defect === 'archived') s.is_archived = true
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    const code =
      defect === 'cid'
        ? 'native_existing_snapshot_invalid'
        : defect === 'project'
          ? 'native_existing_project_mismatch'
          : ['readOnly', 'archived'].includes(defect)
            ? 'native_existing_not_admissible'
            : 'native_existing_parent_invalid'
    await expect(c.prepareExistingConversation!(id, project)).rejects.toThrow(code)
    expect(f.calls.map((call) => call[0])).toEqual(['refetch'])
  }
})

test('persisted project does not require sidebar visibility but visible conflicts are rejected', async () => {
  const f = fixture(),
    original = f.page.document.querySelectorAll
  f.page.document.querySelectorAll = (selector: string) =>
    selector.includes('sidebar-project') ? [] : original(selector)
  const c = await discoverVerifiedNativeContract(f.page, f.deps),
    built = c.build('hello', [])
  expect(c.projectRows).toEqual([])
  await c.submit(c.scope, {
    prompt: 'hello',
    model: 'instant',
    projectId: project,
    projectName: 'LocalGPT',
    userCompletionMessages: built,
  })
  f.page.document.querySelectorAll = (selector: string) =>
    selector.includes('sidebar-project')
      ? [
          {
            getAttribute: (key: string) =>
              key.endsWith('label') ? 'LocalGPT' : 'g-p-ffffffffffffffffffffffffffffffff',
          },
        ]
      : original(selector)
  expect(() =>
    c.submit(c.scope, {
      prompt: 'hello',
      model: 'instant',
      projectId: project,
      projectName: 'LocalGPT',
      userCompletionMessages: built,
    }),
  ).toThrow('native_project')
})

test('overlapping refetches retain independent requested CID and parent identities', async () => {
  const f = fixture(),
    other = '0c80500c-f930-4fca-a571-a68fc25d5a63'
  const pending = new Map<string, (snapshot: any) => void>()
  f.namespace.refetch = function (_scope: any, cid: string, _reason: string, _options: any) {
    const markers =
      'chatgpt_conversation_refetch_started chatgpt_conversation_refetch_completed onSnapshotApply throwOnError preserveAsyncStatus mapping'
    if (String(arguments[2]) === markers) throw Error(markers)
    return new Promise((resolve) => pending.set(cid, resolve))
  }
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  const a = c.prepareExistingConversation!(id, project),
    b = c.prepareExistingConversation!(other, project)
  pending.get(other)!({
    ...f.snapshot,
    conversation_id: other,
    current_node: other,
    mapping: { [other]: { id: other, message: { ...f.snapshot.mapping[id].message, id: other } } },
  })
  expect(await b).toEqual({ conversationId: other, parentMessageId: other, projectId: project })
  pending.get(id)!(f.snapshot)
  expect(await a).toEqual({ conversationId: id, parentMessageId: id, projectId: project })
  expect(f.calls).toEqual([])
})

test('invalid existing targets refuse before refetch and loader errors propagate once', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, f.deps)
  await expect(c.prepareExistingConversation!('invalid', project)).rejects.toThrow(
    'native_existing_conversation_invalid',
  )
  await expect(c.prepareExistingConversation!(id, 'invalid')).rejects.toThrow(
    'native_project_unavailable',
  )
  expect(f.calls).toEqual([])
  f.namespace.refetch = async function () {
    const markers =
      'chatgpt_conversation_refetch_started chatgpt_conversation_refetch_completed onSnapshotApply throwOnError preserveAsyncStatus mapping'
    if (String(arguments[2]) === markers) throw Error(markers)
    f.calls.push(['refetch failure'])
    throw Error('native fetch refused')
  }
  const d = await discoverVerifiedNativeContract(f.page, f.deps)
  await expect(d.prepareExistingConversation!(id, project)).rejects.toThrow('native fetch refused')
  expect(f.calls).toEqual([['refetch failure']])
})

test('visible persisted-project label conflicts and unresolved names never reach completion', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, f.deps),
    built = c.build('hello', [])
  const base = { prompt: 'hello', model: 'instant', userCompletionMessages: built }
  for (const options of [
    { ...base, projectId: 'invalid' },
    { ...base, projectId: project, projectName: 'Different' },
    { ...base, projectName: 'Unresolved' },
  ])
    expect(() => c.submit(c.scope, options)).toThrow('native_project')
  expect(f.calls.map((call) => call[0])).toEqual(['build'])
})

test('uploads require request-owned composer identity even with a valid model', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, f.deps),
    file = c.makeFile!({ name: 'a.txt', mime: 'text/plain', base64: 'YQ==' })
  const base = {
    isTemporaryChat: false,
    storeInLibrary: false,
    model: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
  }
  for (const composerContext of [
    undefined,
    { isProjectThread: false },
    { isProjectThread: false, messageId: 'bad' },
    { isProjectThread: false, messageId: id, projectId: project },
  ]) {
    await expect(c.upload(c.scope, file, { ...base, composerContext })).rejects.toThrow(
      'native_upload_context',
    )
  }
  const options = {
    ...base,
    composerContext: {
      isProjectThread: true,
      messageId: id,
      projectId: 'g-p-ffffffffffffffffffffffffffffffff',
    },
  }
  await c.upload(c.scope, file, options)
  expect(f.calls[0][3]).toBe(options)
})

test('factory resolves cached async namespace, associated store and exact sidebar attributes without sends', async () => {
  const f = fixture(),
    contract = await discoverVerifiedNativeContract(f.page, f.deps)
  expect(contract.scope).toBe(f.store)
  expect(contract.projectRows).toEqual([{ label: 'LocalGPT', id: project }])
  expect(f.calls).toEqual([])
  const prepared: any = await contract.build('  ORIGINAL prompt  ', [])
  expect(f.calls[0][1]).toEqual({
    prompt: '  ORIGINAL prompt  ',
    attachments: [],
    extraDeveloperInstructions: [],
    oneTurnDeveloperInstructions: [],
    systemHints: [],
  })
  expect(prepared.message.content.parts).toEqual(['  ORIGINAL prompt  '])
  expect(prepared.message.status).toBe('finished_successfully')
  expect(f.form.draft).toBe('MANUAL DRAFT')
  expect(f.form.attachments).toEqual(['manual'])
})

test('array compatibility sends SDK prepared object, preserves fields, callbacks and explicit UUID', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, f.deps)
  const built: any = await c.build('hello', [])
  const explicit = '0c80500c-f930-4fca-a571-a68fc25d5a63'
  let client = ''
  const validated = validatePreparedMessage(built, 'hello', explicit)
  const receipt = await c.submit(c.scope, {
    model: 'instant',
    thinkingEffort: null,
    prompt: 'hello',
    userCompletionMessages: [validated.message],
    onClientThreadIdChange: (v: string) => {
      client = v
    },
  })
  const options = f.calls[1][2]
  expect(options.userCompletionMessages.message.id).toBe(explicit)
  expect(options.userCompletionMessages.extraDeveloperInstructionMessages).toEqual([])
  expect(options.userCompletionMessages.nativeExtra).toBe('kept')
  expect(options.requireDispatchAcceptance).toBe(true)
  expect(options.requireResponseAcceptance).toBe(false)
  expect(client).toBe('local-thread')
  expect(receipt).toEqual({ clientThreadId: 'local-thread' })
})

test('upload requires caller-owned model context and preserves project options and native flags', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, f.deps)
  const input = { name: 'input.txt', mime: 'text/plain', base64: 'YQ==' }
  const file = c.makeFile!(input)
  await expect(
    c.upload(c.scope, file, { isTemporaryChat: false, storeInLibrary: false }),
  ).rejects.toThrow('native_upload_context_required')
  const options = {
    isTemporaryChat: false,
    storeInLibrary: false,
    model: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
    composerContext: { projectId: project, isProjectThread: true, messageId: id },
    signal: new AbortController().signal,
  }
  const result = await c.upload(c.scope, file, options)
  expect(f.calls[0][3]).toBe(options)
  expect(await f.calls[0][2].text()).toBe('a')
  expect(c.validateUpload!(result, input)).toEqual(result)
  expect(() => c.validateUpload!({ ...result, size: 2 }, input)).toThrow(
    'native_upload_result_invalid',
  )
  expect(() => c.makeFile!({ ...input, base64: '**' })).toThrow('native_file_invalid')
})

test('ambiguity rejects duplicate senders, builders and root store identities', async () => {
  for (const kind of ['sender', 'uploader', 'builder', 'store']) {
    const f = fixture()
    if (kind === 'sender')
      f.runtime.c.third = { exports: { submitChatGPTCompletion: async () => {} } }
    if (kind === 'uploader')
      f.runtime.c.third = { exports: { uploadChatGptConversationFile: async () => {} } }
    if (kind === 'builder')
      f.namespace.second = function (arg: any) {
        const {
          prompt,
          attachments,
          extraDeveloperInstructions,
          oneTurnDeveloperInstructions,
          systemHints,
        } = arg
        return {
          message: { content_type: 'text', role: 'user' },
          extraDeveloperInstructionMessages: [],
          prompt,
          attachments,
          extraDeveloperInstructions,
          oneTurnDeveloperInstructions,
          systemHints,
        }
      }
    if (kind === 'store')
      f.owner.memoizedState.next = {
        memoizedState: { current: { ...f.store, node: {} } },
        next: null,
      }
    await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow('ambiguous')
    expect(f.calls).toEqual([])
  }
})

test('builder only qualifies within completion namespace; async sender lookalikes are excluded', async () => {
  const f = fixture()
  delete f.namespace.d
  f.runtime.c.decoy = { exports: { d: f.builder } }
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_builder_unavailable',
  )
})

test('uses current React tree rather than stale alternate and rechecks before operations', async () => {
  const f = fixture()
  const stale = {
    ...f.fiber,
    return: {
      ...f.composer,
      memoizedProps: { ...f.composer.memoizedProps, selectedModel: { slug: 'wrong' } },
    },
  }
  f.form.__reactFiber$test = stale
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  expect(c.selected).toEqual(f.composer.memoizedProps.selectedModel)
  f.owner.memoizedState = { memoizedState: { current: { ...f.store, scope: {} } }, next: null }
  expect(() => c.build('hello', [])).toThrow('native_store')
  expect(f.calls).toEqual([])
})

test('runtime discovery imports observed same-origin assets only, rejects multiple runtimes', async () => {
  const f = fixture(),
    urls: string[] = []
  f.page.performance.getEntriesByType = () =>
    [
      'https://evil.example/cdn/assets/a.js',
      'https://chatgpt.com/cdn/assets/a.js?token=x',
      'https://chatgpt.com/cdn/assets/a.js',
      'https://chatgpt.com/cdn/assets/b.js',
    ].map((name) => ({ name }))
  await expect(
    discoverVerifiedNativeContract(f.page, {
      loadModule: async (url) => {
        urls.push(url)
        return { __webpack_require__: { ...f.runtime } }
      },
    }),
  ).rejects.toThrow('native_runtime_ambiguous')
  expect(urls).toEqual([
    'https://chatgpt.com/cdn/assets/a.js',
    'https://chatgpt.com/cdn/assets/b.js',
  ])
})

test('native async rejection is propagated once, never retried or interpreted as termination', async () => {
  const f = fixture()
  let sends = 0
  f.namespace.submitChatGPTCompletion = async () => {
    sends++
    throw Error('after possible send')
  }
  const c = await discoverVerifiedNativeContract(f.page, f.deps),
    built = await c.build('hello', [])
  await expect(
    c.submit(c.scope, { model: 'instant', prompt: 'hello', userCompletionMessages: built }),
  ).rejects.toThrow('after possible send')
  expect(sends).toBe(1)
})

test('explicit build UUID and complete prepared-object API do not rewrite native fields', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, f.deps)
  const explicit = '0c80500c-f930-4fca-a571-a68fc25d5a63'
  const built: any = await c.build('hello', [], { nativeUserMessageId: explicit })
  expect(built.message.id).toBe(explicit)
  await c.submit(c.scope, { model: 'instant', prompt: 'hello', userCompletionMessages: built })
  expect(f.calls[1][2].userCompletionMessages).toBe(built)
  expect(built.message.author).toEqual({ metadata: {}, name: null, role: 'user' })
  expect(() => c.build('hello', [], { nativeUserMessageId: 'invalid' })).toThrow(
    'native_message_id_invalid',
  )
})

test('builder output validation rejects missing native fields and changed prompt before sending', async () => {
  for (const defect of ['missing', 'prompt']) {
    const f = fixture()
    f.namespace.d = function ({
      prompt,
      attachments,
      extraDeveloperInstructions,
      oneTurnDeveloperInstructions,
      systemHints,
    }: any) {
      return {
        extraDeveloperInstructionMessages: [],
        message: {
          id,
          author: { role: 'user', metadata: {}, name: null },
          channel: null,
          end_turn: null,
          update_time: null,
          create_time: 1,
          metadata: { attachments },
          content: { content_type: 'text', parts: [defect === 'prompt' ? 'WRONG' : prompt] },
          recipient: 'all',
          weight: 1,
          status: defect === 'missing' ? undefined : 'finished_successfully',
        },
        extraDeveloperInstructions,
        oneTurnDeveloperInstructions,
        systemHints,
      }
    }
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    expect(() => c.build('hello', [])).toThrow(
      defect === 'missing' ? 'native_prepared_invalid' : 'native_prompt_mismatch',
    )
    expect(f.calls).toEqual([])
  }
})

test('root association matches both identities, deduplicates references and never chooses first root store', async () => {
  const f = fixture(),
    wrong = { ...f.store, queryClient: {} }
  f.owner.memoizedState = {
    memoizedState: { current: wrong },
    next: {
      memoizedState: { current: f.store },
      next: { memoizedState: { current: f.store }, next: null },
    },
  }
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  expect(c.scope).toBe(f.store)
  f.store.scope = {}
  expect(() => c.build('hello', [])).toThrow('native_store_stale')
  expect(f.calls).toEqual([])
})

test('unresolved async cache is not awaited or invoked; aliases of same exports are deduplicated', async () => {
  const f = fixture()
  let invoked = false
  f.runtime.c.pending = {
    exports: {
      [f.runtime.aE]: {
        then() {
          invoked = true
        },
      },
    },
  }
  f.runtime.c.alias = { exports: f.namespace }
  await discoverVerifiedNativeContract(f.page, f.deps)
  expect(invoked).toBe(false)
  expect(f.calls).toEqual([])
})

test('standard image decoding uses real bounded dimensions and closes decoded bitmap', async () => {
  const f = fixture()
  let closed = 0
  const c = await discoverVerifiedNativeContract(f.page, {
    ...f.deps,
    decodeImage: async (file) => {
      expect(file.type).toBe('image/png')
      return {
        width: 640,
        height: 480,
        close: () => {
          closed++
        },
      }
    },
  })
  const input = { name: 'input.png', mime: 'image/png', base64: 'YQ==' }
  const options = {
    isTemporaryChat: false,
    storeInLibrary: false,
    model: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
    composerContext: { isProjectThread: false, messageId: id },
  }
  const result = await c.upload(c.scope, c.makeFile!(input), options)
  expect(result.width).toBe(640)
  expect(result.height).toBe(480)
  expect(closed).toBe(1)
  expect(c.validateUpload!(result, input)).toEqual(result)
  const huge = await discoverVerifiedNativeContract(f.page, {
    ...f.deps,
    decodeImage: async () => ({
      width: 40000,
      height: 1,
      close: () => {
        closed++
      },
    }),
  })
  await expect(huge.upload(huge.scope, huge.makeFile!(input), options)).rejects.toThrow(
    'native_image_dimensions_invalid',
  )
  expect(closed).toBe(2)
  expect(f.calls.length).toBe(1)
})

test('image uploads fail closed without a standard decoder; malformed native refs are rejected', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, f.deps)
  const input = { name: 'input.png', mime: 'image/png', base64: 'YQ==' }
  await expect(
    c.upload(c.scope, c.makeFile!(input), {
      isTemporaryChat: false,
      storeInLibrary: false,
      model: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
      composerContext: { isProjectThread: false, messageId: id },
    }),
  ).rejects.toThrow('native_image_decoder_unavailable')
  for (const result of [
    { id: 'arbitrary' },
    {
      id: 'file-x',
      name: input.name,
      mimeType: input.mime,
      size: 1,
      retrievalIndexingUnavailable: 'yes',
    },
  ]) {
    expect(() => c.validateUpload!(result, input)).toThrow('native_upload_result_invalid')
  }
  expect(f.calls).toEqual([])
})

test('caller model/lane/effort and project context are checked without borrowing selected UI state', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, f.deps)
  const input = { name: 'input.txt', mime: 'text/plain', base64: 'YQ==' },
    file = c.makeFile!(input)
  const base = {
    isTemporaryChat: false,
    storeInLibrary: false,
    model: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
    composerContext: { isProjectThread: false, messageId: id },
  }
  for (const bad of [
    { ...base, model: { ...base.model, slug: 'base' } },
    { ...base, model: { ...base.model, thinkingEffort: 'high' } },
    { ...base, composerContext: { isProjectThread: true } },
    { ...base, composerContext: { isProjectThread: true, projectId: 'invalid', messageId: id } },
  ]) {
    await expect(c.upload(c.scope, file, bad)).rejects.toThrow()
  }
  expect(f.calls).toEqual([])
  expect(f.composer.memoizedProps.selectedModel).toEqual(c.selected)
  expect(f.form.draft).toBe('MANUAL DRAFT')
})

test('isolated native refs survive the builder and manual draft/attachments are never read', async () => {
  const f = fixture()
  for (const target of [f.form, f.composer.memoizedProps])
    for (const key of ['draft', 'attachments', 'value'])
      Object.defineProperty(target, key, {
        get() {
          throw Error('manual composer read')
        },
        configurable: true,
      })
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  const refs = [
    {
      id: 'file_native_reference',
      name: 'input.txt',
      mimeType: 'text/plain',
      size: 1,
      libraryStorageLimitFallback: false,
    },
  ]
  const built: any = await c.build('hello', refs)
  c.validatePreparedUploads!(built, refs)
  expect(built.message.metadata.attachments).toEqual(
    refs.map((u: any) => ({
      id: u.id,
      name: u.name,
      mime_type: u.mimeType,
      size: u.size,
      library_file_id: u.libraryFileId,
      retrieval_indexing_unavailable: u.retrievalIndexingUnavailable,
      width: u.width,
      height: u.height,
    })),
  )
  expect(() =>
    c.validatePreparedUploads!({ ...built, message: { ...built.message, metadata: {} } }, refs),
  ).toThrow('native_upload_message_mismatch')
  await c.submit(c.scope, { model: 'instant', prompt: 'hello', userCompletionMessages: built })
  expect(f.calls[1][2].prompt).toBe('hello')
})

test('array adapter rejects forged/cloned changes and ambiguous lost prepared-object fields', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, f.deps)
  const built: any = await c.build('hello', [])
  expect(() =>
    c.submit(c.scope, {
      model: 'instant',
      prompt: 'hello',
      userCompletionMessages: [{ ...built.message, recipient: 'different' }],
    }),
  ).toThrow('native_prepared_unowned')
  expect(() =>
    c.submit(c.scope, {
      model: 'instant',
      prompt: 'hello',
      userCompletionMessages: { ...built, nativeExtra: 'modified' },
    }),
  ).toThrow('native_prepared_unowned')
  expect(f.calls.length).toBe(1)
  const g = fixture()
  let serial = 0
  g.namespace.d = function ({
    prompt,
    attachments,
    extraDeveloperInstructions,
    oneTurnDeveloperInstructions,
    systemHints,
  }: any) {
    return {
      extraDeveloperInstructionMessages: [],
      serial: serial++,
      message: {
        id,
        author: { role: 'user', metadata: {}, name: null },
        channel: null,
        end_turn: null,
        update_time: null,
        create_time: 1,
        metadata: { attachments },
        content: { content_type: 'text', parts: [prompt] },
        recipient: 'all',
        weight: 1,
        status: 'finished_successfully',
      },
      extraDeveloperInstructions,
      oneTurnDeveloperInstructions,
      systemHints,
    }
  }
  const d = await discoverVerifiedNativeContract(g.page, g.deps),
    first: any = await d.build('same', [])
  await d.build('same', [])
  expect(() =>
    d.submit(d.scope, {
      model: 'instant',
      prompt: 'same',
      userCompletionMessages: [first.message],
    }),
  ).toThrow('native_prepared_ambiguous')
  expect(g.calls).toEqual([])
})

test('detached/unassociated current tree and multiple composers are rejected before native invocation', async () => {
  for (const defect of ['detached', 'multiple']) {
    const f = fixture()
    if (defect === 'detached') f.root.child = null
    else {
      const form = { ...f.form },
        fiber = { ...f.fiber, stateNode: form }
      form.__reactFiber$test = fiber
      form.querySelectorAll = () => [element({ parentElement: form })]
      f.fiber.sibling = fiber
      const original = f.page.document.querySelectorAll
      f.page.document.querySelectorAll = (selector: string) =>
        selector === 'form' ? [f.form, form] : original(selector)
    }
    await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
      defect === 'detached' ? 'native_current_form_unavailable' : 'native_composer_ambiguous',
    )
    expect(f.calls).toEqual([])
  }
})

test('owned image reference survives native metadata and content transformations', async () => {
  const f = fixture(),
    c = await discoverVerifiedNativeContract(f.page, {
      ...f.deps,
      decodeImage: async () => ({ width: 640, height: 480 }),
    })
  const input = { name: 'input.png', mime: 'image/png', base64: 'YQ==' }
  const uploaded = await c.upload(c.scope, c.makeFile!(input), {
    isTemporaryChat: false,
    storeInLibrary: false,
    model: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
    composerContext: { isProjectThread: false, messageId: id },
  })
  const built: any = c.build('look', [uploaded], { nativeUserMessageId: id })
  expect(built.message.metadata.attachments[0]).toMatchObject({
    id: 'file-owned',
    mime_type: 'image/png',
    width: 640,
    height: 480,
  })
  expect(built.message.content.parts[0]).toEqual({
    content_type: 'image_asset_pointer',
    asset_pointer: 'file-service://file-owned',
    width: 640,
    height: 480,
    size_bytes: 1,
  })
  expect(() =>
    c.validatePreparedUploads!(
      {
        ...built,
        message: {
          ...built.message,
          content: {
            ...built.message.content,
            parts: [
              { ...built.message.content.parts[0], asset_pointer: 'file-service://foreign' },
              'look',
            ],
          },
        },
      },
      [uploaded],
    ),
  ).toThrow('native_upload_message_mismatch')
})

test('observed native runtime remains discoverable after resource timings and script tags clear', async () => {
  const f = fixture()
  await discoverVerifiedNativeContract(f.page, f.deps)
  f.page.performance.getEntriesByType = () => []
  f.page.document.querySelectorAll = (
    (original: any) => (selector: string) =>
      selector === 'script[src]' || selector === 'link[rel="modulepreload"][href]'
        ? []
        : original(selector)
  )(f.page.document.querySelectorAll)
  const contract = await discoverVerifiedNativeContract(f.page, f.deps)
  expect(contract.scope).toBe(f.store)
})

// The live SDK's ep(e) factory wraps one shared node/chain/scope/queryClient in a
// fresh handle per consumer, so aliases are distinct objects with identical raw context.
function handle(shared: any, overrides: any = {}) {
  const h: any = {
    chain: shared.chain,
    getOwnValue() {},
    node: shared.node,
    queryClient: shared.queryClient,
    scope: shared.scope,
    value: {},
    get() {},
    query() {},
    set() {},
    watch() {},
    when() {},
    ...overrides,
  }
  return h
}
function liveShared(f: any) {
  return {
    chain: new Map(),
    node: {},
    queryClient: f.store.queryClient,
    scope: f.store.scope,
  }
}
function chainHooks(...stores: any[]) {
  return stores.reduceRight(
    (next: any, store) => ({ memoizedState: { current: store }, next }),
    null,
  )
}
function liveFixture() {
  const f = fixture()
  const shared = liveShared(f)
  const C = handle(shared),
    O1 = handle(shared),
    O2 = handle(shared)
  const derived = (extra = {}) =>
    handle({ ...shared, scope: {}, node: {}, chain: new Map() }, extra)
  f.composer.memoizedState = chainHooks(C, derived(), derived())
  f.owner.memoizedState = chainHooks(derived(), O1, derived(), O2)
  return { ...f, shared, C, O1, O2, derived }
}
test('live ep(e)-style aliases bind the composer handle, never an owner alias', async () => {
  const f = liveFixture()
  expect(f.C).not.toBe(f.O1)
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  expect(c.scope).toBe(f.C)
  expect(c.scope).not.toBe(f.O1)
  expect(c.scope).not.toBe(f.O2)
  f.O1.value = { changed: true }
  f.C.value = { changed: true }
  expect(() => c.build('hello', [])).not.toThrow()
})
test('equal primitive node or chain values cannot establish a native store binding', async () => {
  for (const key of ['node', 'chain'] as const) {
    for (const value of [undefined, null, 0, 'shared']) {
      const f = liveFixture()
      f.C[key] = f.O1[key] = f.O2[key] = value
      await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
        'native_store_context_invalid',
      )
      expect(f.calls).toEqual([])
    }
  }
})
test('owner aliases with a different node or chain remain ambiguous; none is unavailable', async () => {
  for (const [defect, code] of [
    ['node', 'native_store_ambiguous'],
    ['chain', 'native_store_ambiguous'],
    ['none', 'native_store_unavailable'],
  ] as const) {
    const f = liveFixture()
    if (defect === 'node') f.O2.node = {}
    if (defect === 'chain') f.O2.chain = new Map()
    if (defect === 'none') f.owner.memoizedState = chainHooks(f.derived(), f.derived())
    await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(code)
    expect(f.calls).toEqual([])
  }
})
test('in-place node or chain changes on the bound handle fail closed; value does not', async () => {
  for (const key of ['node', 'chain'] as const) {
    const f = liveFixture()
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    f.C[key] = key === 'node' ? {} : new Map()
    expect(() => c.build('hello', [])).toThrow('native_store_stale')
    await expect(c.readConversationSnapshot!(id, new AbortController().signal)).rejects.toThrow(
      'native_store_stale',
    )
    expect(f.calls).toEqual([])
  }
})
test('in-place context changes during async refetch or upload are rejected after the await', async () => {
  for (const key of ['node', 'chain'] as const) {
    const mutate = (g: any, name: string) => {
      const push = g.calls.push.bind(g.calls)
      g.calls.push = (...items: any[]) => {
        if (items[0]?.[0] === name) g.C[key] = key === 'node' ? {} : new Map()
        return push(...items)
      }
    }
    const f = liveFixture()
    mutate(f, 'refetch')
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    await expect(c.prepareExistingConversation!(id, project)).rejects.toThrow('native_store_stale')
    const g = liveFixture()
    mutate(g, 'upload')
    const d = await discoverVerifiedNativeContract(g.page, g.deps)
    await expect(
      d.upload(d.scope, d.makeFile!({ name: 'a.txt', mime: 'text/plain', base64: 'YQ==' }), {
        isTemporaryChat: false,
        storeInLibrary: false,
        model: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
        composerContext: { isProjectThread: false, messageId: id },
      }),
    ).rejects.toThrow('native_store_stale')
  }
})
const thinkingModels = () => ({
  versionOptions: [
    {
      id: 'latest',
      slugs: ['gpt-6-thinking', 'gpt-6-instant', 'gpt-6-pro'],
      options: [
        { slug: 'gpt-6-thinking', thinkingEffort: 'standard', isAvailable: true },
        { slug: 'gpt-6-thinking', thinkingEffort: 'extended', isAvailable: true },
        { slug: 'gpt-6-thinking', thinkingEffort: 'max', isAvailable: true },
        { slug: 'gpt-6-instant', isAvailable: true },
        { slug: 'gpt-6-pro', thinkingEffort: 'extended', isAvailable: true },
      ],
    },
  ],
})
test('unresolved null selected effort is ready but never guessed for requests', async () => {
  const { selectNativeModel } = await import('../src/native-chat')
  const f = fixture()
  f.composer.memoizedProps.models = thinkingModels()
  f.composer.memoizedProps.selectedModel = {
    slug: 'gpt-6-thinking',
    versionId: 'latest',
    thinkingEffort: null,
  }
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  expect(c.selected).toEqual({ slug: 'gpt-6-thinking', versionId: 'latest', thinkingEffort: null })
  expect(selectNativeModel(c.models, c.selected, 'gpt-6-instant')).toMatchObject({
    model: 'gpt-6-instant',
    thinkingEffort: null,
  })
  expect(selectNativeModel(c.models, c.selected, 'gpt-6-pro')).toMatchObject({
    thinkingEffort: 'extended',
  })
  expect(selectNativeModel(c.models, c.selected, 'gpt-6-thinking', 'max')).toMatchObject({
    thinkingEffort: 'max',
  })
  expect(() => selectNativeModel(c.models, c.selected)).toThrow()
  expect(() => selectNativeModel(c.models, c.selected, 'gpt-6-thinking')).toThrow()
  expect(() => selectNativeModel(c.models, c.selected, 'gpt-6-thinking', 'bogus')).toThrow()
  // Submit-time validation stays exact.
  const built = c.build('hello', [])
  expect(() =>
    c.submit(c.scope, { model: 'gpt-6-thinking', prompt: 'hello', userCompletionMessages: built }),
  ).toThrow('native_model_unavailable')
  expect(f.calls.filter((x) => x[0] === 'send')).toEqual([])
})
test('explicit Instant submits once while the selected Thinking effort remains unresolved', async () => {
  const f = fixture()
  f.composer.memoizedProps.models = thinkingModels()
  const selected = { slug: 'gpt-6-thinking', versionId: 'latest', thinkingEffort: null }
  f.composer.memoizedProps.selectedModel = selected
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  const built = c.build('hello', [])
  await c.submit(c.scope, {
    model: 'gpt-6-instant',
    thinkingEffort: null,
    prompt: 'hello',
    userCompletionMessages: built,
  })
  const sends = f.calls.filter((x) => x[0] === 'send')
  expect(sends).toHaveLength(1)
  expect(sends[0][1]).toBe(f.store)
  expect(sends[0][2].model).toBe('gpt-6-instant')
  expect(f.composer.memoizedProps.selectedModel).toBe(selected)
  expect(selected.thinkingEffort).toBeNull()
})
test('readiness still rejects structurally invalid or unusable selected catalogs', async () => {
  const cases: [string, (f: any) => void, string][] = [
    [
      'unknown version',
      (f) => (f.composer.memoizedProps.selectedModel.versionId = 'old'),
      'native_model_unavailable',
    ],
    [
      'unknown slug',
      (f) => (f.composer.memoizedProps.selectedModel.slug = 'nope'),
      'native_model_unavailable',
    ],
    [
      'unavailable options',
      (f) =>
        f.composer.memoizedProps.models.versionOptions[0].options.forEach(
          (o: any) => (o.isAvailable = false),
        ),
      'native_model_unavailable',
    ],
    [
      'bogus non-null effort',
      (f) => (f.composer.memoizedProps.selectedModel.thinkingEffort = 'bogus'),
      'native_model_unavailable',
    ],
    [
      'non-string effort',
      (f) => (f.composer.memoizedProps.selectedModel.thinkingEffort = 7),
      'native_models_invalid',
    ],
    [
      'no versions',
      (f) => (f.composer.memoizedProps.models.versionOptions = []),
      'native_models_invalid',
    ],
  ]
  for (const [, mutate, code] of cases) {
    const f = fixture()
    f.composer.memoizedProps.models = thinkingModels()
    f.composer.memoizedProps.selectedModel = {
      slug: 'gpt-6-thinking',
      versionId: 'latest',
      thinkingEffort: null,
    }
    mutate(f)
    await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(code)
  }
})

// Extra mounted React forms whose fibers must never be read unless rendered.
function mount(f: any, hide: (form: any) => void, readable = false) {
  const form = element({ tagName: 'FORM' }),
    editor = element({ parentElement: form })
  form.querySelectorAll = () => [editor]
  form.reads = 0
  const fiber = { return: f.composer, stateNode: form, sibling: f.fiber.sibling }
  f.fiber.sibling = fiber
  Object.defineProperty(form, '__reactFiber$extra', {
    enumerable: true,
    get() {
      form.reads++
      if (!readable) throw new Error('hidden fiber read')
      return fiber
    },
  })
  hide(form)
  const original = f.page.document.querySelectorAll
  f.page.document.querySelectorAll = (selector: string) =>
    selector === 'form' ? [...original(selector), form] : original(selector)
  return form
}
const hiders: Record<string, (form: any) => void> = {
  'display:none ancestor': (form) => {
    form.parentElement = element({ style: { display: 'none', visibility: 'visible' } })
    form.rects = []
  },
  'hidden ancestor': (form) => {
    form.parentElement = element({
      hidden: true,
      style: { display: 'none', visibility: 'visible' },
    })
  },
  'visibility:hidden': (form) => {
    form.style = { display: 'block', visibility: 'hidden' }
    form.querySelectorAll()[0].style.visibility = 'hidden'
  },
  'visibility:collapse': (form) => {
    form.style = { display: 'block', visibility: 'collapse' }
    form.querySelectorAll()[0].style.visibility = 'collapse'
  },
  'zero rect': (form) => {
    form.rects = [{ width: 0, height: 0 }]
    form.querySelectorAll()[0].rects = [{ width: 0, height: 0 }]
  },
  'no rects': (form) => {
    form.rects = []
    form.querySelectorAll()[0].rects = []
  },
  disconnected: (form) => {
    form.isConnected = false
  },
}

test('one rendered composer works while hidden mounted composers are never inspected', async () => {
  const f = fixture(),
    mounted = Object.values(hiders).map((hide) => mount(f, hide))
  f.page.document.hasFocus = () => false
  f.page.document.visibilityState = 'hidden'
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  expect(c.scope).toBe(f.store)
  expect(mounted.map((m) => m.reads)).toEqual(mounted.map(() => 0))
})

test('a form with only a hidden editor is not a rendered composer', async () => {
  const f = fixture(),
    editor = f.form.querySelectorAll()[0]
  editor.parentElement = element({ style: { display: 'none', visibility: 'visible' } })
  editor.rects = []
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_composer_unavailable',
  )
})

test('zero rendered composers are unavailable and two rendered composers are ambiguous', async () => {
  const f = fixture()
  hiders['display:none ancestor']!(f.form)
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_composer_unavailable',
  )
  const g = fixture()
  mount(g, () => {}, true)
  await expect(discoverVerifiedNativeContract(g.page, g.deps)).rejects.toThrow(
    'native_composer_ambiguous',
  )
})

test('a connected form in a detached React tree is distinct from a disconnected DOM form', async () => {
  const f = fixture()
  f.root.child = null
  expect(f.form.isConnected).toBe(true)
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_current_form_unavailable',
  )
  const g = fixture()
  g.form.isConnected = false
  await expect(discoverVerifiedNativeContract(g.page, g.deps)).rejects.toThrow(
    'native_composer_unavailable',
  )
})

test('malformed, throwing or non-finite geometry refuses instead of skipping a candidate', async () => {
  const cycle = element()
  cycle.parentElement = cycle
  const bad: Record<string, (form: any) => void> = {
    'missing connectedness': (form) => delete form.isConnected,
    'malformed connectedness': (form) => (form.isConnected = 'true'),
    'malformed visibility': (form) => (form.style.visibility = 'unknown'),
    'missing getClientRects': (form) => (form.getClientRects = undefined),
    'throwing getClientRects': (form) =>
      (form.getClientRects = () => {
        throw new Error('boom')
      }),
    'non-array rects': (form) => (form.rects = {}),
    NaN: (form) => (form.rects = [{ width: NaN, height: 5 }]),
    Infinity: (form) => (form.rects = [{ width: Infinity, height: 5 }]),
    negative: (form) => (form.rects = [{ width: -1, height: 5 }]),
    'string size': (form) => (form.rects = [{ width: '10', height: 5 }]),
    'throwing style': (form) =>
      Object.defineProperty(form, 'style', {
        get() {
          throw new Error('boom')
        },
      }),
    'ancestor cycle': (form) => (form.parentElement = cycle),
    'throwing editor lookup': (form) =>
      (form.querySelectorAll = () => {
        throw new Error('boom')
      }),
  }
  for (const [name, defect] of Object.entries(bad)) {
    const alone = fixture()
    defect(alone.form)
    await expect(discoverVerifiedNativeContract(alone.page, alone.deps), name).rejects.toThrow(
      'native_composer_unavailable',
    )
    const beside = fixture()
    mount(beside, defect)
    await expect(discoverVerifiedNativeContract(beside.page, beside.deps), name).rejects.toThrow(
      'native_composer_unavailable',
    )
  }
})

test('selected composer hiding, removal or replacement across SDK awaits is stale', async () => {
  const drift: Record<string, (f: any) => void> = {
    hidden: (f) => hiders['display:none ancestor']!(f.form),
    removed: (f) => (f.form.isConnected = false),
    replaced: (f) => {
      mount(f, () => {}, true)
      hiders['display:none ancestor']!(f.form)
    },
  }
  const stale = /native_store_stale|native_composer_unavailable/
  for (const [name, change] of Object.entries(drift)) {
    const f = fixture(),
      push = f.calls.push.bind(f.calls)
    // The SDK refetch is matched by source text, so drift is injected on its call record.
    f.calls.push = (...items: any[]) => {
      if (items[0]?.[0] === 'refetch') change(f)
      return push(...items)
    }
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    await expect(
      c.readConversationSnapshot!(id, new AbortController().signal),
      name,
    ).rejects.toThrow(stale)
    const g = fixture(),
      d = await discoverVerifiedNativeContract(g.page, g.deps)
    change(g)
    await expect(
      d.readConversationSnapshot!(id, new AbortController().signal),
      name,
    ).rejects.toThrow(stale)
    expect(g.calls.map((call: any) => call[0])).not.toContain('refetch')
  }
})

test('multiple rendered editors in one composer are refused before SDK calls', async () => {
  const f = fixture(),
    editor = f.form.querySelectorAll()[0],
    second = element({ parentElement: f.form })
  f.form.querySelectorAll = () => [editor, second]
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_composer_ambiguous',
  )
  expect(f.calls).toEqual([])
})

test('accessibility hints and CSS overrides preserve ambiguity for rendered composers', async () => {
  for (const parent of [
    element({ attrs: { 'aria-hidden': 'true' } }),
    element({ hidden: true }),
    element({ style: { display: 'block', visibility: 'hidden' } }),
  ]) {
    const f = fixture()
    mount(
      f,
      (form) => {
        form.parentElement = parent
      },
      true,
    )
    await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
      'native_composer_ambiguous',
    )
    expect(f.calls).toEqual([])
  }
})

test('oversized layout and editor collections refuse before unbounded traversal', async () => {
  const f = fixture()
  f.form.rects = Array.from({ length: 513 }, () => ({ width: 100, height: 20 }))
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_composer_unavailable',
  )
  const g = fixture(),
    editor = g.form.querySelectorAll()[0]
  g.form.querySelectorAll = () => Array(513).fill(editor)
  await expect(discoverVerifiedNativeContract(g.page, g.deps)).rejects.toThrow(
    'native_composer_unavailable',
  )
  expect(f.calls).toEqual([])
  expect(g.calls).toEqual([])
})

test('a rendered editor belonging to a different form cannot establish composer eligibility', async () => {
  const f = fixture(),
    foreignForm = element({ tagName: 'FORM' }),
    editor = element({ parentElement: foreignForm })
  f.form.querySelectorAll = () => [editor]
  await expect(discoverVerifiedNativeContract(f.page, f.deps)).rejects.toThrow(
    'native_composer_unavailable',
  )
  expect(f.calls).toEqual([])
})

const renderedChildLayouts: Record<string, (form: any) => void> = {
  'visible editor overrides hidden form': (form) => {
    form.style.visibility = 'hidden'
  },
  'display contents form': (form) => {
    form.style.display = 'contents'
    form.rects = []
  },
  'zero-size form with overflowing editor': (form) => {
    form.rects = [{ width: 0, height: 0 }]
  },
}

test('rendered editor competitors remain ambiguous when their forms lack visible boxes', async () => {
  for (const [name, layout] of Object.entries(renderedChildLayouts)) {
    const f = fixture()
    mount(f, layout, true)
    await expect(discoverVerifiedNativeContract(f.page, f.deps), name).rejects.toThrow(
      'native_composer_ambiguous',
    )
    expect(f.calls).toEqual([])
  }
})

test('a lone rendered editor establishes a composer even without a visible form box', async () => {
  for (const [name, layout] of Object.entries(renderedChildLayouts)) {
    const f = fixture()
    layout(f.form)
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    expect(c.scope, name).toBe(f.store)
    expect(await c.readConversationSnapshot!(id, new AbortController().signal), name).toBe(
      f.snapshot,
    )
  }
})

// Observed completed Pro turn: the visible final answer is followed by a
// finished same-turn thinking-preamble leaf, which the native SDK submits from.
const obsCid = '0c80500c-f930-4fca-a571-a68fc25d5a63'
const obsUser = '1c80500c-f930-4fca-a571-a68fc25d5a64'
const obsRecap = '2c80500c-f930-4fca-a571-a68fc25d5a65'
const obsFinal = '3c80500c-f930-4fca-a571-a68fc25d5a66'
const obsPreamble = '4c80500c-f930-4fca-a571-a68fc25d5a67'
const obsTurn = '5c80500c-f930-4fca-a571-a68fc25d5a68'
const obsOther = '6c80500c-f930-4fca-a571-a68fc25d5a69'
const obsMessage = (messageId: string, extra: any = {}) => ({
  id: messageId,
  author: { role: 'assistant' },
  channel: 'final',
  recipient: 'all',
  content: { content_type: 'text', parts: ['visible answer'] },
  status: 'finished_successfully',
  end_turn: true,
  metadata: { working_turn_id: obsTurn, turn_exchange_id: obsTurn },
  ...extra,
})
function preambleSnapshot(f: any, asyncStatus: number | null = null) {
  const snapshot: any = {
    conversation_id: obsCid,
    gizmo_id: project,
    current_node: obsPreamble,
    async_status: asyncStatus,
    is_read_only: null,
    is_archived: false,
    mapping: {
      [obsUser]: {
        id: obsUser,
        parent: null,
        children: [obsRecap],
        message: { id: obsUser, author: { role: 'user' }, metadata: {} },
      },
      [obsRecap]: {
        id: obsRecap,
        parent: obsUser,
        children: [obsFinal],
        message: obsMessage(obsRecap, {
          channel: 'analysis',
          content: { content_type: 'reasoning_recap', content: 'x' },
          end_turn: false,
        }),
      },
      [obsFinal]: {
        id: obsFinal,
        parent: obsRecap,
        children: [obsPreamble],
        message: obsMessage(obsFinal),
      },
      [obsPreamble]: {
        id: obsPreamble,
        parent: obsFinal,
        children: [],
        message: obsMessage(obsPreamble, {
          channel: 'commentary',
          end_turn: false,
          metadata: {
            parent_id: obsFinal,
            working_turn_id: obsTurn,
            turn_exchange_id: obsTurn,
            is_thinking_preamble_message: true,
            hide_inline_actions: true,
            disable_turn_actions: true,
            model_slug: 'gpt-6-pro',
          },
        }),
      },
    },
  }
  f.snapshot = snapshot
  return snapshot
}
const preambleRefusals: Record<string, [(s: any) => void, string?]> = {
  // current preamble flags and message shape
  noPreambleFlag: [
    (s) => delete s.mapping[obsPreamble].message.metadata.is_thinking_preamble_message,
  ],
  falsePreambleFlag: [
    (s) => (s.mapping[obsPreamble].message.metadata.is_thinking_preamble_message = false),
  ],
  stringPreambleFlag: [
    (s) => (s.mapping[obsPreamble].message.metadata.is_thinking_preamble_message = 'true'),
  ],
  noHideInline: [(s) => delete s.mapping[obsPreamble].message.metadata.hide_inline_actions],
  falseHideInline: [(s) => (s.mapping[obsPreamble].message.metadata.hide_inline_actions = false)],
  noDisableTurn: [(s) => delete s.mapping[obsPreamble].message.metadata.disable_turn_actions],
  falseDisableTurn: [(s) => (s.mapping[obsPreamble].message.metadata.disable_turn_actions = false)],
  endTurnTrue: [(s) => (s.mapping[obsPreamble].message.end_turn = true)],
  endTurnNull: [(s) => (s.mapping[obsPreamble].message.end_turn = null)],
  endTurnMissing: [(s) => delete s.mapping[obsPreamble].message.end_turn],
  finalChannel: [(s) => (s.mapping[obsPreamble].message.channel = 'final')],
  analysisChannel: [(s) => (s.mapping[obsPreamble].message.channel = 'analysis')],
  missingChannel: [(s) => delete s.mapping[obsPreamble].message.channel],
  inProgress: [(s) => (s.mapping[obsPreamble].message.status = 'in_progress')],
  missingStatus: [(s) => delete s.mapping[obsPreamble].message.status],
  userRole: [(s) => (s.mapping[obsPreamble].message.author.role = 'user')],
  foreignRecipient: [(s) => (s.mapping[obsPreamble].message.recipient = 'python')],
  hidden: [
    (s) => (s.mapping[obsPreamble].message.metadata.is_visually_hidden_from_conversation = true),
  ],
  nonText: [(s) => (s.mapping[obsPreamble].message.content.content_type = 'thoughts')],
  emptyParts: [(s) => (s.mapping[obsPreamble].message.content.parts = [])],
  blankText: [(s) => (s.mapping[obsPreamble].message.content.parts = [' '])],
  nonStringPart: [(s) => (s.mapping[obsPreamble].message.content.parts = [{}])],
  steeringMarker: [
    (s) => (s.mapping[obsPreamble].message.metadata.codex_optimistic_steering_assistant = true),
  ],
  missingMetadata: [(s) => delete s.mapping[obsPreamble].message.metadata],
  nodeIdMismatch: [(s) => (s.mapping[obsPreamble].id = obsOther)],
  messageIdMismatch: [(s) => (s.mapping[obsPreamble].message.id = obsOther)],
  missingMessage: [(s) => delete s.mapping[obsPreamble].message],
  currentHasChild: [
    (s) => {
      s.mapping[obsPreamble].children = [obsOther]
      s.mapping[obsOther] = {
        id: obsOther,
        parent: obsPreamble,
        children: [],
        message: obsMessage(obsOther),
      }
    },
  ],
  currentChildrenNotArray: [(s) => (s.mapping[obsPreamble].children = undefined)],
  reverseChildOmitted: [
    (s) => {
      // Node points to current, yet no children array lists it.
      s.mapping[obsOther] = {
        id: obsOther,
        parent: obsPreamble,
        children: [],
        message: obsMessage(obsOther),
      }
    },
  ],
  // reciprocal graph and parent identity
  noParentPointer: [(s) => delete s.mapping[obsPreamble].parent],
  nullParentPointer: [(s) => (s.mapping[obsPreamble].parent = null)],
  parentPointerMismatch: [(s) => (s.mapping[obsPreamble].parent = obsRecap)],
  metadataParentMissing: [(s) => delete s.mapping[obsPreamble].message.metadata.parent_id],
  metadataParentMismatch: [(s) => (s.mapping[obsPreamble].message.metadata.parent_id = obsRecap)],
  metadataParentMalformed: [(s) => (s.mapping[obsPreamble].message.metadata.parent_id = 'FINAL')],
  parentNotOwn: [(s) => (s.mapping[obsPreamble].parent = 'toString')],
  parentMissingNode: [
    (s) => {
      delete s.mapping[obsFinal]
    },
  ],
  parentNodeIdMismatch: [(s) => (s.mapping[obsFinal].id = obsOther)],
  parentMessageIdMismatch: [(s) => (s.mapping[obsFinal].message.id = obsOther)],
  parentChildrenOmitted: [(s) => (s.mapping[obsFinal].children = [])],
  parentChildrenMissing: [(s) => delete s.mapping[obsFinal].children],
  parentChildrenWrong: [(s) => (s.mapping[obsFinal].children = [obsOther])],
  parentChildrenDuplicate: [(s) => (s.mapping[obsFinal].children = [obsPreamble, obsPreamble])],
  parentExtraListedChild: [
    (s) => {
      s.mapping[obsFinal].children = [obsPreamble, obsOther]
      s.mapping[obsOther] = {
        id: obsOther,
        parent: obsFinal,
        children: [],
        message: obsMessage(obsOther),
      }
    },
  ],
  siblingOmittedFromChildren: [
    (s) => {
      // Only the mapping scan can see this sibling; the children array is clean.
      s.mapping[obsOther] = {
        id: obsOther,
        parent: obsFinal,
        children: [],
        message: obsMessage(obsOther),
      }
    },
  ],
  parentCycle: [(s) => (s.mapping[obsFinal].parent = obsPreamble)],
  selfParent: [
    (s) => {
      s.mapping[obsPreamble].parent = obsPreamble
      s.mapping[obsPreamble].message.metadata.parent_id = obsPreamble
    },
  ],
  // final parent strictness
  finalInProgress: [(s) => (s.mapping[obsFinal].message.status = 'in_progress')],
  finalNoEndTurn: [(s) => (s.mapping[obsFinal].message.end_turn = false)],
  finalNotFinalChannel: [(s) => (s.mapping[obsFinal].message.channel = 'commentary')],
  finalAnalysis: [(s) => (s.mapping[obsFinal].message.channel = 'analysis')],
  finalHidden: [
    (s) => (s.mapping[obsFinal].message.metadata.is_visually_hidden_from_conversation = true),
  ],
  finalBlank: [(s) => (s.mapping[obsFinal].message.content.parts = ['  '])],
  finalEmpty: [(s) => (s.mapping[obsFinal].message.content.parts = [])],
  finalNonText: [(s) => (s.mapping[obsFinal].message.content.content_type = 'multimodal_text')],
  finalUser: [(s) => (s.mapping[obsFinal].message.author.role = 'user')],
  finalForeignRecipient: [(s) => (s.mapping[obsFinal].message.recipient = 'python')],
  finalMissingMetadata: [(s) => delete s.mapping[obsFinal].message.metadata],
  // turn IDs
  currentWorkingMissing: [(s) => delete s.mapping[obsPreamble].message.metadata.working_turn_id],
  currentExchangeMissing: [(s) => delete s.mapping[obsPreamble].message.metadata.turn_exchange_id],
  finalWorkingMissing: [(s) => delete s.mapping[obsFinal].message.metadata.working_turn_id],
  finalExchangeMissing: [(s) => delete s.mapping[obsFinal].message.metadata.turn_exchange_id],
  workingMismatch: [(s) => (s.mapping[obsPreamble].message.metadata.working_turn_id = obsOther)],
  exchangeMismatch: [(s) => (s.mapping[obsPreamble].message.metadata.turn_exchange_id = obsOther)],
  finalWorkingMismatch: [(s) => (s.mapping[obsFinal].message.metadata.working_turn_id = obsOther)],
  finalExchangeMismatch: [
    (s) => (s.mapping[obsFinal].message.metadata.turn_exchange_id = obsOther),
  ],
  workingEmpty: [
    (s) => {
      s.mapping[obsPreamble].message.metadata.working_turn_id = ''
      s.mapping[obsFinal].message.metadata.working_turn_id = ''
    },
  ],
  exchangeEmpty: [
    (s) => {
      s.mapping[obsPreamble].message.metadata.turn_exchange_id = ''
      s.mapping[obsFinal].message.metadata.turn_exchange_id = ''
    },
  ],
  workingNotUuid: [
    (s) => {
      s.mapping[obsPreamble].message.metadata.working_turn_id = 'SAME_UUID'
      s.mapping[obsFinal].message.metadata.working_turn_id = 'SAME_UUID'
    },
  ],
  exchangeNotUuid: [
    (s) => {
      s.mapping[obsPreamble].message.metadata.turn_exchange_id = 'SAME_UUID'
      s.mapping[obsFinal].message.metadata.turn_exchange_id = 'SAME_UUID'
    },
  ],
  workingNotString: [
    (s) => {
      s.mapping[obsPreamble].message.metadata.working_turn_id = 7
      s.mapping[obsFinal].message.metadata.working_turn_id = 7
    },
  ],
  // scan bound
  mappingOver5000: [
    (s) => {
      for (let i = 0; i < 5001; i++) {
        const filler = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        s.mapping[filler] = { id: filler, parent: null, children: [], message: null }
      }
    },
  ],
  // snapshot-level identity and admission
  wrongCid: [(s) => (s.conversation_id = obsOther), 'native_existing_snapshot_invalid'],
  wrongProject: [
    (s) => (s.gizmo_id = 'g-p-ffffffffffffffffffffffffffffffff'),
    'native_existing_project_mismatch',
  ],
  asyncInProgress: [(s) => (s.async_status = 'in_progress'), 'native_existing_not_admissible'],
  asyncTwo: [(s) => (s.async_status = 2), 'native_existing_not_admissible'],
  asyncMissing: [(s) => delete s.async_status, 'native_existing_not_admissible'],
  readOnly: [(s) => (s.read_only = true), 'native_existing_not_admissible'],
  nativeReadOnly: [(s) => (s.is_read_only = true), 'native_existing_not_admissible'],
  archived: [(s) => (s.is_archived = true), 'native_existing_not_admissible'],
  currentNotInMapping: [(s) => (s.current_node = obsOther), 'native_existing_parent_invalid'],
  mappingArray: [(s) => (s.mapping = []), 'native_existing_snapshot_invalid'],
}
test('completed Pro final followed by its same-turn thinking preamble keeps the preamble as parent', async () => {
  for (const status of [null, 4]) {
    const f = fixture(),
      s = preambleSnapshot(f, status),
      before = structuredClone(s)
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    const result = await c.prepareExistingConversation!(obsCid, project)
    expect(result).toEqual({
      conversationId: obsCid,
      parentMessageId: obsPreamble,
      projectId: project,
    })
    // Admission is read-only: the SDK snapshot is neither mutated nor marked read.
    expect(f.snapshot).toBe(s)
    expect(s).toEqual(before)
    expect(f.calls.map((call) => call[0])).toEqual(['refetch'])
  }
})
test('thinking-preamble admission refuses every unsafe or ambiguous shape', async () => {
  for (const [name, [mutate, code]] of Object.entries(preambleRefusals)) {
    const f = fixture(),
      s = preambleSnapshot(f)
    mutate(s)
    const c = await discoverVerifiedNativeContract(f.page, f.deps)
    const expected = code ?? 'native_existing_parent_invalid'
    let error: unknown
    try {
      await c.prepareExistingConversation!(obsCid, project)
    } catch (e) {
      error = e
    }
    expect([name, (error as Error | undefined)?.message]).toEqual([name, expected])
    expect(f.calls.map((call) => call[0])).toEqual(['refetch'])
  }
})
test('preamble admission is refused when only the final-answer shape is relaxed elsewhere', async () => {
  // A non-preamble commentary leaf with a valid final parent must never be admitted.
  const f = fixture(),
    s = preambleSnapshot(f)
  const m = s.mapping[obsPreamble].message
  delete m.metadata.is_thinking_preamble_message
  delete m.metadata.hide_inline_actions
  delete m.metadata.disable_turn_actions
  const c = await discoverVerifiedNativeContract(f.page, f.deps)
  await expect(c.prepareExistingConversation!(obsCid, project)).rejects.toThrow(
    'native_existing_parent_invalid',
  )
})
test('dispatcher submits exactly once from the real adapter with the preamble parent and owned user/CID', async () => {
  const { NativeChatDispatcher } = await import('../src/native-chat')
  const f = fixture()
  preambleSnapshot(f)
  const receipts: any[] = []
  const journal: string[] = []
  const contract = await discoverVerifiedNativeContract(f.page, f.deps)
  const dispatcher = new NativeChatDispatcher(
    async () => contract,
    (receipt) => receipts.push(receipt),
    (requestId, userId) => journal.push(`${requestId}:${userId}`),
  )
  await dispatcher.prepare({
    type: 'request',
    requestId: 'A',
    native: true,
    nativeUserMessageId: id,
    text: 'continue',
    newChat: false,
    conversationId: obsCid,
    projectId: project,
  } as any)
  expect(f.calls.filter((call) => call[0] === 'send')).toHaveLength(0)
  await dispatcher.dispatch('A', id)
  const sends = f.calls.filter((call) => call[0] === 'send')
  expect(sends).toHaveLength(1)
  const options = sends[0][2]
  expect(options.conversationId).toBe(obsCid)
  expect(options.parentMessageId).toBe(obsPreamble)
  expect(options.projectId).toBe(project)
  expect(options.userCompletionMessages.message.id).toBe(id)
  expect(options.prompt).toBe('continue')
  expect(journal).toEqual([`A:${id}`])
  expect(receipts.some((r) => r.kind === 'error')).toBe(false)
  expect(f.calls.map((call) => call[0])).toEqual(['refetch', 'build', 'send'])
})
test('dispatcher never submits for a refused preamble shape', async () => {
  const { NativeChatDispatcher } = await import('../src/native-chat')
  const f = fixture()
  const s = preambleSnapshot(f)
  s.mapping[obsFinal].children = [obsPreamble, obsOther]
  s.mapping[obsOther] = {
    id: obsOther,
    parent: obsFinal,
    children: [],
    message: obsMessage(obsOther),
  }
  const contract = await discoverVerifiedNativeContract(f.page, f.deps)
  const dispatcher = new NativeChatDispatcher(
    async () => contract,
    () => {},
    () => {},
  )
  await expect(
    dispatcher.prepare({
      type: 'request',
      requestId: 'A',
      native: true,
      nativeUserMessageId: id,
      text: 'continue',
      newChat: false,
      conversationId: obsCid,
      projectId: project,
    } as any),
  ).rejects.toThrow('native_existing_parent_invalid')
  expect(f.calls.some((call) => call[0] === 'send')).toBe(false)
})
