import { installPageObserver } from './page-observer'
declare const unsafeWindow: Window & typeof globalThis
import { installNativeChat } from './native-chat'
const native = installNativeChat(unsafeWindow)
installPageObserver(unsafeWindow, native)
import { startBrowserApp } from './browser-app'
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', () => startBrowserApp(), { once: true })
else startBrowserApp()
