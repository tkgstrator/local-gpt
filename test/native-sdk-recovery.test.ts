import { expect, test } from 'bun:test'
import { NativeChatDispatcher, type NativeContract } from '../src/native-chat'
import { boundedConversationSnapshot } from '../src/conversation-recovery'
const user = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const cid = 'a3241425-4f9f-4e13-a3cb-8b0fd902f32a'
test('disarm prevents late preparation from restoring a retained payload', async () => {
  const f = fixture(async () => null)
  const original = f.contract.build
  let finish!: (value: unknown) => void
  let building!: () => void
  const started = new Promise<void>((resolve) => {
    building = resolve
  })
  f.contract.build = () => {
    building()
    return new Promise((resolve) => {
      finish = resolve
    })
  }
  const preparing = f.dispatcher.prepare(f.request)
  await started
  f.dispatcher.disarm('A')
  finish(original('hi', []))
  await expect(preparing).rejects.toThrow('disarmed')
  await expect(f.dispatcher.dispatch('A', user)).rejects.toThrow('identity')
  // Refused attempts retain replay protection while freeing preparation capacity.
  for (let i = 0; i < 40; i++) {
    const id = 'refused-' + i
    f.contract.build = original
    await f.dispatcher.prepare({
      ...f.request,
      requestId: id,
      nativeUserMessageId: crypto.randomUUID(),
    })
    f.dispatcher.disarm(id)
  }
  await expect(f.dispatcher.prepare(f.request)).rejects.toThrow('already_prepared')
})
function fixture(read: () => Promise<unknown>, existing = false) {
  let options: any
  const contract: NativeContract = {
    scope: {},
    projectRows: [],
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
    upload: async () => {},
    build: (text) => ({
      extraDeveloperInstructionMessages: [],
      message: {
        id: user,
        author: { role: 'user' },
        content: { content_type: 'text', parts: [text] },
        metadata: {},
      },
    }),
    submit: (_scope, value) => {
      options = value
      return new Promise(() => {})
    },
    prepareExistingConversation: async () => ({ conversationId: cid, parentMessageId: user }),
    readConversationSnapshot: read,
  }
  const dispatcher = new NativeChatDispatcher(
    async () => contract,
    () => {},
    () => {},
  )
  const request = {
    type: 'request' as const,
    requestId: 'A',
    native: true,
    nativeUserMessageId: user,
    text: 'hi',
    newChat: !existing,
    ...(existing ? { conversationId: cid } : {}),
  }
  return {
    dispatcher,
    contract,
    request,
    identity: (id = cid) => options.onServerThreadIdChange(id),
  }
}
test('journal refusal never grants snapshot ownership', async () => {
  let reads = 0
  const f = fixture(async () => {
    reads++
    return null
  }, true)
  const dispatcher = new NativeChatDispatcher(
    async () => f.contract,
    () => {},
    () => {
      throw new Error('journal denied')
    },
  )
  await dispatcher.prepare(f.request)
  await expect(dispatcher.dispatch('A', user)).rejects.toThrow('journal denied')
  await expect(dispatcher.readConversationSnapshot('A', user, cid)).rejects.toThrow('not_owned')
  expect(reads).toBe(0)
})
test('owned recovery denies undispatched, unbound, foreign and conflicting CID', async () => {
  let reads = 0
  const f = fixture(async () => {
    reads++
    return { ok: true }
  })
  await f.dispatcher.prepare(f.request)
  await expect(f.dispatcher.readConversationSnapshot('A', user, cid)).rejects.toThrow()
  await f.dispatcher.dispatch('A', user)
  await expect(f.dispatcher.readConversationSnapshot('A', user, cid)).rejects.toThrow()
  f.identity()
  await expect(f.dispatcher.readConversationSnapshot('B', user, cid)).rejects.toThrow()
  await expect(f.dispatcher.readConversationSnapshot('A', cid, cid)).rejects.toThrow()
  expect(await f.dispatcher.readConversationSnapshot('A', user, cid)).toEqual({ ok: true })
  f.identity(user)
  await expect(f.dispatcher.readConversationSnapshot('A', user, cid)).rejects.toThrow()
  expect(reads).toBe(1)
})
test('existing CID is owned without callback; disarm discards pending snapshot', async () => {
  let finish!: (v: unknown) => void
  let reads = 0
  const f = fixture(() => {
    reads++
    return new Promise((resolve) => {
      finish = resolve
    })
  }, true)
  await f.dispatcher.prepare(f.request)
  await f.dispatcher.dispatch('A', user)
  const a = f.dispatcher.readConversationSnapshot('A', user, cid)
  const b = f.dispatcher.readConversationSnapshot('A', user, cid)
  await Promise.resolve()
  expect(reads).toBe(1)
  f.dispatcher.disarm('A')
  const assertions = Promise.all(
    [a, b].map((p) =>
      p.then(
        () => false,
        () => true,
      ),
    ),
  )
  finish({ ok: true })
  expect(await assertions).toEqual([true, true])
  await expect(f.dispatcher.dispatch('A', user)).rejects.toThrow()
})
test('reserve duplicate prepare before discovery await', async () => {
  const f = fixture(async () => null)
  const a = f.dispatcher.prepare(f.request)
  await expect(f.dispatcher.prepare(f.request)).rejects.toThrow()
  await a
})
test('SDK snapshots reject malformed, excessive nodes, bytes and cycles downstream', () => {
  for (const value of [
    null,
    {},
    { mapping: [] },
    { mapping: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [i, {}])) },
    { mapping: {}, data: 'x'.repeat(8000001) },
  ])
    expect(boundedConversationSnapshot(value)).toBeNull()
  const cyclic: any = { mapping: {} }
  cyclic.self = cyclic
  expect(boundedConversationSnapshot(cyclic)).toBeNull()
})
test('timeout keeps underlying singleflight until settlement and discards late value', async () => {
  let reads = 0,
    finish!: (v: unknown) => void
  const f = fixture(() => {
    reads++
    return new Promise((resolve) => {
      finish = resolve
    })
  }, true)
  await f.dispatcher.prepare(f.request)
  await f.dispatcher.dispatch('A', user)
  const original = globalThis.setTimeout
  const timers: (() => void)[] = []
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    expect(delay).toBe(15000)
    timers.push(fn)
    return 0
  }) as any
  try {
    const first = f.dispatcher.readConversationSnapshot('A', user, cid).catch((e) => e.message)
    await Promise.resolve()
    timers.shift()!()
    expect(await first).toBe('native_recovery_timeout')
    const second = f.dispatcher.readConversationSnapshot('A', user, cid).catch((e) => e.message)
    await Promise.resolve()
    expect(reads).toBe(1)
    finish({ ok: true })
    expect(await second).toBe('native_recovery_disarmed')
  } finally {
    globalThis.setTimeout = original
  }
})
