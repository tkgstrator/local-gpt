import { z } from 'zod'
import { ResponseJobSchema, type ResponseJob, type ResponseJobEvent } from './response-jobs'
const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('response_job.updated'), job: ResponseJobSchema }),
  z.object({ type: z.literal('response_job.wait_finished'), job: ResponseJobSchema }),
  z.object({ type: z.literal('response.output_text.delta'), delta: z.string() }),
  z.object({ type: z.literal('response.output_text.snapshot'), text: z.string() }),
])
export async function waitForResponseJob(
  base: string,
  id: string,
  waitMs: number,
  signal?: AbortSignal,
  onEvent?: (event: ResponseJobEvent) => void,
): Promise<ResponseJob> {
  const deadline = AbortSignal.timeout(waitMs + 5000)
  const response = await fetch(
    `${base}/v1/response-jobs/${encodeURIComponent(id)}/events?wait_ms=${waitMs}`,
    {
      headers: { Accept: 'text/event-stream' },
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    },
  )
  if (!response.ok) {
    const value = (await response.json()) as { error?: { code?: string } }
    throw new Error(value.error?.code ?? `LocalGPT HTTP ${response.status}`)
  }
  if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream'))
    throw new Error('invalid_job_stream')
  for await (const value of readSseEvents(response)) {
    const event = EventSchema.parse(value)
    if ('job' in event && event.job.id !== id) throw new Error('job_stream_mismatch')
    if (event.type === 'response_job.wait_finished') return event.job
    onEvent?.(event)
    if (event.type === 'response_job.updated' && event.job.status !== 'in_progress')
      return event.job
  }
  throw new Error('job_stream_interrupted: result retrieval stopped; do not resend the generation')
}
export async function* readSseEvents(response: Response): AsyncGenerator<unknown> {
  if (!response.body) throw new Error('invalid_event_stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n')
      if (buffer.length > 32 * 1024 * 1024) throw new Error('job_stream_too_large')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue
        yield JSON.parse(data)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
