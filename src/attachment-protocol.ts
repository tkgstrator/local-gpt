import { z } from 'zod'
export const FilePathSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => path.startsWith('/'), 'Use an absolute local file path'),
    mode: z.enum(['auto', 'text', 'upload']).default('auto'),
  })
  .strict()
export const FilesSchema = z.array(FilePathSchema).min(1).max(10)
export const BrowserFileSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(100),
  base64: z.string().max(11_184_812),
})
export type BrowserFile = z.infer<typeof BrowserFileSchema>
