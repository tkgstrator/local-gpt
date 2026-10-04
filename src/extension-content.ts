import { startBrowserApp } from './browser-app'
import { ExtensionRequestSchema, ExtensionResponseSchema } from './extension-protocol'
startBrowserApp(async (path, data, browserId) => {
  const request = ExtensionRequestSchema.parse({ type: 'bridge_request', path, data, browserId })
  const response = ExtensionResponseSchema.parse(
    (await chrome.runtime.sendMessage(request)) as unknown,
  )
  if (!response.ok) throw new Error(response.error)
  return response.data
})
