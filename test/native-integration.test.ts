import { expect, test } from 'bun:test'
import { NativeChatDispatcher, resolveNativeProject, selectNativeModel } from '../src/native-chat'
const userId = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const project = 'g-p-0123456789abcdef0123456789abcdef'
test('dispatcher passes native prepared object and request-owned upload model/context', async () => {
  const scope = {},
    calls: any[] = []
  const dispatcher = new NativeChatDispatcher(
    async () => ({
      scope,
      models: {
        versionOptions: [
          { id: 'latest', slugs: ['instant'], options: [{ slug: 'instant', isAvailable: true }] },
        ],
      },
      selected: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
      projectRows: [{ id: project, label: 'LocalGPT' }],
      makeFile: (f) => new File(['x'], f.name, { type: f.mime }),
      upload: async (s, file, options) => {
        calls.push({ kind: 'upload', s, options })
        return { id: 'owned' }
      },
      validateUpload: (u) => u,
      validatePreparedUploads: () => {},
      build: (text, uploads, context: any) => {
        calls.push({ kind: 'build', context })
        return {
          extraDeveloperInstructionMessages: [],
          nativeExtra: 'preserved',
          message: {
            id: context?.nativeUserMessageId ?? crypto.randomUUID(),
            author: { role: 'user' },
            content: { content_type: 'text', parts: [text] },
            metadata: { attachments: uploads },
          },
        }
      },
      submit: (s, options) => {
        calls.push({ kind: 'submit', s, options })
        if (
          Array.isArray(options.userCompletionMessages) ||
          !options.userCompletionMessages?.message
        )
          throw Error('SDK object required')
      },
    }),
    () => {},
    () => {},
  )
  await dispatcher.prepare({
    type: 'request',
    requestId: 'integration',
    native: true,
    nativeUserMessageId: userId,
    newChat: true,
    text: ' hi ',
    model: 'instant',
    projectName: 'LocalGPT',
    files: [{ name: 'x.txt', mime: 'text/plain', base64: 'eA==' }],
  })
  expect(calls[0].options).toEqual({
    isTemporaryChat: false,
    storeInLibrary: false,
    model: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
    composerContext: { projectId: project, isProjectThread: true, messageId: userId },
  })
  expect(calls[1].context).toEqual({ nativeUserMessageId: userId })
  await dispatcher.dispatch('integration', userId)
  expect(calls[2].options.userCompletionMessages).toMatchObject({
    nativeExtra: 'preserved',
    extraDeveloperInstructionMessages: [],
    message: { id: userId, content: { parts: [' hi '] } },
  })
})
test('verified persisted project resolves while sidebar row is absent but visible conflicts refuse', () => {
  expect(resolveNativeProject([], 'LocalGPT', project)).toBe(project)
  expect(() =>
    resolveNativeProject([{ label: 'Other', id: project }], 'LocalGPT', project),
  ).toThrow('mismatch')
  expect(() =>
    resolveNativeProject(
      [{ label: 'LocalGPT', id: 'g-p-ffffffffffffffffffffffffffffffff' }],
      'LocalGPT',
      project,
    ),
  ).toThrow('mismatch')
})
test('requested native model retains its observed version for upload context', () => {
  const models = {
    versionOptions: [
      { id: 'latest', slugs: ['instant'], options: [{ slug: 'instant', isAvailable: true }] },
    ],
  }
  expect(
    selectNativeModel(
      models,
      { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
      'instant',
    ),
  ).toEqual({ model: 'instant', thinkingEffort: null, versionId: 'latest' })
})

test('existing native project is adopted from verified conversation when unconfigured', async () => {
  const calls: any[] = []
  const cid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const dispatcher = new NativeChatDispatcher(
    async () => ({
      scope: {},
      models: {
        versionOptions: [
          { id: 'latest', slugs: ['instant'], options: [{ slug: 'instant', isAvailable: true }] },
        ],
      },
      selected: { slug: 'instant', thinkingEffort: null, versionId: 'latest' },
      projectRows: [],
      prepareExistingConversation: async () => ({
        conversationId: cid,
        parentMessageId: userId,
        projectId: project,
      }),
      build: (text) => ({
        extraDeveloperInstructionMessages: [],
        message: {
          id: userId,
          author: { role: 'user' },
          content: { content_type: 'text', parts: [text] },
          metadata: {},
        },
      }),
      upload: () => {},
      submit: (_s, options) => calls.push(options),
    }),
    () => {},
    () => {},
  )
  await dispatcher.prepare({
    type: 'request',
    requestId: 'existing-project',
    native: true,
    nativeUserMessageId: userId,
    newChat: false,
    conversationId: cid,
    text: 'continue',
  })
  await dispatcher.dispatch('existing-project', userId)
  expect(calls[0].projectId).toBe(project)
})
