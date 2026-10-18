import { ExtensionRequestSchema, ExtensionResponseSchema } from './extension-protocol'
import { PollOpenReplySchema, PollReadReplySchema } from './sequenced-poll'
import { bounded } from './extension-maintenance'
interface Operation {
  promise: Promise<unknown>
  status: 'pending' | 'fulfilled' | 'rejected'
  value?: unknown
  indeterminate: boolean
  activation: number
  epoch: string
  sequence: number
}
// Runtime retries are the SAME logical server read. An unresolved promise is never replaced.
export function createExtensionTransport(
  send: (request: unknown) => Promise<unknown>,
  timeoutMs = 6500,
  now = Date.now,
) {
  const streamId = crypto.randomUUID()
  let activation = now(),
    active = true,
    consuming = false
  let owner: string | null = null,
    epoch: string | null = null,
    sequence = 1
  let operation: Operation | null = null
  const ensureActive = (expected = activation) => {
    if (!active || activation !== expected)
      throw new Error('Document activation changed; pending work is being preserved.')
  }
  const raw = (path: string, data: unknown, browserId: string) =>
    Promise.resolve().then(() =>
      send(ExtensionRequestSchema.parse({ type: 'bridge_request', path, data, browserId })),
    )
  const unwrap = (reply: unknown) => {
    const value = ExtensionResponseSchema.parse(reply)
    if (!value.ok) throw new Error(value.error)
    return value.data
  }
  const open = async (browserId: string) => {
    const expected = activation
    ensureActive(expected)
    const reply = PollOpenReplySchema.parse(
      unwrap(
        await bounded(
          raw('poll-open', { protocol: 1, streamId, activation: expected }, browserId),
          timeoutMs,
        ),
      ),
    )
    ensureActive(expected)
    if (reply.error || reply.streamId !== streamId || reply.activation !== expected)
      throw new Error('Safe polling is unavailable; waiting for the matching document and server.')
    if (epoch !== reply.epoch) {
      epoch = reply.epoch
      sequence = 1
      operation = null
    }
  }
  const begin = (browserId: string, data: unknown, reconcile: boolean) => {
    ensureActive()
    const op: Operation = {
      promise: raw(
        'poll-v2',
        {
          ...(data as object),
          protocol: 1,
          epoch,
          streamId,
          activation,
          sequence,
          ...(reconcile ? { reconcile: true } : {}),
        },
        browserId,
      ),
      status: 'pending',
      indeterminate: false,
      activation,
      epoch: epoch!,
      sequence,
    }
    op.promise.then(
      (value) => {
        op.status = 'fulfilled'
        op.value = value
      },
      () => {
        op.status = 'rejected'
      },
    )
    operation = op
    return op
  }
  const valid = (value: unknown, op: Operation) => {
    try {
      const result = PollReadReplySchema.parse(unwrap(value))
      return (
        !result.error &&
        result.request !== undefined &&
        result.epoch === op.epoch &&
        result.streamId === streamId &&
        result.sequence === op.sequence &&
        result.activation === op.activation
      )
    } catch {
      return false
    }
  }
  const bridge = async (path: string, data: unknown, browserId: string): Promise<unknown> => {
    if (path !== 'poll') return unwrap(await bounded(raw(path, data, browserId), timeoutMs))
    if (consuming) throw new Error('A browser poll already has a consumer')
    if (owner && owner !== browserId) throw new Error('A prior browser poll is unresolved')
    consuming = true
    owner = browserId
    let op: Operation | null = operation
    try {
      ensureActive()
      if (!op) {
        await open(browserId)
        op = begin(browserId, data, false)
      } else if (op.status !== 'pending' && op.indeterminate) {
        const reconcile = valid(op.value, op)
        await open(browserId)
        op = begin(browserId, data, operation !== null && reconcile)
      }
      let reply = await bounded(op.promise, timeoutMs)
      // A late pre-suspend/failed attempt must be reconciled against CURRENT server ownership.
      if (op.indeterminate || op.activation !== activation) {
        const reconcile = valid(reply, op)
        await open(browserId)
        op = begin(browserId, data, operation !== null && reconcile)
        reply = await bounded(op.promise, timeoutMs)
      }
      ensureActive(op.activation)
      if (!valid(reply, op))
        throw new Error('LocalGPT poll outcome is unknown; pending work is being preserved.')
      const result = PollReadReplySchema.parse(unwrap(reply))
      operation = null
      sequence++
      return result
    } catch (error) {
      if (op) op.indeterminate = true
      throw error
    } finally {
      consuming = false
    }
  }
  bridge.suspend = () => {
    active = false
  }
  bridge.activate = () => {
    active = true
    activation = Math.max(now(), activation + 1)
  }
  return bridge
}
