import { handleBridgeMessage } from './extension-handler'
declare const __BRIDGE_TOKEN__: string
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void handleBridgeMessage(message, sender, {
    extensionId: chrome.runtime.id,
    token: __BRIDGE_TOKEN__,
  }).then(sendResponse)
  return true
})
