import { ProjectIdSchema } from './projects'
import {
  ImageDataSchema,
  ImageFileIdSchema,
  ImageDownloadUrlSchema,
} from './generated-image-protocol'
import { FilesSchema, BrowserFileSchema } from './attachment-protocol'
import { DotActionSchema, DotResultSchema } from './dots'
import { z } from 'zod'
import { CapabilitiesSchema } from './capabilities'
z.config({ jitless: true })

export const ChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'developer', 'user', 'assistant']),
        content: z
          .string()
          .refine((value) => value.trim().length > 0, 'Message content cannot be blank'),
      }),
    )
    .min(1),
  model: z.string().optional(),
  reasoning: z
    .object({ effort: z.string().min(1).max(200) })
    .strict()
    .optional(),
  session_id: z.string().uuid().optional(),
  files: FilesSchema.optional(),
  stream: z.boolean().default(false),
  newChat: z.boolean().default(true),
})
export const ModelObservationSchema = z.object({
  selected: z.string().min(1).max(200).nullable(),
  models: z.array(z.string().min(1).max(200)).max(100),
  source: z.literal('visible_ui'),
  selectionLabel: z.string().max(200).nullable().default(null),
})
export const BrowserRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event_ack'),
    requestId: z.string(),
    eventId: z.string(),
    accepted: z.boolean(),
  }),
  z.object({
    type: z.literal('move_conversation'),
    requestId: z.string().min(1),
    conversationId: z.string().uuid(),
    projectName: z.string().min(1).max(200),
    projectId: ProjectIdSchema.optional(),
  }),
  z.object({
    type: z.literal('delete_conversation'),
    projectId: ProjectIdSchema.optional(),
    requestId: z.string().min(1),
    conversationId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('request'),
    native: z.boolean().optional(),
    nativeUserMessageId: z.string().uuid().optional(),
    timeoutMs: z.number().int().positive().max(7200000).optional(),
    backgroundJob: z.boolean().optional(),
    projectName: z.string().min(1).max(200).optional(),
    projectId: ProjectIdSchema.optional(),
    requestId: z.string().min(1),
    text: z.string().min(1),
    newChat: z.boolean(),
    files: z.array(BrowserFileSchema).max(10).optional(),
    model: z.string().optional(),
    reasoning: z.object({ effort: z.string().min(1).max(200) }).optional(),
    conversationId: z.string().uuid().optional(),
  }),
  z.object({ type: z.literal('native_readiness'), requestId: z.string().min(1) }),
  z.object({ type: z.literal('models'), requestId: z.string().min(1) }),
  z.object({ type: z.literal('capabilities'), requestId: z.string().min(1) }),
  z.object({ type: z.literal('navigation_ready'), requestId: z.string().min(1) }),
  z.object({ type: z.literal('dots'), requestId: z.string().min(1), operation: DotActionSchema }),
])
export const BrowserEventSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('native_ready'),
      requestId: z.string().min(1),
      protocol: z.literal(1),
      ready: z.boolean(),
    }),
    z.object({
      type: z.literal('native_intent'),
      requestId: z.string().min(1),
      nativeUserMessageId: z.string().uuid(),
    }),
    z.object({
      type: z.literal('native_dispatch_refused'),
      requestId: z.string().min(1),
      nativeUserMessageId: z.string().uuid(),
      code: z.string().min(1),
      message: z.string(),
    }),
    z.object({
      type: z.literal('native_identity'),
      requestId: z.string().min(1),
      nativeUserMessageId: z.string().uuid(),
      clientThreadId: z.string().min(1).max(200).optional(),
      conversationId: z.string().uuid().optional(),
    }),
    z.object({
      type: z.literal('progress'),
      requestId: z.string().min(1),
      phase: z.enum(['processing', 'thinking', 'answering', 'unresponsive']),
    }),
    z.object({
      type: z.literal('conversation_project'),
      requestId: z.string().min(1),
      conversationId: z.string().uuid(),
      projectId: ProjectIdSchema,
    }),
    z
      .object({
        type: z.literal('image'),
        requestId: z.string().min(1),
        conversationId: z.string().uuid(),
        fileId: ImageFileIdSchema,
        downloadUrl: ImageDownloadUrlSchema.optional(),
        imageData: ImageDataSchema.optional(),
      })
      .refine(
        (image) => Boolean(image.downloadUrl) !== Boolean(image.imageData),
        'Provide exactly one image payload',
      ),
    z.object({
      type: z.literal('conversation_deleted'),
      requestId: z.string().min(1),
      conversationId: z.string().uuid(),
    }),
    z.object({ type: z.literal('answer'), requestId: z.string().min(1), text: z.string() }),
    z.object({
      type: z.literal('stop'),
      projectId: ProjectIdSchema.optional(),
      requestId: z.string().min(1),
      conversationId: z.string().uuid().optional(),
    }),
    z.object({
      type: z.literal('error'),
      requestId: z.string().min(1),
      code: z.string().min(1),
      message: z.string(),
    }),
    z.object({ type: z.literal('heartbeat') }),
    z.object({
      type: z.literal('navigate'),
      requestId: z.string().min(1),
      conversationId: z.string().uuid(),
    }),
    z.object({ type: z.literal('dots'), requestId: z.string().min(1), result: DotResultSchema }),
    CapabilitiesSchema.extend({ type: z.literal('capabilities'), requestId: z.string().min(1) }),
    ModelObservationSchema.extend({ type: z.literal('models'), requestId: z.string().min(1) }),
  ])
  .and(
    z.object({
      eventId: z.string().max(100).optional(),
      nativeUserMessageId: z.string().uuid().optional(),
      terminalEvidence: z.boolean().optional(),
      preDispatch: z.boolean().optional(),
    }),
  )
export type BrowserRequest = z.infer<typeof BrowserRequestSchema>
export type BrowserEvent = z.infer<typeof BrowserEventSchema>
export type ChatRequest = z.infer<typeof ChatRequestSchema>
