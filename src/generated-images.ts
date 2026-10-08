import { mkdirSync, writeFileSync, readFileSync, lstatSync, unlinkSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  GeneratedImageSchema,
  ImageDataSchema,
  type ImageData,
  ImageDownloadUrlSchema,
  ImageFileIdSchema,
  MAX_IMAGE_BYTES,
  type GeneratedImage,
} from './generated-image-protocol'
const extensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const
function mime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  throw new Error('Unsupported or invalid image bytes.')
}
export function createImageStore(
  directory: string,
  hostDirectory?: string,
  fetcher: typeof fetch = fetch,
) {
  const root = resolve(directory)
  if (hostDirectory && !isAbsolute(hostDirectory))
    throw new Error('Image host directory must be absolute.')
  const publicRoot = hostDirectory ?? root
  const persist = (
    fileId: string,
    bytes: Buffer,
    mimeType: keyof typeof extensions,
  ): GeneratedImage => {
    const id = randomUUID(),
      name = `${id}.${extensions[mimeType]}`
    const metadata = GeneratedImageSchema.parse({
      id,
      fileId,
      mimeType,
      bytes: bytes.length,
      path: join(publicRoot, name),
      url: `/v1/images/${id}`,
    })
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const file = join(root, name)
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
    try {
      writeFileSync(join(root, `${id}.json`), JSON.stringify(metadata), {
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      unlinkSync(file)
      throw error
    }
    return metadata
  }
  return {
    async saveData(fileId: string, image: ImageData): Promise<GeneratedImage> {
      ImageFileIdSchema.parse(fileId)
      ImageDataSchema.parse(image)
      const bytes = Buffer.from(image.data, 'base64')
      if (bytes.length > MAX_IMAGE_BYTES || mime(bytes) !== image.mimeType)
        throw new Error('Invalid image data.')
      return persist(fileId, bytes, image.mimeType)
    },
    async save(fileId: string, downloadUrl: string, signal?: AbortSignal): Promise<GeneratedImage> {
      ImageFileIdSchema.parse(fileId)
      ImageDownloadUrlSchema.parse(downloadUrl)
      const response = await fetcher(downloadUrl, {
        redirect: 'error',
        credentials: 'omit',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      })
      if (!response.ok || !response.body) throw new Error('Image download failed.')
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
        void response.body.cancel().catch(() => {})
        throw new Error('Generated image exceeds 8 MiB.')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds 8 MiB.')
          chunks.push(value)
        }
      } finally {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      const bytes = Buffer.concat(chunks),
        mimeType = mime(bytes)
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== mimeType)
        throw new Error('Image content type does not match its bytes.')
      return persist(fileId, bytes, mimeType)
    },
    read(id: string): { file: string; metadata: GeneratedImage } | null {
      if (!z.string().uuid().safeParse(id).success) return null
      try {
        const manifest = join(root, `${id}.json`)
        if (!lstatSync(manifest).isFile()) return null
        const metadata = GeneratedImageSchema.parse(JSON.parse(readFileSync(manifest, 'utf8')))
        if (metadata.id !== id) return null
        const file = join(root, `${id}.${extensions[metadata.mimeType]}`),
          stat = lstatSync(file)
        if (!stat.isFile() || stat.size !== metadata.bytes) return null
        return {
          file,
          metadata: {
            ...metadata,
            path: join(publicRoot, `${id}.${extensions[metadata.mimeType]}`),
          },
        }
      } catch {
        return null
      }
    },
  }
}
