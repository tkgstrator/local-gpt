import { ExtensionRequestSchema, type ExtensionResponse } from './extension-protocol'
interface Sender {
  id?: string
  url?: string
  tab?: { id?: number }
  frameId?: number
}
export async function handleBridgeMessage(
  value: unknown,
  sender: Sender,
  config: { extensionId: string; token: string },
  fetchRequest: typeof fetch = fetch,
): Promise<ExtensionResponse> {
  let origin: string
  try {
    origin = new URL(sender.url || '').origin
  } catch {
    return { ok: false, error: 'Unauthorized content script' }
  }
  if (
    sender.id !== config.extensionId ||
    origin !== 'https://chatgpt.com' ||
    sender.tab?.id === undefined ||
    sender.frameId !== 0
  )
    return { ok: false, error: 'Unauthorized content script' }
  const request = ExtensionRequestSchema.safeParse(value)
  if (!request.success) return { ok: false, error: 'Invalid bridge request' }
  try {
    const response = await fetchRequest(`http://127.0.0.1:8766/bridge/${request.data.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': config.token,
        'X-Browser-Id': `${sender.tab.id}:${request.data.browserId}`,
      },
      body: JSON.stringify(request.data.data),
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok)
      return {
        ok: false,
        error: `Local bridge returned ${response.status}. Check the server and pairing key.`,
      }
    return { ok: true, data: (await response.json()) as unknown }
  } catch {
    return { ok: false, error: 'Cannot connect to the local server on port 8766.' }
  }
}
