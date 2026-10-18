import { startBrowserApp } from './browser-app'
import { createExtensionTransport } from './extension-transport'
const app = startBrowserApp(
  createExtensionTransport((request) => chrome.runtime.sendMessage(request)),
)
chrome.runtime.onMessage?.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return
  const value = message as {
    type?: string
    browserId?: string
    lease?: string
    expiresAt?: number
    deferred?: string | null
  }
  if (value.type === 'localgpt_maintenance_safety') {
    sendResponse(app?.maintenanceSafety(value.browserId, value.deferred))
  } else if (
    value.type === 'localgpt_maintenance_reload' &&
    typeof value.lease === 'string' &&
    typeof value.expiresAt === 'number'
  ) {
    void app?.maintenanceReload(value.browserId, value.lease, value.expiresAt).then(sendResponse)
    return true
  }
})
