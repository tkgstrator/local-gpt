import { expect, test } from 'bun:test'
import { NativeChatDispatcher } from '../src/native-chat'
const uuid = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const project = 'g-p-0123456789abcdef0123456789abcdef'
test('uploads use native scope and isolated references without composer attachments', async () => {
  const scope = {},
    calls: any[] = [],
    receipts: any[] = []
  const dispatcher = new NativeChatDispatcher(
    async () => ({
      scope,
      models: {
        versionOptions: [
          {
            id: 'v',
            slugs: ['pro'],
            options: [{ slug: 'pro', thinkingEffort: 'high', isAvailable: true }],
          },
        ],
      },
      selected: { slug: 'pro', thinkingEffort: 'high', versionId: 'v' },
      projectRows: [{ label: 'LocalGPT', id: project }],
      makeFile: (f) =>
        new File([Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))], f.name, {
          type: f.mime,
        }),
      upload: async (...args: any[]) => {
        calls.push(args)
        return { id: 'file-owned', name: 'input.txt' }
      },
      validateUpload: (result: any, file) => {
        if (result.name !== file.name) throw Error('upload mismatch')
        return { id: result.id }
      },
      validatePreparedUploads: (message: any, uploads: any[]) => {
        expect(message.message.metadata.attachments).toEqual(uploads)
      },
      build: (text, uploads) => ({
        extraDeveloperInstructionMessages: [],
        message: {
          id: crypto.randomUUID(),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [text] },
          metadata: { attachments: uploads },
        },
      }),
      submit: async (s: any, o: any) => {
        calls.push([s, o])
      },
    }),
    (e) => receipts.push(e),
    () => {},
  )
  await dispatcher.prepare({
    type: 'request',
    requestId: 'A',
    native: true,
    nativeUserMessageId: uuid,
    text: 'read input',
    newChat: true,
    projectName: 'LocalGPT',
    files: [{ name: 'input.txt', mime: 'text/plain', base64: btoa('bytes') }],
  })
  expect(calls.length).toBe(1)
  expect(calls[0][0]).toBe(scope)
  expect(calls[0][2]).toMatchObject({
    isTemporaryChat: false,
    storeInLibrary: false,
    model: { slug: 'pro', thinkingEffort: 'high', versionId: 'v' },
  })
  expect(await calls[0][1].text()).toBe('bytes')
  await dispatcher.dispatch('A', uuid)
  expect(calls[1][1].projectId).toBe(project)
  expect(calls[1][1].userCompletionMessages.message.metadata.attachments).toEqual([
    { id: 'file-owned' },
  ])
  expect(calls[1][1].thinkingEffort).toBe('high')
})
test('builder cannot silently drop native uploaded references', async () => {
  const dispatcher = new NativeChatDispatcher(
    async () => ({
      scope: {},
      models: {
        versionOptions: [{ id: 'v', slugs: ['m'], options: [{ slug: 'm', isAvailable: true }] }],
      },
      selected: { slug: 'm', thinkingEffort: null, versionId: 'v' },
      projectRows: [],
      makeFile: (f) => new File(['a'], f.name),
      validateUpload: () => ({ id: 'file-owned' }),
      validatePreparedUploads: (m: any, u: any[]) => {
        if (JSON.stringify(m.message.metadata.attachments) !== JSON.stringify(u))
          throw Error('native_upload_message_mismatch')
      },
      upload: async () => ({ id: 'file-owned' }),
      build: (text) => ({
        extraDeveloperInstructionMessages: [],
        message: {
          id: crypto.randomUUID(),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [text] },
          metadata: {},
        },
      }),
      submit: async () => {},
    }),
    () => {},
    () => {},
  )
  await expect(
    dispatcher.prepare({
      type: 'request',
      requestId: 'A',
      native: true,
      nativeUserMessageId: uuid,
      text: 'hi',
      newChat: true,
      files: [{ name: 'input.txt', mime: 'text/plain', base64: 'YQ==' }],
    }),
  ).rejects.toThrow('upload_message_mismatch')
})
test('unsupported upload contract rejects before uploading or generating', async () => {
  let uploads = 0,
    sends = 0
  const dispatcher = new NativeChatDispatcher(
    async () => ({
      scope: {},
      models: {
        versionOptions: [{ id: 'v', slugs: ['m'], options: [{ slug: 'm', isAvailable: true }] }],
      },
      selected: { slug: 'm', thinkingEffort: null, versionId: 'v' },
      projectRows: [],
      build: () => {},
      upload: async () => {
        uploads++
      },
      submit: async () => {
        sends++
      },
    }),
    () => {},
    () => {},
  )
  await expect(
    dispatcher.prepare({
      type: 'request',
      requestId: 'A',
      native: true,
      nativeUserMessageId: uuid,
      text: 'hi',
      newChat: true,
      files: [{ name: 'input.txt', mime: 'text/plain', base64: 'YQ==' }],
    }),
  ).rejects.toThrow('upload_contract_unavailable')
  expect(uploads).toBe(0)
  expect(sends).toBe(0)
})
