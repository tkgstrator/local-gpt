import { expect, test } from 'bun:test'
import {
  NativeHistoryRateLimitError,
  NativeHistoryScheduler,
  classifyHistoryRateLimit,
  type HistoryClock,
} from '../src/native-history'
import { NativeChatDispatcher } from '../src/native-chat'

function fakeClock(start = 1_000_000) {
  let time = start
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: HistoryClock = {
    now: () => time,
    setTimeout: (fn, ms) => {
      timers.set(++id, { at: time + ms, fn })
      return id
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    random: () => 0,
  }
  const advance = async (ms: number) => {
    const target = time + ms
    for (;;) {
      const next = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      timers.delete(next[0])
      time = Math.max(time, next[1].at)
      next[1].fn()
      await flush()
    }
    time = target
    await flush()
  }
  return { clock, advance, timers: () => timers.size }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
function deferred<T = unknown>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const limited = () => new Error('ChatGPT conversation history was rate limited')

test('limits concurrency to two and spaces starts by one second', async () => {
  const f = fakeClock()
  const s = new NativeHistoryScheduler({ clock: f.clock })
  const starts: number[] = []
  const gates = [deferred(), deferred(), deferred()]
  const runs = gates.map((g, i) =>
    s.run(async () => {
      starts.push(f.clock.now())
      return g.promise.then(() => i)
    }),
  )
  await flush()
  expect(starts).toHaveLength(1)
  await f.advance(1000)
  expect(starts).toHaveLength(2)
  await f.advance(5000)
  expect(starts).toHaveLength(2)
  expect(s.active).toBe(2)
  gates[0]!.resolve(undefined)
  await flush()
  expect(starts).toHaveLength(3)
  expect(starts[1]! - starts[0]!).toBe(1000)
  gates.forEach((g) => g.resolve(undefined))
  expect(await Promise.all(runs)).toEqual([0, 1, 2])
  expect(s.active).toBe(0)
})

test('queued work canceled never starts and does not consume spacing', async () => {
  const f = fakeClock()
  const s = new NativeHistoryScheduler({ clock: f.clock })
  const gate = deferred()
  let started = 0
  const first = s.run(async () => (started++, gate.promise))
  await flush()
  const controller = new AbortController()
  const queued = s.run(async () => void started++, { signal: controller.signal })
  const third = s.run(async () => (started++, 'third'))
  controller.abort()
  await expect(queued).rejects.toBeDefined()
  expect(s.pending).toBe(1)
  await f.advance(1000)
  expect(await third).toBe('third')
  expect(started).toBe(2)
  gate.resolve(undefined)
  await first
  await f.advance(10_000)
  expect(f.timers()).toBe(0)
})

test('aborting an active read retains its promise and slot until SDK settlement', async () => {
  const f = fakeClock()
  const s = new NativeHistoryScheduler({ clock: f.clock, maxInFlight: 1 })
  const gate = deferred()
  const controller = new AbortController()
  let sdkSignal: AbortSignal | undefined
  const active = s.run(
    async (signal) => {
      sdkSignal = signal
      return gate.promise
    },
    { signal: controller.signal },
  )
  let activeSettled = false
  void active.then(
    () => {
      activeSettled = true
    },
    () => {
      activeSettled = true
    },
  )
  await flush()
  let secondStarted = false
  const second = s.run(async () => void (secondStarted = true))
  controller.abort()
  expect(sdkSignal?.aborted).toBe(true)
  await f.advance(5000)
  expect(activeSettled).toBe(false)
  expect(secondStarted).toBe(false)
  expect(s.active).toBe(1)
  gate.resolve(undefined)
  await expect(active).rejects.toBeDefined()
  await second
  expect(secondStarted).toBe(true)
  expect(s.active).toBe(0)
})

test('429 sets a shared exponential cooldown with jitter', async () => {
  const f = fakeClock()
  f.clock.random = () => 0.5
  const s = new NativeHistoryScheduler({ clock: f.clock, spacingMs: 0 })
  await expect(s.run(async () => Promise.reject(limited()))).rejects.toBeInstanceOf(
    NativeHistoryRateLimitError,
  )
  let ran = false
  const other = s
    .run(async () => {
      ran = true
      throw { status: 429 }
    })
    .catch((error) => error)
  await f.advance(2249)
  expect(ran).toBe(false)
  await f.advance(1)
  expect(await other).toBeInstanceOf(NativeHistoryRateLimitError)
  expect(ran).toBe(true)
  ran = false
  const third = s.run(async () => void (ran = true))
  await f.advance(4499) // second consecutive failure: 4000 * 1.125
  expect(ran).toBe(false)
  await f.advance(1)
  await third
})

test('an expired start deadline never invokes the SDK even without a cooldown', async () => {
  const f = fakeClock()
  const s = new NativeHistoryScheduler({ clock: f.clock })
  let starts = 0
  await expect(
    s.run(
      async () => {
        starts++
      },
      { deadline: f.clock.now() - 1 },
    ),
  ).rejects.toBeInstanceOf(NativeHistoryRateLimitError)
  expect(starts).toBe(0)
})

test('Retry-After numeric, date and invalid values', () => {
  const now = Date.parse('2026-10-22T00:00:00Z')
  expect(classifyHistoryRateLimit({ status: 429, headers: { 'Retry-After': '7' } }, now)).toEqual({
    retryAfterMs: 7000,
  })
  expect(
    classifyHistoryRateLimit(
      {
        response: {
          status: 429,
          headers: new Headers({ 'retry-after': 'Thu, 22 Oct 2026 00:00:30 GMT' }),
        },
      },
      now,
    ),
  ).toEqual({ retryAfterMs: 30000 })
  expect(
    classifyHistoryRateLimit({ status: 429, headers: { 'retry-after': 'soon' } }, now),
  ).toEqual({})
  expect(classifyHistoryRateLimit({ status: 429, headers: { 'retry-after': '1.5' } }, now)).toEqual(
    {},
  )
  expect(
    classifyHistoryRateLimit(
      { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 00:00:00 GMT' } },
      now,
    ),
  ).toEqual({})
  expect(classifyHistoryRateLimit(limited(), now)).toEqual({})
  expect(classifyHistoryRateLimit(new Error('rate limited elsewhere'), now)).toBeUndefined()
  expect(classifyHistoryRateLimit({ status: 400 }, now)).toBeUndefined()
})

test('fallback cooldown including jitter remains capped at one minute', async () => {
  const f = fakeClock()
  f.clock.random = () => 1
  const s = new NativeHistoryScheduler({ clock: f.clock, baseDelayMs: 60_000 })
  await expect(
    s.run(async () => {
      throw limited()
    }),
  ).rejects.toBeInstanceOf(NativeHistoryRateLimitError)
  let ran = false
  const next = s.run(async () => {
    ran = true
  })
  await f.advance(60_000)
  expect(ran).toBe(true)
  await next
})

test('zero-padded and long numeric Retry-After values never fall back to a short delay', () => {
  const now = 1_000_000
  const read = (value: string) =>
    classifyHistoryRateLimit({ status: 429, headers: { 'retry-after': value } }, now)
  expect(read('0000000120')).toEqual({ retryAfterMs: 120_000 })
  expect(read('1000000000')).toEqual({ retryAfterMs: 1_000_000_000_000 })
  expect(read('9'.repeat(400))).toEqual({ retryAfterMs: Number.MAX_SAFE_INTEGER - now })
})

test('long Retry-After waits use bounded timer chunks and queued cancellation clears the timer', async () => {
  const f = fakeClock()
  const delays: number[] = []
  const schedule = f.clock.setTimeout
  f.clock.setTimeout = (fn, ms) => {
    delays.push(ms)
    return schedule(fn, ms)
  }
  const s = new NativeHistoryScheduler({ clock: f.clock })
  await expect(
    s.run(async () => {
      throw { status: 429, headers: { 'retry-after': '1000000000' } }
    }),
  ).rejects.toBeInstanceOf(NativeHistoryRateLimitError)
  const controller = new AbortController()
  let starts = 0
  const waiting = s.run(
    async () => {
      starts++
    },
    { signal: controller.signal },
  )
  await f.advance(2_147_483_647)
  expect(starts).toBe(0)
  expect(delays).toEqual([2_147_483_647, 2_147_483_647])
  controller.abort()
  await expect(waiting).rejects.toBeDefined()
  expect(s.pending).toBe(0)
  expect(f.timers()).toBe(0)
})

test('an aborted active SDK read still shares a late 429 cooldown with queued work', async () => {
  const f = fakeClock()
  const s = new NativeHistoryScheduler({ clock: f.clock })
  const a = deferred(),
    b = deferred()
  const controller = new AbortController()
  const first = s.run(() => a.promise, { signal: controller.signal }).catch((error) => error)
  const second = s.run(() => b.promise)
  let thirdStarted = false
  const third = s.run(async () => {
    thirdStarted = true
  })
  await f.advance(15_000)
  controller.abort()
  a.reject({ status: 429, headers: { 'retry-after': '60' } })
  await flush()
  expect(thirdStarted).toBe(false)
  await f.advance(59_999)
  expect(thirdStarted).toBe(false)
  await f.advance(1)
  await third
  expect(thirdStarted).toBe(true)
  expect(await first).toBeInstanceOf(Error)
  b.resolve(undefined)
  await second
  expect(s.active).toBe(0)
})

test('long Retry-After is not shortened and is refused when beyond the deadline', async () => {
  const f = fakeClock()
  const s = new NativeHistoryScheduler({ clock: f.clock, spacingMs: 0 })
  await expect(
    s.run(async () => Promise.reject({ status: 429, headers: { 'retry-after': '120' } })),
  ).rejects.toBeInstanceOf(NativeHistoryRateLimitError)
  let ran = false
  const fits = s.run(async () => void (ran = true), { deadline: f.clock.now() + 200_000 })
  await f.advance(119_999)
  expect(ran).toBe(false)
  await f.advance(1)
  await fits
  await expect(
    s.run(async () => Promise.reject({ status: 429, headers: { 'retry-after': '120' } })),
  ).rejects.toBeInstanceOf(NativeHistoryRateLimitError)
  let started = false
  const err = await s
    .run(async () => void (started = true), { deadline: f.clock.now() + 60_000 })
    .catch((e) => e)
  expect(err).toBeInstanceOf(NativeHistoryRateLimitError)
  expect(err.retryable).toBe(false)
  expect(started).toBe(false)
})

test('non-429 errors pass through without cooldown', async () => {
  const f = fakeClock()
  const s = new NativeHistoryScheduler({ clock: f.clock, spacingMs: 0 })
  await expect(s.run(async () => Promise.reject(new Error('native_x')))).rejects.toThrow('native_x')
  expect(await s.run(async () => 'ok')).toBe('ok')
})

test('queue is bounded', async () => {
  const f = fakeClock()
  const s = new NativeHistoryScheduler({ clock: f.clock, maxQueue: 1, maxInFlight: 1 })
  const gate = deferred()
  const a = s.run(() => gate.promise)
  await flush()
  const b = s.run(async () => 1)
  await expect(s.run(async () => 2)).rejects.toThrow('native_history_queue_full')
  gate.resolve(undefined)
  await a
  await f.advance(1000)
  await b
})

const cid = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a',
  user = 'a3241425-4f9f-4e13-a3cb-8b0fd902f32a',
  parent = 'c3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const base = (extra: Record<string, unknown>) => ({
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
  ...extra,
})
const req = {
  type: 'request' as const,
  requestId: 'A',
  native: true,
  nativeUserMessageId: user,
  text: 'hi',
  newChat: false,
  conversationId: cid,
}

test('preparation exhausts after three reads with stable code and no journal', async () => {
  const f = fakeClock()
  let reads = 0,
    journals = 0
  const d = new NativeChatDispatcher(
    async () =>
      base({
        prepareExistingConversation: async () => (reads++, Promise.reject(limited())),
      }) as any,
    () => {},
    () => void journals++,
    new NativeHistoryScheduler({ clock: f.clock }),
  )
  const result = d.prepare(req).catch((e) => e)
  for (let i = 0; i < 10; i++) await f.advance(20_000)
  expect((await result).message).toBe('native_history_rate_limited')
  expect(reads).toBe(3)
  expect(journals).toBe(0)
})

test('preparation fails before dispatch when Retry-After exceeds the request timeout', async () => {
  const f = fakeClock()
  let reads = 0
  const d = new NativeChatDispatcher(
    async () =>
      base({
        prepareExistingConversation: async () => {
          reads++
          throw Object.assign(new Error('x'), { status: 429, headers: { 'retry-after': '600' } })
        },
      }) as any,
    () => {},
    () => {},
    new NativeHistoryScheduler({ clock: f.clock }),
  )
  const result = d.prepare({ ...req, timeoutMs: 60_000 }).catch((e) => e)
  await f.advance(100)
  expect((await result).message).toBe('native_history_rate_limited')
  expect(reads).toBe(1)
})

test('disarm cancels a backed-off preparation and leaks nothing', async () => {
  const f = fakeClock()
  let reads = 0
  const s = new NativeHistoryScheduler({ clock: f.clock })
  const d = new NativeChatDispatcher(
    async () =>
      base({
        prepareExistingConversation: async () => (reads++, Promise.reject(limited())),
      }) as any,
    () => {},
    () => {},
    s,
  )
  const result = d.prepare(req).catch((e) => e)
  await f.advance(10)
  expect(reads).toBe(1)
  d.disarm('A')
  await f.advance(60_000)
  expect((await result).message).toBeDefined()
  expect(reads).toBe(1)
  expect(s.pending).toBe(0)
  expect(s.active).toBe(0)
  expect(f.timers()).toBe(0)
})

test('non-429 preparation errors are not retried', async () => {
  const f = fakeClock()
  let reads = 0
  const d = new NativeChatDispatcher(
    async () =>
      base({
        prepareExistingConversation: async () => (
          reads++, Promise.reject(new Error('native_existing_snapshot_invalid'))
        ),
      }) as any,
    () => {},
    () => {},
    new NativeHistoryScheduler({ clock: f.clock }),
  )
  await expect(d.prepare(req)).rejects.toThrow('native_existing_snapshot_invalid')
  expect(reads).toBe(1)
})

test('recovery 429 cooldown delays a later preparation (shared)', async () => {
  const f = fakeClock()
  const calls: string[] = []
  let recoveries = 0
  const d = new NativeChatDispatcher(
    async () =>
      base({
        prepareExistingConversation: async () => (
          calls.push('prepare'), { conversationId: cid, parentMessageId: parent }
        ),
        readConversationSnapshot: async () => {
          calls.push('recover')
          if (!recoveries++) throw limited()
          return { ok: true }
        },
      }) as any,
    () => {},
    () => {},
    new NativeHistoryScheduler({ clock: f.clock, spacingMs: 0 }),
  )
  const prep = d.prepare(req)
  await f.advance(1)
  await prep
  await d.dispatch('A', user)
  await expect(d.readConversationSnapshot('A', user, cid)).rejects.toBeInstanceOf(
    NativeHistoryRateLimitError,
  )
  const second = d.prepare({
    ...req,
    requestId: 'B',
    nativeUserMessageId: 'd3241425-4f9f-4e13-a3cb-8b0fd902f32a',
  })
  await f.advance(1999)
  expect(calls).toEqual(['prepare', 'recover'])
  await f.advance(1)
  await second
  expect(calls).toEqual(['prepare', 'recover', 'prepare'])
})
