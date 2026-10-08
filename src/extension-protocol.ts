import { z } from 'zod'
z.config({ jitless: true })
import { BrowserEventSchema } from './protocol'
const shared = { type: z.literal('bridge_request'), browserId: z.string().min(1).max(100) }
export const ExtensionRequestSchema = z.discriminatedUnion('path', [
  z
    .object({
      ...shared,
      path: z.literal('poll'),
      data: z.object({ nativeProtocol: z.literal(1).optional() }).strict(),
    })
    .strict(),
  z.object({ ...shared, path: z.literal('event'), data: BrowserEventSchema }).strict(),
  z
    .object({
      ...shared,
      path: z.literal('update-ready'),
      data: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
    })
    .strict(),
  z
    .object({
      ...shared,
      path: z.literal('reload'),
      data: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }).strict(),
    })
    .strict(),
])
export const ExtensionResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type ExtensionResponse = z.infer<typeof ExtensionResponseSchema>
