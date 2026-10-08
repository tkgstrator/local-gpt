import { expect, test } from 'bun:test'
import { NativeChatDispatcher } from '../src/native-chat'
const uuid = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const next = 'a3241425-4f9f-4e13-a3cb-8b0fd902f32a'
function contract(submit: Function) {
  const scope = {}
  return {
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
    projectRows: [],
    build: (text: string, uploads: unknown[]) => ({
      extraDeveloperInstructionMessages: [],
      message: {
        id: crypto.randomUUID(),
        author: { role: 'user' },
        content: { content_type: 'text', parts: [text] },
        metadata: {},
      },
    }),
    upload: async () => {},
    submit,
  }
}
test('prepare performs no generation; interleaved independent sends pass explicit options', async () => {
  const calls: any[] = []
  const receipts: any[] = []
  const dispatcher = new NativeChatDispatcher(
    async () =>
      contract(async (scope: any, options: any) => {
        calls.push({ scope, options })
        options.onClientThreadIdChange('local-' + options.userCompletionMessages.message.id)
      }),
    (e) => receipts.push(e),
    () => {},
  )
  await dispatcher.prepare({
    type: 'request',
    requestId: 'A',
    native: true,
    nativeUserMessageId: uuid,
    text: 'same',
    newChat: true,
    model: 'pro',
  })
  await dispatcher.prepare({
    type: 'request',
    requestId: 'B',
    native: true,
    nativeUserMessageId: next,
    text: 'same',
    newChat: true,
    model: 'pro',
  })
  expect(calls.length).toBe(0)
  await dispatcher.dispatch('A', uuid)
  await dispatcher.dispatch('B', next)
  expect(calls.length).toBe(2)
  expect(calls[0].options.userCompletionMessages.message.id).toBe(uuid)
  expect(calls[1].options.userCompletionMessages.message.id).toBe(next)
  expect(receipts.filter((r) => r.kind === 'identity').map((r) => r.clientThreadId)).toEqual([
    'local-' + uuid,
    'local-' + next,
  ])
  await expect(dispatcher.dispatch('A', uuid)).rejects.toThrow('already')
})
test('failed browser intent journal prevents generation even after server intent ACK', async () => {
  let sends = 0
  const dispatcher = new NativeChatDispatcher(
    async () =>
      contract(async () => {
        sends++
      }),
    () => {},
    () => {
      throw new Error('storage failed')
    },
  )
  await dispatcher.prepare({
    type: 'request',
    requestId: 'A',
    native: true,
    nativeUserMessageId: uuid,
    text: 'hi',
    newChat: true,
  })
  await expect(dispatcher.dispatch('A', uuid)).rejects.toThrow('storage failed')
  expect(sends).toBe(0)
})
test('client callback failures are unknown, not remote terminal evidence', async () => {
  const receipts: any[] = []
  const dispatcher = new NativeChatDispatcher(
    async () =>
      contract(async () => {
        throw new Error('async failure')
      }),
    (e) => receipts.push(e),
    () => {},
  )
  await dispatcher.prepare({
    type: 'request',
    requestId: 'A',
    native: true,
    nativeUserMessageId: uuid,
    text: 'hi',
    newChat: true,
  })
  await dispatcher.dispatch('A', uuid)
  await new Promise((r) => setTimeout(r, 1))
  expect(receipts).toContainEqual(expect.objectContaining({ kind: 'error', preDispatch: false }))
  expect(receipts.some((r) => r.kind === 'stop')).toBe(false)
})
test('sessionless existing request cannot silently create a thread', async () => {
  const dispatcher = new NativeChatDispatcher(
    async () => contract(async () => {}),
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
      newChat: false,
    }),
  ).rejects.toThrow('target')
})
