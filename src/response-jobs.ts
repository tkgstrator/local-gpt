import { PROGRESS_IDLE_TIMEOUT_MS } from './timeouts'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
export class ResponseJobStorageError extends Error {
  code = 'response_job_storage_unavailable'
  constructor() {
    super('Response job storage is unavailable; no request was dispatched.')
  }
}
export const ResponseJobPhaseSchema = z.enum([
  'processing',
  'thinking',
  'answering',
  'unresponsive',
  'completed',
  'failed',
])
export const ResponseJobSchema = z.object({
  object: z.literal('response_job'),
  id: z.string().uuid(),
  status: z.enum(['in_progress', 'completed', 'failed']),
  phase: ResponseJobPhaseSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string(),
  message: z.string().optional(),
  context: z
    .object({
      requestId: z.string(),
      browserId: z.string(),
      sessionId: z.string().optional(),
      conversationId: z.string().optional(),
    })
    .optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  persistenceError: z.object({ code: z.string(), message: z.string() }).optional(),
})
export type ResponseJobEvent =
  | { type: 'response_job.updated'; job: ResponseJob }
  | { type: 'response.output_text.delta'; delta: string }
  | { type: 'response.output_text.snapshot'; text: string }
export type ResponseJob = z.infer<typeof ResponseJobSchema>
export function createResponseJobStore(
  options: {
    maxJobs?: number
    ttlMs?: number
    idleTimeoutMs?: number
    now?: () => number
    dir?: string
    maxRecordBytes?: number
  } = {},
) {
  const maxJobs = options.maxJobs ?? 100
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000
  const idleTimeoutMs = options.idleTimeoutMs ?? PROGRESS_IDLE_TIMEOUT_MS
  const now = options.now ?? Date.now
  const jobs = new Map<string, ResponseJob>()
  const texts = new Map<string, string>()
  const dir = options.dir
  const maxRecordBytes = options.maxRecordBytes ?? 32 * 1024 * 1024
  const persist = (job: ResponseJob) => {
    if (!dir) return
    const durableJob = structuredClone(job)
    delete durableJob.persistenceError
    if (durableJob.result && 'instructions' in durableJob.result)
      durableJob.result.instructions = null
    const data = JSON.stringify({ job: durableJob, text: texts.get(job.id) ?? '' })
    if (Buffer.byteLength(data) > maxRecordBytes) throw new Error('response_job_record_too_large')
    const target = join(dir, job.id + '.json'),
      temporary = target + '.tmp'
    try {
      writeFileSync(temporary, data, { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, target)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        /* A failed cleanup never replaces the write error. */
      }
      throw error
    }
  }
  // Partial text arrives per token; coalesce its disk writes. Terminal and phase changes persist immediately.
  const dirty = new Set<string>()
  const pendingDeletes = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const scheduleFlush = (delay: number) => {
    if (closed || flushTimer) return
    flushTimer = setTimeout(flush, delay)
    flushTimer.unref?.()
  }
  const tryPersist = (job: ResponseJob) => {
    const wasFailing = Boolean(job.persistenceError)
    try {
      persist(job)
      dirty.delete(job.id)
      delete job.persistenceError
    } catch {
      dirty.add(job.id)
      job.persistenceError = {
        code: 'response_job_storage_unavailable',
        message:
          'The latest state is available in memory but is not durably saved. It may be lost on restart; generation is not retried.',
      }
      if (!wasFailing)
        console.error(JSON.stringify({ event: 'response_job_persist_failed', id: job.id }))
      scheduleFlush(1000)
    }
    if (wasFailing !== Boolean(job.persistenceError))
      emit(job.id, { type: 'response_job.updated', job: structuredClone(job) })
  }
  const flush = () => {
    clearTimeout(flushTimer)
    flushTimer = undefined
    for (const id of dirty) {
      const job = jobs.get(id)
      if (job) tryPersist(job)
      else dirty.delete(id)
    }
    for (const id of pendingDeletes) erase(id)
    if (dirty.size || pendingDeletes.size) scheduleFlush(1000)
  }
  const erase = (id: string) => {
    dirty.delete(id)
    if (dir) {
      try {
        unlinkSync(join(dir, id + '.json'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (!pendingDeletes.has(id))
            console.error(JSON.stringify({ event: 'response_job_delete_failed', id }))
          pendingDeletes.add(id)
          scheduleFlush(1000)
          return
        }
      }
    }
    pendingDeletes.delete(id)
  }
  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    for (const filename of readdirSync(dir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(filename)) continue
      const path = join(dir, filename)
      if (statSync(path).size > maxRecordBytes) throw new Error('response_job_record_too_large')
      const stored = z
        .object({ job: ResponseJobSchema, text: z.string().max(5_000_000) })
        .parse(JSON.parse(readFileSync(path, 'utf8')))
      if (filename !== stored.job.id + '.json') throw new Error('response_job_record_mismatch')
      if (stored.job.status !== 'in_progress' && now() - Date.parse(stored.job.updatedAt) > ttlMs) {
        erase(stored.job.id)
        continue
      }
      if (stored.job.status === 'in_progress') {
        stored.job.phase = 'unresponsive'
        stored.job.message =
          'Server restarted. Remote generation outcome is unknown; browser slot remains reserved. Do not resend. Manual recovery is required.'
      }
      jobs.set(stored.job.id, stored.job)
      delete stored.job.persistenceError
      texts.set(stored.job.id, stored.text)
      chmodSync(path, 0o600)
    }
  }
  const subscribers = new Map<string, Set<(event: ResponseJobEvent) => void>>()
  const emit = (id: string, event: ResponseJobEvent) => {
    for (const listener of subscribers.get(id) ?? []) listener(structuredClone(event))
  }
  const updated = (job: ResponseJob) => {
    tryPersist(job)
    emit(job.id, { type: 'response_job.updated', job: structuredClone(job) })
  }
  const stamp = () => new Date(now()).toISOString()
  const expire = () => {
    for (const [id, job] of jobs)
      if (job.status !== 'in_progress' && now() - Date.parse(job.updatedAt) > ttlMs) {
        erase(id)
        jobs.delete(id)
        texts.delete(id)
      }
  }
  const get = (id: string) => {
    expire()
    const job = jobs.get(id)
    if (
      job?.status === 'in_progress' &&
      job.phase !== 'unresponsive' &&
      now() - Date.parse(job.lastActivityAt) >= idleTimeoutMs
    ) {
      job.phase = 'unresponsive'
      job.updatedAt = stamp()
      job.message =
        'No recent native API activity. The request outcome is unknown; continue polling and do not resend.'
    }
    return job ? structuredClone(job) : null
  }
  return {
    get,
    flush,
    close() {
      closed = true
      flush()
    },
    context(id: string, context: NonNullable<ResponseJob['context']>) {
      const job = jobs.get(id)
      if (!job || job.status !== 'in_progress') return
      job.context = structuredClone(context)
      tryPersist(job)
    },
    activeCount: () => [...jobs.values()].filter((job) => job.status === 'in_progress').length,
    text: (id: string) => texts.get(id) ?? '',
    subscribe(id: string, listener: (event: ResponseJobEvent) => void) {
      let listeners = subscribers.get(id)
      if (!listeners) {
        listeners = new Set()
        subscribers.set(id, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners!.delete(listener)
        if (!listeners!.size) subscribers.delete(id)
      }
    },
    answer(id: string, text: string) {
      const job = jobs.get(id)
      if (!job || job.status !== 'in_progress') return
      const previous = texts.get(id) ?? ''
      if (text === previous) return
      texts.set(id, text)
      if (dir) {
        dirty.add(id)
        scheduleFlush(250)
      }
      if (text.startsWith(previous))
        emit(id, { type: 'response.output_text.delta', delta: text.slice(previous.length) })
      else emit(id, { type: 'response.output_text.snapshot', text })
    },
    create() {
      expire()
      if (jobs.size >= maxJobs)
        throw new Error('Response job capacity reached; wait for completed results to expire.')
      const at = stamp()
      const job: ResponseJob = {
        object: 'response_job',
        id: randomUUID(),
        status: 'in_progress',
        phase: 'processing',
        createdAt: at,
        updatedAt: at,
        lastActivityAt: at,
      }
      try {
        persist(job)
      } catch {
        throw new ResponseJobStorageError()
      }
      jobs.set(job.id, job)
      return get(job.id)!
    },
    remove: (id: string) => {
      erase(id)
      texts.delete(id)
      return jobs.delete(id)
    },
    progress(id: string, phase: 'processing' | 'thinking' | 'answering' | 'unresponsive') {
      const job = jobs.get(id)
      if (!job || job.status !== 'in_progress') return
      job.phase = phase
      job.updatedAt = stamp()
      if (phase === 'unresponsive')
        job.message =
          'No recent native API activity. The request outcome is unknown; continue polling and do not resend.'
      else {
        job.lastActivityAt = job.updatedAt
        delete job.message
      }
      updated(job)
    },
    complete(id: string, result: Record<string, unknown>) {
      const job = jobs.get(id)
      if (!job || job.status !== 'in_progress') return
      texts.delete(id)
      job.status = 'completed'
      job.phase = 'completed'
      job.updatedAt = stamp()
      job.lastActivityAt = job.updatedAt
      job.result = structuredClone(result)
      delete job.message
      updated(job)
    },
    fail(id: string, code: string, message: string) {
      const job = jobs.get(id)
      if (!job || job.status !== 'in_progress') return
      job.status = 'failed'
      job.phase = 'failed'
      job.updatedAt = stamp()
      job.error = { code, message }
      delete job.message
      updated(job)
    },
  }
}
