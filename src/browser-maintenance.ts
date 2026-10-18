import { z } from 'zod'
export const MaintenanceTargetSchema = z
  .object({
    browserId: z.string().min(1).max(100),
    tabId: z.number().int().nonnegative(),
    documentId: z.string().min(1).max(100),
  })
  .strict()
export type MaintenanceTarget = z.infer<typeof MaintenanceTargetSchema>
export const MaintenanceRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('probe') }).strict(),
  z.object({ action: z.literal('invalidate'), target: MaintenanceTargetSchema }).strict(),
  z.object({ action: z.literal('acquire'), target: MaintenanceTargetSchema }).strict(),
  z
    .object({
      action: z.literal('validate'),
      target: MaintenanceTargetSchema,
      lease: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal('cancel'),
      target: MaintenanceTargetSchema,
      lease: z.string().min(1).max(100),
    })
    .strict(),
])
export const sameTarget = (a: MaintenanceTarget | null, b: MaintenanceTarget) =>
  a?.browserId === b.browserId && a.tabId === b.tabId && a.documentId === b.documentId

export const MaintenanceGrantSchema = z.object({
  ready: z.literal(true),
  lease: z.string().uuid(),
  expiresAt: z.number().finite(),
})
export const MaintenanceValidationSchema = z.object({
  ready: z.literal(true),
  expiresAt: z.number().finite(),
})
