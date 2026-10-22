import { expect, test } from 'bun:test'
import { NativeChatDispatcher } from '../src/native-chat'
const cid = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a',
  user = 'a3241425-4f9f-4e13-a3cb-8b0fd902f32a',
  parent = 'c3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const contract = () => ({
  scope: {},
  models: {
    versionOptions: [{ id: 'v', slugs: ['m'], options: [{ slug: 'm', isAvailable: true }] }],
  },
  selected: { slug: 'm', thinkingEffort: null, versionId: 'v' },
  projectRows: [],
  upload: async () => {},
  build: (text: string) => ({
    extraDeveloperInstructionMessages: [],
    message: {
      id: crypto.randomUUID(),
      author: { role: 'user' },
      content: { content_type: 'text', parts: [text] },
      metadata: {},
    },
  }),
  submit: async () => {},
})
const request = {
  type: 'request' as const,
  requestId: 'A',
  native: true,
  nativeUserMessageId: user,
  text: 'hi',
  newChat: false,
  conversationId: cid,
}
test('existing native CID requires explicit preparation contract before dispatch', async () => {
  const dispatcher = new NativeChatDispatcher(
    async () => contract(),
    () => {},
    () => {},
  )
  await expect(dispatcher.prepare(request)).rejects.toThrow('existing_preparation_unavailable')
})
test('existing preparation passes validated parent and never adopts another CID', async () => {
  const calls: any[] = []
  const dispatcher = new NativeChatDispatcher(
    async () => ({
      ...contract(),
      prepareExistingConversation: async () => ({ conversationId: cid, parentMessageId: parent }),
      submit: async (...args: any[]) => {
        calls.push(args)
      },
    }),
    () => {},
    () => {},
  )
  await dispatcher.prepare(request)
  await dispatcher.dispatch('A', user)
  expect(calls[0][1].conversationId).toBe(cid)
  expect(calls[0][1].parentMessageId).toBe(parent)
  const wrong = new NativeChatDispatcher(
    async () => ({
      ...contract(),
      prepareExistingConversation: async () => ({
        conversationId: parent,
        parentMessageId: parent,
      }),
    }),
    () => {},
    () => {},
  )
  await expect(wrong.prepare(request)).rejects.toThrow('existing_identity_mismatch')
})

test('a temporary SDK history rate limit does not discard an unsent continuation', async () => {
  let reads = 0,
    submits = 0,
    journals = 0
  const receipts: any[] = []
  const dispatcher = new NativeChatDispatcher(
    async () => ({
      ...contract(),
      prepareExistingConversation: async () => {
        reads++
        if (reads === 1) throw new Error('ChatGPT conversation history was rate limited')
        return { conversationId: cid, parentMessageId: parent }
      },
      submit: async (_scope: unknown, options: any) => {
        expect(options.conversationId).toBe(cid)
        expect(options.userCompletionMessages.message.id).toBe(user)
        submits++
      },
    }),
    (receipt) => receipts.push(receipt),
    () => {
      journals++
    },
  )
  await dispatcher.prepare(request)
  expect(reads).toBe(2)
  expect(submits).toBe(0)
  expect(journals).toBe(0)
  expect(receipts.filter((receipt) => receipt.kind === 'prepared')).toHaveLength(1)
  await dispatcher.dispatch('A', user)
  expect(submits).toBe(1)
  expect(journals).toBe(1)
}, 20000)
