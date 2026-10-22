export const HISTORY_RATE_LIMITED = 'native_history_rate_limited'
// Exact message observed from the native SDK; deliberately not a broad text match.
export const SDK_HISTORY_RATE_LIMIT_MESSAGE = 'ChatGPT conversation history was rate limited'

export class NativeHistoryRateLimitError extends Error {
  constructor(
    // Retryable errors come from an observed 429; non-retryable ones mean the
    // cooldown cannot fit inside the caller's deadline.
    readonly retryable: boolean,
    readonly cooldownUntil?: number,
  ) {
    super(HISTORY_RATE_LIMITED)
  }
}

export type HistoryClock = {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  random: () => number
}
const realClock: HistoryClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function header(source: unknown, name: string): string | undefined {
  if (!object(source)) return undefined
  const headers = source.headers
  if (headers && typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (key: string) => unknown }).get(name)
    return typeof value === 'string' ? value : undefined
  }
  if (object(headers)) {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
    const value = key ? headers[key] : undefined
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/** Returns undefined for anything that is not a history rate limit. */
export function classifyHistoryRateLimit(
  error: unknown,
  now: number,
): { retryAfterMs?: number } | undefined {
  if (!object(error)) return undefined
  const response = object(error.response) ? error.response : undefined
  const limited =
    error.status === 429 ||
    response?.status === 429 ||
    (error instanceof Error && error.message === SDK_HISTORY_RATE_LIMIT_MESSAGE)
  if (!limited) return undefined
  const raw = (header(error, 'retry-after') ?? header(response, 'retry-after'))?.trim()
  if (!raw) return {}
  if (/^\d{1,9}$/.test(raw)) return { retryAfterMs: Number(raw) * 1000 }
  const date = Date.parse(raw)
  if (Number.isFinite(date) && date > now) return { retryAfterMs: date - now }
  return {}
}

type Item = {
  task: (signal: AbortSignal) => Promise<unknown>
  options: HistoryRunOptions
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  detach: () => void
}
export type HistoryRunOptions = {
  signal?: AbortSignal
  /** Throws if the work is no longer wanted; called immediately before every SDK start. */
  validate?: () => void
  /** Absolute clock time after which a start (including cooldown waits) is refused. */
  deadline?: number
}
export type HistorySchedulerOptions = {
  maxInFlight?: number
  spacingMs?: number
  maxQueue?: number
  baseDelayMs?: number
  maxDelayMs?: number
  clock?: HistoryClock
}

export class NativeHistoryScheduler {
  private queue: Item[] = []
  private inFlight = 0
  private nextStart = 0
  private cooldownUntil = 0
  private failures = 0
  private timer: unknown
  private readonly maxInFlight: number
  private readonly spacingMs: number
  private readonly maxQueue: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  readonly clock: HistoryClock

  constructor(options: HistorySchedulerOptions = {}) {
    this.maxInFlight = options.maxInFlight ?? 2
    this.spacingMs = options.spacingMs ?? 1000
    this.maxQueue = options.maxQueue ?? 32
    this.baseDelayMs = options.baseDelayMs ?? 2000
    this.maxDelayMs = options.maxDelayMs ?? 60000
    this.clock = options.clock ?? realClock
  }
  get pending() {
    return this.queue.length
  }
  get active() {
    return this.inFlight
  }

  run<T>(task: (signal: AbortSignal) => Promise<T>, options: HistoryRunOptions = {}): Promise<T> {
    const { signal } = options
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    if (this.queue.length >= this.maxQueue)
      return Promise.reject(new Error('native_history_queue_full'))
    return new Promise<T>((resolve, reject) => {
      const item: Item = {
        task,
        options,
        resolve: resolve as (value: unknown) => void,
        reject,
        detach: () => {},
      }
      if (signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(item)
          if (index < 0) return
          this.queue.splice(index, 1)
          item.detach()
          reject(abortReason(signal))
          this.pump()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        item.detach = () => signal.removeEventListener('abort', onAbort)
      }
      this.queue.push(item)
      this.pump()
    })
  }

  private pump() {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.queue.length && this.inFlight < this.maxInFlight) {
      const now = this.clock.now()
      const head = this.queue[0]!
      const start = Math.max(now, this.nextStart, this.cooldownUntil)
      if (head.options.deadline !== undefined && start >= head.options.deadline) {
        this.queue.shift()
        head.detach()
        head.reject(new NativeHistoryRateLimitError(false, this.cooldownUntil))
        continue
      }
      if (start > now) {
        this.timer = this.clock.setTimeout(
          () => {
            this.timer = undefined
            this.pump()
          },
          Math.min(start - now, 2_147_483_647),
        )
        return
      }
      this.queue.shift()
      head.detach()
      try {
        head.options.validate?.()
        if (head.options.signal?.aborted) throw abortReason(head.options.signal)
      } catch (error) {
        // Canceled work consumes neither a slot nor start spacing.
        head.reject(error)
        continue
      }
      this.start(head, now)
    }
  }

  private start(item: Item, now: number) {
    this.nextStart = now + this.spacingMs
    this.inFlight++
    const controller = new AbortController()
    const { signal } = item.options
    const forward = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forward, { once: true })
    let settled = false
    const finish = (run: () => void) => {
      signal?.removeEventListener('abort', forward)
      if (!settled) {
        settled = true
        run()
      }
    }
    let result: Promise<unknown>
    try {
      result = Promise.resolve(item.task(controller.signal))
    } catch (error) {
      result = Promise.reject(error)
    }
    // Keep both the slot and this promise until the SDK settles. The dispatcher's
    // bounded waiter may return earlier, but its singleflight must stay reserved.
    void result.then(
      (value) => {
        this.failures = 0
        this.inFlight--
        finish(() => {
          try {
            if (signal?.aborted) throw abortReason(signal)
            item.options.validate?.()
            item.resolve(value)
          } catch (error) {
            item.reject(error)
          }
        })
        this.pump()
      },
      (error) => {
        this.inFlight--
        if (signal?.aborted) {
          finish(() => item.reject(abortReason(signal)))
          this.pump()
          return
        }
        const limited = classifyHistoryRateLimit(error, this.clock.now())
        if (limited) {
          this.cooldown(limited.retryAfterMs)
          finish(() => item.reject(new NativeHistoryRateLimitError(true, this.cooldownUntil)))
        } else finish(() => item.reject(error))
        this.pump()
      },
    )
  }

  private cooldown(retryAfterMs?: number) {
    this.failures++
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.failures - 1))
    const backoff = Math.min(this.maxDelayMs, exponential * (1 + 0.25 * this.clock.random()))
    // A server-directed delay is never shortened, only extended by the shared backoff floor.
    const delay = retryAfterMs === undefined ? backoff : retryAfterMs
    this.cooldownUntil = Math.max(this.cooldownUntil, this.clock.now() + delay)
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new Error('native_history_aborted')
}
