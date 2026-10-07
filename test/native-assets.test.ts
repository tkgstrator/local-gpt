import { expect, test } from 'bun:test'
import { observeNativeAssets } from '../src/native-assets'
test('boot resource observer preserves only bounded observed same-origin script URLs after timings clear', () => {
  let receive: any,
    cleanup: any,
    disconnected = 0
  class Observer {
    constructor(callback: any) {
      receive = callback
    }
    observe(options: any) {
      expect(options).toEqual({ type: 'resource', buffered: true })
    }
    disconnect() {
      disconnected++
    }
  }
  const page: any = {
    location: { origin: 'https://chatgpt.com' },
    document: { querySelectorAll: () => [] },
    performance: { getEntriesByType: () => [] },
    PerformanceObserver: Observer,
    addEventListener: (name: string, callback: any) => {
      if (name === 'pagehide') cleanup = callback
    },
  }
  const assets = observeNativeAssets(page)
  receive({
    getEntries: () => [
      { name: 'https://chatgpt.com/cdn/assets/runtime.hash.js' },
      { name: 'https://evil.example/cdn/assets/runtime.js' },
      { name: 'https://chatgpt.com/backend-api/conversation/id' },
      { name: 'https://chatgpt.com/cdn/assets/runtime.js?token=ignored' },
    ],
  })
  expect([...assets]).toEqual(['https://chatgpt.com/cdn/assets/runtime.hash.js'])
  expect(observeNativeAssets(page)).toBe(assets)
  receive({
    getEntries: () =>
      Array.from({ length: 1030 }, (_, i) => ({
        name: `https://chatgpt.com/cdn/assets/chunk${i}.js`,
      })),
  })
  expect(assets.size).toBe(1024)
  expect(assets.has('https://chatgpt.com/cdn/assets/runtime.hash.js')).toBe(true)
  cleanup()
  expect(disconnected).toBe(1)
})
test('restoring a cached page resumes asset observation without replacing captured URLs', () => {
  const listeners: Record<string, Function> = {}
  let receive: any,
    connected = false,
    observeCount = 0
  class Observer {
    constructor(callback: any) {
      receive = callback
    }
    observe() {
      connected = true
      observeCount++
    }
    disconnect() {
      connected = false
    }
  }
  const page: any = {
    location: { origin: 'https://chatgpt.com' },
    document: { querySelectorAll: () => [] },
    performance: { getEntriesByType: () => [] },
    PerformanceObserver: Observer,
    addEventListener: (name: string, callback: Function) => {
      listeners[name] = callback
    },
  }
  const assets = observeNativeAssets(page)
  receive({ getEntries: () => [{ name: 'https://chatgpt.com/cdn/assets/initial.js' }] })
  listeners.pagehide!()
  expect(connected).toBe(false)
  listeners.pageshow?.({ persisted: true })
  expect(connected).toBe(true)
  expect(observeCount).toBe(2)
  receive({ getEntries: () => [{ name: 'https://chatgpt.com/cdn/assets/restored.js' }] })
  expect(observeNativeAssets(page)).toBe(assets)
  expect([...assets]).toEqual([
    'https://chatgpt.com/cdn/assets/initial.js',
    'https://chatgpt.com/cdn/assets/restored.js',
  ])
  listeners.pagehide!()
  expect(connected).toBe(false)
})
