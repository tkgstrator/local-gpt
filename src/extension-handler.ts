import { ExtensionRequestSchema, type ExtensionResponse } from './extension-protocol'
export interface Sender {
  id?: string
  url?: string
  tab?: { id?: number }
  frameId?: number
}
export function authorizedSender(sender: Sender, extensionId: string): boolean {
  try {
    return (
      sender.id === extensionId &&
      new URL(sender.url || '').origin === 'https://chatgpt.com' &&
      sender.tab?.id !== undefined &&
      sender.frameId === 0
    )
  } catch {
    return false
  }
}
export async function handleBridgeMessage(
  value: unknown,
  sender: Sender,
  config: { extensionId: string; token: string },
  fetchRequest: typeof fetch = fetch,
): Promise<ExtensionResponse> {
  if (!authorizedSender(sender, config.extensionId))
    return { ok: false, error: 'Unauthorized content script' }
  const request = ExtensionRequestSchema.safeParse(value)
  if (!request.success) return { ok: false, error: 'Invalid bridge request' }
  if (!config.token)
    return {
      ok: false,
      error:
        'LocalGPT pairing is missing. Install from the local dashboard or configure the extension updater.',
    }
  if (request.data.path === 'reload')
    return { ok: false, error: 'Reload must be authorized by the extension' }
  try {
    const response = await fetchRequest(`http://127.0.0.1:8766/bridge/${request.data.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': config.token,
        'X-Browser-Id': `${sender.tab!.id}:${request.data.browserId}`,
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
