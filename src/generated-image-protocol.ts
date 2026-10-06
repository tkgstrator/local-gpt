import { z } from 'zod'
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_GENERATED_IMAGES = 4
export const ImageFileIdSchema = z.string().regex(/^file[_-][a-zA-Z0-9_-]{1,160}$/)
export const ImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export function isSignedImageUrl(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === 'oaiusercontent.com' || url.hostname.endsWith('.oaiusercontent.com'))
    )
  } catch {
    return false
  }
}
export const ImageDownloadUrlSchema = z
  .string()
  .max(16000)
  .refine(isSignedImageUrl, 'Expected an HTTPS image CDN URL')
export const GeneratedImageSchema = z
  .object({
    id: z.string().uuid(),
    fileId: ImageFileIdSchema,
    mimeType: ImageMimeSchema,
    bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
    path: z.string().min(1),
    url: z.string().regex(/^\/v1\/images\/[a-f0-9-]{36}$/),
  })
  .strict()
export type GeneratedImage = z.infer<typeof GeneratedImageSchema>

export const ImageDataSchema = z
  .object({
    mimeType: ImageMimeSchema,
    data: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((value) => value.length % 4 === 0, 'Invalid base64 length'),
  })
  .strict()
export type ImageData = z.infer<typeof ImageDataSchema>
