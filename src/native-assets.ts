type NativeAssetPage = Pick<Window, 'document' | 'performance' | 'location'> & {
  PerformanceObserver?: typeof PerformanceObserver
  MutationObserver?: typeof MutationObserver
  addEventListener?: Window['addEventListener']
}
const records = new WeakMap<object, Set<string>>()
const MAX_ASSETS = 1024
export function observeNativeAssets(page: NativeAssetPage): Set<string> {
  const previous = records.get(page)
  if (previous) return previous
  const assets = new Set<string>()
  records.set(page, assets)
  const remember = (value: string) => {
    let url: URL
    try {
      url = new URL(value, page.location.origin)
    } catch {
      return
    }
    if (
      url.origin !== page.location.origin ||
      !/^\/cdn\/assets\/[^/]+\.js$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      return
    if (assets.size < MAX_ASSETS) assets.add(url.href)
  }
  for (const script of page.document.querySelectorAll<HTMLScriptElement>('script[src]'))
    remember(script.src)
  for (const link of page.document.querySelectorAll<HTMLLinkElement>(
    'link[rel="modulepreload"][href]',
  ))
    remember(link.href)
  for (const resource of page.performance.getEntriesByType('resource')) remember(resource.name)
  let performanceObserver: PerformanceObserver | undefined
  if (page.PerformanceObserver) {
    performanceObserver = new page.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) remember(entry.name)
    })
  }
  const inspectNode = (node: Node) => {
    if (node.nodeType !== 1) return
    const element = node as Element
    if (element.matches('script[src]')) remember((element as HTMLScriptElement).src)
    if (element.matches('link[rel="modulepreload"][href]'))
      remember((element as HTMLLinkElement).href)
    for (const script of element.querySelectorAll<HTMLScriptElement>('script[src]'))
      remember(script.src)
    for (const link of element.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"][href]'))
      remember(link.href)
  }
  let mutationObserver: MutationObserver | undefined
  if (page.MutationObserver) {
    mutationObserver = new page.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') inspectNode(mutation.target)
        for (const node of mutation.addedNodes) inspectNode(node)
      }
    })
  }
  const resume = () => {
    performanceObserver?.observe({ type: 'resource', buffered: true })
    mutationObserver?.observe(page.document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'rel'],
    })
  }
  resume()
  page.addEventListener?.('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted) resume()
  })
  page.addEventListener?.('pagehide', () => {
    performanceObserver?.disconnect()
    mutationObserver?.disconnect()
  })
  return assets
}
