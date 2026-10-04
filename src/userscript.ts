import { installPageObserver } from './page-observer'
declare const unsafeWindow: Window & typeof globalThis
installPageObserver(unsafeWindow)
import { startBrowserApp } from './browser-app'
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', () => startBrowserApp(), { once: true })
else startBrowserApp()
