import { handleBridgeMessage, authorizedSender } from './extension-handler'
import { ExtensionRequestSchema } from './extension-protocol'
import { BrowserRequestSchema } from './protocol'
declare const __BRIDGE_TOKEN__: string
const reloadLeases = new Map<string, { version: string; expiresAt: number }>()
async function diskVersion(): Promise<string | null> {
  try {
    const response = await fetch(chrome.runtime.getURL('build-info.json'), {
      cache: 'no-store',
      signal: AbortSignal.timeout(1000),
    })
    if (!response.ok) return null
    const value = (await response.json()) as { version?: unknown }
    const loaded = chrome.runtime.getManifest().version
    if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || !loaded)
      return null
    const a = value.version.split('.').map(Number),
      b = loaded.split('.').map(Number)
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]! ? value.version : null
    return null
  } catch {
    return null
  }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void (async () => {
    const request = ExtensionRequestSchema.safeParse(message)
    if (!authorizedSender(sender, chrome.runtime.id))
      return sendResponse({ ok: false, error: 'Unauthorized content script' })
    if (!request.success) return sendResponse({ ok: false, error: 'Invalid bridge request' })
    const config = { extensionId: chrome.runtime.id, token: __BRIDGE_TOKEN__ }
    const key = sender.tab!.id + ':' + request.data.browserId
    if (request.data.path === 'reload') {
      const lease = reloadLeases.get(key)
      if (
        !lease ||
        lease.version !== request.data.data.version ||
        lease.expiresAt <= Date.now() ||
        (await diskVersion()) !== lease.version
      )
        return sendResponse({ ok: false, error: 'No current update lease' })
      // Recheck the server immediately before reload, even if a poll consumed the original lease.
      const renewed = await handleBridgeMessage(
        { ...request.data, path: 'update-ready' },
        sender,
        config,
      )
      if (!renewed.ok || !(renewed.data as { ready?: boolean })?.ready)
        return sendResponse({ ok: false, error: 'Browser is no longer idle' })
      reloadLeases.delete(key)
      sendResponse({ ok: true, data: { reloading: true } })
      setTimeout(() => chrome.runtime.reload(), 200)
      return
    }
    if (request.data.path === 'update-ready' && (await diskVersion()) !== request.data.data.version)
      return sendResponse({ ok: false, error: 'Extension files are not ready' })
    const response = await handleBridgeMessage(message, sender, config)
    if (response.ok && request.data.path === 'update-ready') {
      if ((response.data as { ready?: boolean })?.ready)
        reloadLeases.set(key, { version: request.data.data.version, expiresAt: Date.now() + 10000 })
      else reloadLeases.delete(key)
    }
    if (
      response.ok &&
      request.data.path === 'poll' &&
      response.data &&
      typeof response.data === 'object' &&
      'request' in response.data &&
      response.data.request === null
    ) {
      const version = await diskVersion()
      if (version) Object.assign(response.data, { update: { version } })
    }
    if (
      response.ok &&
      request.success &&
      request.data.path === 'poll' &&
      response.data &&
      typeof response.data === 'object' &&
      'request' in response.data &&
      BrowserRequestSchema.safeParse(response.data.request).success &&
      sender.tab?.id !== undefined
    ) {
      try {
        const tab = await chrome.tabs.update(sender.tab.id, { active: true })
        if (tab) await chrome.windows.update(tab.windowId, { focused: true })
      } catch (error) {
        // Deliver the queued job even if the window closed or focus was refused.
        console.warn('[LocalGPT] Could not activate ChatGPT tab', error)
      }
    }
    sendResponse(response)
  })().catch(() => sendResponse({ ok: false, error: 'Extension operation failed' }))
  return true
})
