import { test, expect } from 'bun:test'
import { createExtensionTransport } from '../src/extension-transport'
const epochA = '11111111-1111-4111-8111-111111111111'
const epochB = '22222222-2222-4222-8222-222222222222'
const job = {
  type: 'request',
  requestId: 'first',
  native: true,
  text: 'hello',
  newChat: true,
  nativeUserMessageId: '33333333-3333-4333-8333-333333333333',
}
function fixture() {
  const state = {
    epoch: epochA,
    calls: [] as any[],
    queue: [job],
    cache: new Map<string, any>(),
    dequeues: 0,
    read: null as null | ((reply: any) => Promise<unknown>),
    unsupported: false,
    retired: false,
  }
  const send = async (request: any) => {
    state.calls.push(request)
    const d = request.data
    if (request.path === 'poll-open')
      return state.unsupported
        ? { ok: true, data: { request: null } }
        : {
            ok: true,
            data: {
              protocol: 1,
              epoch: state.epoch,
              streamId: d.streamId,
              activation: d.activation,
            },
          }
    if (request.path === 'event') return { ok: true, data: { accepted: true } }
    if (request.path !== 'poll-v2') throw new Error('Unexpected legacy downgrade')
    const key = d.epoch + ':' + d.streamId + ':' + d.sequence
    if (!state.cache.has(key)) {
      state.dequeues++
      state.cache.set(key, state.queue.shift() ?? null)
    }
    const reply = {
      ok: true,
      data: {
        protocol: 1,
        epoch: state.epoch,
        streamId: d.streamId,
        activation: d.activation,
        sequence: d.sequence,
        request: state.retired ? null : state.cache.get(key),
      },
    }
    return state.read ? await state.read(reply) : reply
  }
  return { state, transport: createExtensionTransport(send, 10) }
}
test('a late response is reconciled against current ownership before one delivery', async () => {
  const f = fixture()
  let settle!: (value: any) => void
  let held: any
  f.state.read = async (reply) => {
    held = reply
    return await new Promise((r) => (settle = r))
  }
  await expect(f.transport('poll', {}, 'browser')).rejects.toThrow('timed out')
  await expect(f.transport('poll', {}, 'browser')).rejects.toThrow('timed out')
  expect(f.state.calls.filter((c) => c.path === 'poll-v2').length).toBe(1)
  f.state.read = null
  settle(held)
  expect(((await f.transport('poll', {}, 'browser')) as any).request).toEqual(job)
  expect(f.state.dequeues).toBe(1)
  expect(f.state.calls.at(-1).data.reconcile).toBe(true)
})
for (const kind of ['port-close', 'fetch-failure', 'malformed', 'missing-echo'])
  test(`settled ${kind} retries the same logical read after negotiation`, async () => {
    const f = fixture()
    let first = true
    f.state.read = async (reply) => {
      if (!first) return reply
      first = false
      if (kind === 'port-close') throw new Error('message port closed')
      if (kind === 'fetch-failure') return { ok: false, error: 'fetch failed' }
      if (kind === 'missing-echo') return { ok: true, data: { request: job } }
      return { malformed: true }
    }
    await expect(f.transport('poll', {}, 'browser')).rejects.toThrow()
    expect(((await f.transport('poll', {}, 'browser')) as any).request).toEqual(job)
    const reads = f.state.calls.filter((c) => c.path === 'poll-v2')
    expect(reads.map((c) => c.data.sequence)).toEqual([1, 1])
    expect(f.state.dequeues).toBe(1)
    expect(f.state.calls.map((c) => c.path)).toEqual([
      'poll-open',
      'poll-v2',
      'poll-open',
      'poll-v2',
    ])
  })
test('unsupported server only receives non-dequeue negotiation without legacy downgrade', async () => {
  const f = fixture()
  f.state.unsupported = true
  for (let i = 0; i < 2; i++) await expect(f.transport('poll', {}, 'browser')).rejects.toThrow()
  expect(f.state.calls.map((c) => c.path)).toEqual(['poll-open', 'poll-open'])
  expect(f.state.dequeues).toBe(0)
})
test('a changed server epoch abandons the old logical response without replaying its command', async () => {
  const f = fixture()
  f.state.read = async () => ({ ok: false, error: 'offline' })
  await expect(f.transport('poll', {}, 'browser')).rejects.toThrow()
  f.state.epoch = epochB
  f.state.read = null
  f.state.queue.push({ ...job, requestId: 'new' })
  expect(((await f.transport('poll', {}, 'browser')) as any).request.requestId).toBe('new')
  expect(f.state.calls.at(-1).data.sequence).toBe(1)
  expect(f.state.calls.at(-1).data.epoch).toBe(epochB)
})
test('concurrent callers cannot both consume one queued command', async () => {
  const f = fixture()
  let settle!: (value: any) => void
  let held: any
  f.state.read = async (reply) => {
    held = reply
    return await new Promise((r) => (settle = r))
  }
  const first = f.transport('poll', {}, 'browser')
  await expect(f.transport('poll', {}, 'browser')).rejects.toThrow('consumer')
  await new Promise((r) => setTimeout(r, 1))
  settle(held)
  expect(((await first) as any).request).toEqual(job)
  expect(f.state.dequeues).toBe(1)
})
test('permanently unresolved runtime polls stay protected without issuing another read', async () => {
  const f = fixture()
  f.state.read = async () => await new Promise(() => {})
  for (let i = 0; i < 3; i++)
    await expect(f.transport('poll', {}, 'browser')).rejects.toThrow('timed out')
  expect(f.state.calls.filter((c) => c.path === 'poll-v2').length).toBe(1)
})
test('BFCache activation changes reconcile and retire a late old command before delivery', async () => {
  const f = fixture()
  let settle!: (value: any) => void
  let held: any
  f.state.read = async (reply) => {
    held = reply
    return await new Promise((r) => (settle = r))
  }
  await expect(f.transport('poll', {}, 'browser')).rejects.toThrow('timed out')
  f.transport.suspend()
  f.transport.activate()
  f.state.retired = true
  f.state.read = null
  settle(held)
  expect(((await f.transport('poll', {}, 'browser')) as any).request).toBe(null)
  expect(f.state.calls.at(-1).data.activation).toBeGreaterThan(held.data.activation)
  expect(f.state.calls.at(-1).data.reconcile).toBe(true)
})
test('event receipt retry remains independent from an indeterminate poll', async () => {
  const f = fixture()
  f.state.read = async () => ({ ok: false, error: 'offline' })
  await expect(f.transport('poll', {}, 'browser')).rejects.toThrow()
  expect(await f.transport('event', { type: 'stop', requestId: 'first' }, 'browser')).toEqual({
    accepted: true,
  })
})
