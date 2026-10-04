import { z } from 'zod'
z.config({ jitless: true })
const Id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_~.-]+$/)
export const DotSchema = z.object({
  id: Id,
  name: z.string().min(1).max(200),
  threadId: z.string().uuid(),
  paused: z.boolean(),
})
export const DotListSchema = z.object({
  dots: z.array(DotSchema).max(100),
  cursor: z.string().max(2000).nullable(),
  source: z.literal('chatgpt_api'),
  selected: Id.nullable(),
})
export type Dot = z.infer<typeof DotSchema>
export const DotActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('select'), dotId: Id }),
  z.object({
    action: z.literal('send'),
    dotId: Id,
    text: z
      .string()
      .min(1)
      .max(100000)
      .refine((t) => !!t.trim()),
  }),
  z.object({
    action: z.literal('messages'),
    dotId: Id,
    afterMessageId: Id.optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
])
export const DotMessageSchema = z.object({
  id: Id,
  role: z.enum(['user', 'dot']),
  text: z.string().max(200000),
})
export const DotResultSchema = z.discriminatedUnion('action', [
  DotListSchema.extend({ action: z.literal('list') }),
  z.object({
    action: z.literal('select'),
    dot: DotSchema,
    status: z.enum(['selected', 'navigation_requested']),
  }),
  z.object({ action: z.literal('send'), dotId: Id, messageId: Id, status: z.literal('sent') }),
  z.object({
    action: z.literal('messages'),
    dotId: Id,
    messages: z.array(DotMessageSchema).max(50),
    source: z.literal('visible_ui'),
    scope: z.literal('rendered_messages'),
    complete: z.literal(false),
  }),
])
export const DOT_EVENT = 'localgpt:dots'
const ApiDot = z.object({
  id: Id,
  display_name: z.string().min(1).max(200),
  active_root_thread_id: z.string().uuid().nullable(),
  aeon_kind: z.string(),
  is_paused: z.boolean(),
})
export function normalizeDots(
  value: unknown,
): Omit<z.infer<typeof DotListSchema>, 'selected'> | null {
  const parsed = z
    .object({ items: z.array(ApiDot).max(100), cursor: z.string().max(2000).nullable() })
    .safeParse(value)
  if (!parsed.success) return null
  return {
    dots: parsed.data.items
      .filter((d) => d.aeon_kind === 'orbit' && d.active_root_thread_id !== null)
      .map((d) => ({
        id: d.id,
        name: d.display_name,
        threadId: d.active_root_thread_id!,
        paused: d.is_paused,
      })),
    cursor: parsed.data.cursor,
    source: 'chatgpt_api',
  }
}
export function dotMessages(doc: Document) {
  return [
    ...doc.querySelectorAll<HTMLElement>('main.thread-pane article.message-row[data-message-id]'),
  ]
    .map((row) => ({
      id: row.getAttribute('data-message-id')!,
      role: row.classList.contains('self') ? ('user' as const) : ('dot' as const),
      text:
        row.querySelector<HTMLElement>('.message-text')?.innerText ??
        row.querySelector('.message-text')?.textContent ??
        '',
    }))
    .filter((m) => m.text.length > 0)
}
export function findDotEditor(doc: Document) {
  return doc.querySelector<HTMLElement>(
    'main.thread-pane [role="textbox"][contenteditable="true"][aria-label="Message"]',
  )
}
