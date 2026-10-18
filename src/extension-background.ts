import { MaintenanceGrantSchema, MaintenanceValidationSchema } from './browser-maintenance'
import { startMaintenance, requestMaintenance } from './extension-maintenance'
import { handleBridgeMessage, authorizedSender } from './extension-handler'
import { ExtensionRequestSchema } from './extension-protocol'
declare const __BRIDGE_TOKEN__: string
// Optional guards keep old test/embedded runtimes compatible; Chrome MV3 provides both APIs.
const validateMaintenance =
  chrome.alarms && chrome.storage ? startMaintenance(__BRIDGE_TOKEN__) : null
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
    if (request.data.path === 'maintenance-check') {
      if (!validateMaintenance || !sender.documentId)
        return sendResponse({ ok: false, error: 'Maintenance unavailable' })
      const data = await validateMaintenance(
        {
          tabId: sender.tab!.id!,
          documentId: sender.documentId,
          browserId: `${sender.tab!.id}:${request.data.browserId}`,
        },
        request.data.data.lease,
      )
      return sendResponse({ ok: true, data })
    }
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
      // Transfer the update drain into a document-bound maintenance transaction. Ordinary
      // holder/new-lane polls must not revoke exclusion while the page commit reply is in flight.
      if (!sender.documentId)
        return sendResponse({ ok: false, error: 'Current document identity required' })
      const target = { tabId: sender.tab!.id!, documentId: sender.documentId, browserId: key }
      const transaction = await requestMaintenance(__BRIDGE_TOKEN__, { action: 'acquire', target })
      if (
        !MaintenanceGrantSchema.safeParse(transaction).success ||
        transaction.expiresAt - Date.now() < 1000
      )
        return sendResponse({ ok: false, error: 'Browser is no longer idle' })
      const committed = await requestMaintenance(__BRIDGE_TOKEN__, {
        action: 'validate',
        target,
        lease: transaction.lease,
      })
      if (
        !MaintenanceValidationSchema.safeParse(committed).success ||
        committed.expiresAt - Date.now() < 1000
      )
        return sendResponse({ ok: false, error: 'Maintenance transaction expired' })
      reloadLeases.delete(key)
      sendResponse({ ok: true, data: { reloading: true, expiresAt: committed.expiresAt } })
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
      (request.data.path === 'poll' || request.data.path === 'poll-v2') &&
      response.data &&
      typeof response.data === 'object' &&
      'request' in response.data &&
      response.data.request === null
    ) {
      const version = await diskVersion()
      if (version) Object.assign(response.data, { update: { version } })
    }
    sendResponse(response)
  })().catch(() => sendResponse({ ok: false, error: 'Extension operation failed' }))
  return true
})
