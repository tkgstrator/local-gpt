import { z } from 'zod'
import { BrowserRequestSchema, type BrowserRequest } from './protocol'
import { sameTarget, type MaintenanceTarget } from './browser-maintenance'
export const PollOpenSchema = z
  .object({
    protocol: z.literal(1),
    streamId: z.string().uuid(),
    activation: z.number().finite().positive(),
  })
  .strict()
export const PollReadSchema = PollOpenSchema.extend({
  epoch: z.string().uuid(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  nativeProtocol: z.literal(1).optional(),
  reconcile: z.boolean().optional(),
}).strict()
export const PollOpenReplySchema = z.object({
  protocol: z.literal(1),
  epoch: z.string().uuid(),
  streamId: z.string().uuid(),
  activation: z.number().finite().positive().optional(),
  error: z.string().optional(),
})
export const PollReadReplySchema = PollOpenReplySchema.extend({
  sequence: z.number().int().min(1),
  request: BrowserRequestSchema.nullable().optional(),
  retired: z.boolean().optional(),
  update: z.unknown().optional(),
})
type Read = z.infer<typeof PollReadSchema>
interface RecordState {
  target: MaintenanceTarget
  next: number
  response?: BrowserRequest | null
  fenced: boolean
  activation: number
}
export class PollJournal {
  readonly epoch = crypto.randomUUID()
  private records = new Map<string, RecordState>()
  private current = new Map<number, string>()
  private bodies = 0
  constructor(private limits: { maxStreams?: number; maxBodies?: number } = {}) {}
  private fault(streamId: string, error: string, sequence?: number) {
    return {
      protocol: 1 as const,
      epoch: this.epoch,
      streamId,
      ...(sequence === undefined ? {} : { sequence }),
      error,
    }
  }
  private setResponse(record: RecordState, value: BrowserRequest | null) {
    if (record.response) this.bodies--
    record.response = value
    if (value) this.bodies++
  }
  open(target: MaintenanceTarget, streamId: string, activation: number) {
    const current = this.records.get(this.current.get(target.tabId) ?? '')
    if (
      current &&
      (activation < current.activation ||
        (activation === current.activation && this.current.get(target.tabId) !== streamId))
    )
      return this.fault(streamId, 'inactive_document')
    const existing = this.records.get(streamId)
    if (existing) {
      if (!sameTarget(existing.target, target)) return this.fault(streamId, 'stream_replaced')
      if (existing.fenced && activation <= existing.activation)
        return this.fault(streamId, 'stream_replaced')
      if (current && current !== existing) {
        current.fenced = true
        this.setResponse(current, null)
      }
      existing.fenced = false
      existing.activation = activation
      this.current.set(target.tabId, streamId)
      return { protocol: 1 as const, epoch: this.epoch, streamId, activation }
    }
    // Keep small high-water tombstones for this boot. Never evict one into a fresh read.
    if (this.records.size >= (this.limits.maxStreams ?? 4096))
      return this.fault(streamId, 'poll_capacity')
    const previous = this.records.get(this.current.get(target.tabId) ?? '')
    if (previous) {
      previous.fenced = true
      this.setResponse(previous, null)
    }
    this.records.set(streamId, { target, next: 1, fenced: false, activation })
    this.current.set(target.tabId, streamId)
    return { protocol: 1 as const, epoch: this.epoch, streamId, activation }
  }
  registered(tabId: number) {
    return this.current.has(tabId)
  }
  check(target: MaintenanceTarget, input: Read): string | null {
    if (input.epoch !== this.epoch) return 'epoch_changed'
    const record = this.records.get(input.streamId)
    if (!record) return 'stream_missing'
    if (
      record.fenced ||
      !sameTarget(record.target, target) ||
      this.current.get(target.tabId) !== input.streamId
    )
      return 'stream_replaced'
    if (input.activation !== record.activation) return 'inactive_document'
    if (input.sequence < record.next - 1) return 'stale_poll'
    if (input.sequence > record.next) return 'invalid_sequence'
    if (input.sequence === record.next && input.reconcile) return 'poll_not_processed'
    if (input.sequence === record.next - 1 && record.response === undefined) return 'cache_missing'
    return null
  }
  retireInvalid(owned: (target: MaintenanceTarget, request: BrowserRequest) => boolean) {
    for (const record of this.records.values())
      if (record.response && !owned(record.target, record.response)) this.setResponse(record, null)
  }
  read(
    target: MaintenanceTarget,
    input: Read,
    dequeue: () => BrowserRequest | null,
    owned: (request: BrowserRequest) => boolean,
    blocked: boolean,
  ) {
    const error = this.check(target, input)
    if (error) return this.fault(input.streamId, error, input.sequence)
    const record = this.records.get(input.streamId)!
    let retired = false
    if (input.sequence === record.next) {
      // A successful next read acknowledges consumption of the preceding response.
      if (this.bodies - (record.response ? 1 : 0) >= (this.limits.maxBodies ?? 32))
        return this.fault(input.streamId, 'poll_capacity', input.sequence)
      this.setResponse(record, blocked ? null : dequeue())
      record.next++
    } else if (record.response && (blocked || !owned(record.response))) {
      this.setResponse(record, null)
      retired = true
    }
    return {
      protocol: 1 as const,
      epoch: this.epoch,
      streamId: input.streamId,
      sequence: input.sequence,
      activation: input.activation,
      request: record.response ?? null,
      ...(retired ? { retired: true } : {}),
    }
  }
}
