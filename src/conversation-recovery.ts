// Native conversation graphs remain in the page world; return only correlated visible outputs.
import { classifyGeneratedImageMessage, isVisibleAssistantOutput } from './conversation-stream'
import { MAX_GENERATED_IMAGES } from './generated-image-protocol'
type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const MAX_RECOVERY_BYTES = 8_000_000
const MAX_RECOVERY_NODES = 5000

export function boundedConversationSnapshot(value: unknown): unknown {
  if (
    !object(value) ||
    !object(value.mapping) ||
    Object.keys(value.mapping).length > MAX_RECOVERY_NODES
  )
    return null
  try {
    const serialized = JSON.stringify(value)
    if (
      serialized.length > MAX_RECOVERY_BYTES ||
      new TextEncoder().encode(serialized).byteLength > MAX_RECOVERY_BYTES
    )
      return null
    return value
  } catch {
    return null
  }
}

export function conversationFinalText(
  value: unknown,
  conversationId: string,
  messageId: string,
): string | null {
  const output = conversationFinalOutput(value, conversationId, messageId)
  return output && !('error' in output) && output.text.trim() ? output.text : null
}

export function conversationFinalOutput(
  value: unknown,
  conversationId: string,
  messageId: string,
  observed: {
    native?: boolean
    nativeTerminal?: boolean
    text?: string
    fileIds?: Iterable<string>
    messageIds?: Iterable<string>
  } = {},
): { text: string; fileIds: string[] } | { error: string } | null {
  if (
    !object(value) ||
    value.conversation_id !== conversationId ||
    !object(value.mapping) ||
    (!observed.native && typeof value.current_node !== 'string') ||
    Object.keys(value.mapping).length > MAX_RECOVERY_NODES
  )
    return null
  const mapping = value.mapping
  if (observed.native) {
    // Validate all terminal branches against exact ancestry and observed identities;
    // selecting a visible branch must never decide a native request's result.
    const snapshot = {
      ...observed,
      native: false,
      nativeTerminal: true,
      fileIds: [...(observed.fileIds ?? [])],
      messageIds: [...(observed.messageIds ?? [])],
    }
    const candidates = Object.entries(mapping)
      .filter(
        ([id, node]) =>
          object(node) &&
          node.id === id &&
          object(node.message) &&
          isVisibleAssistantOutput(node.message) &&
          node.message.end_turn === true,
      )
      .map(([id]) =>
        conversationFinalOutput(
          { ...value, current_node: id },
          conversationId,
          messageId,
          snapshot,
        ),
      )
      .filter((output) => output !== null)
    return candidates.length === 1 ? candidates[0]! : null
  }
  if (typeof value.current_node !== 'string' || !Object.hasOwn(mapping, value.current_node))
    return null
  const final = mapping[value.current_node]
  if (!object(final) || final.id !== value.current_node || !object(final.message)) return null
  const message = final.message
  if (message.id !== final.id || !isVisibleAssistantOutput(message) || message.end_turn !== true)
    return null
  const visited = new Set<string>([value.current_node])
  const segment: ObjectValue[] = [message]
  let matchedUser = false
  let parent = final.parent
  while (parent !== null) {
    if (
      typeof parent !== 'string' ||
      visited.size >= MAX_RECOVERY_NODES ||
      visited.has(parent) ||
      !Object.hasOwn(mapping, parent)
    )
      return null
    visited.add(parent)
    const node = mapping[parent]
    if (!object(node) || node.id !== parent) return null
    if (node.message !== null) {
      if (!object(node.message) || !object(node.message.author) || node.message.id !== node.id)
        return null
      if (node.message.author.role === 'user') {
        if (!matchedUser) {
          if (node.message.id !== messageId) return null
          matchedUser = true
        }
      } else {
        if (!['assistant', 'tool', 'system'].includes(String(node.message.author.role))) return null
        if (!matchedUser) segment.push(node.message)
      }
    }
    parent = node.parent
  }
  if (!matchedUser) return null
  const nodes = new Set(
    segment
      .filter((m) => isVisibleAssistantOutput(m) || classifyGeneratedImageMessage(m))
      .map((m) => m.id as string),
  )
  if ([...(observed.messageIds ?? [])].some((id) => !nodes.has(id))) return null
  let invalid = false
  let pending = false
  const texts: string[] = [],
    fileIds = new Set<string>()
  for (const m of segment.reverse()) {
    const task = classifyGeneratedImageMessage(m)
    if (task) {
      if (task.error === 'image_generation_failed') {
        if (observed.nativeTerminal) continue
        return { error: task.error }
      }
      if (m.status !== 'finished_successfully') {
        pending = true
        continue
      }
      if (task.error) {
        invalid = true
        continue
      }
      if (!task.complete) {
        pending = true
        continue
      }
      for (const id of task.fileIds) fileIds.add(id)
      if (fileIds.size > MAX_GENERATED_IMAGES) invalid = true
    } else if (isVisibleAssistantOutput(m)) {
      if (m.status === 'failed' || m.status === 'cancelled')
        return {
          error:
            m.status === 'cancelled' ? 'chatgpt_generation_cancelled' : 'chatgpt_generation_failed',
        }
      if (m.status !== 'finished_successfully') {
        pending = true
        continue
      }
      if (
        !object(m.content) ||
        m.content.content_type !== 'text' ||
        !Array.isArray(m.content.parts) ||
        !m.content.parts.every((part) => typeof part === 'string')
      ) {
        invalid = true
        continue
      }
      const text = m.content.parts.join('')
      if (text.length) texts.push(text)
    }
  }
  if (pending) return null
  const text = texts.join('\n\n')
  if (
    !text.startsWith(observed.text ?? '') ||
    [...(observed.fileIds ?? [])].some((id) => !fileIds.has(id))
  )
    return null
  if (text.length > 5_000_000) invalid = true
  if (invalid) return { error: 'response_recovery_failed' }
  if (!text.trim() && !fileIds.size) return null
  return { text, fileIds: [...fileIds] }
}

export async function readConversationGraph(
  response: Response,
  maxBytes = MAX_RECOVERY_BYTES,
  lifecycle: { awaitCancellation?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  lifecycle.signal?.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let text = '',
    bytes = 0
  try {
    if (
      lifecycle.signal?.aborted ||
      !response.ok ||
      !response.headers.get('content-type')?.includes('application/json') ||
      Number(response.headers.get('content-length')) > maxBytes
    )
      return null
    for (;;) {
      const chunk = await reader.read()
      if (lifecycle.signal?.aborted) return null
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) return null
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text)
  } catch {
    return null
  } finally {
    lifecycle.signal?.removeEventListener('abort', cancel)
    const cancelling = reader.cancel().catch(() => {})
    if (lifecycle.awaitCancellation !== false) await cancelling
    reader.releaseLock()
  }
}
