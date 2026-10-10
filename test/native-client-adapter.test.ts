import { expect, test } from 'bun:test'
import { discoverVerifiedNativeContract } from '../src/native-client-adapter'
import { validatePreparedMessage } from '../src/native-chat'

const id = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const project = 'g-p-0123456789abcdef0123456789abcdef'
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
  const form: any = { draft: 'MANUAL DRAFT', attachments: ['manual'], isConnected: true }
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
