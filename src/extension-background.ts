import { handleBridgeMessage } from './extension-handler'
import { ExtensionRequestSchema } from './extension-protocol'
import { BrowserRequestSchema } from './protocol'
declare const __BRIDGE_TOKEN__: string
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void handleBridgeMessage(message, sender, {
    extensionId: chrome.runtime.id,
    token: __BRIDGE_TOKEN__,
  }).then(async (response) => {
    const request = ExtensionRequestSchema.safeParse(message)
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
  })
  return true
})
