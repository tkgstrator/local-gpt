import { z } from 'zod'
import { DomError, findModelSelector } from './chatgpt-dom'
import { ModelChoiceSchema, type Capabilities } from './capabilities'
const REQUEST = 'localgpt:model-select'
const RESULT = 'localgpt:model-selected'
const Command = z.object({ id: z.string().uuid(), choice: ModelChoiceSchema })
const Receipt = z.object({ id: z.string().uuid(), code: z.string().optional() })
const Selection = z.object({
  slug: z.string(),
  thinkingEffort: z.string().nullable(),
  versionId: z.string(),
})
const NativeModels = z.object({
  versionOptions: z.array(
    z.object({
      id: z.string(),
      slugs: z.array(z.string()),
      modelSlugByLane: z.record(z.string(), z.string()).optional(),
      options: z.array(
        z.object({
          slug: z.string(),
          lane: z.string().optional(),
          thinkingEffort: z.string().nullable().optional(),
          isAvailable: z.boolean(),
        }),
      ),
    }),
  ),
})
type Fiber = {
  memoizedProps?: Record<string, unknown>
  return?: Fiber | null
  alternate?: Fiber | null
  stateNode?: { current?: Fiber }
}
function nativeState(doc: Document) {
  const node = findModelSelector(doc)
  if (!node || node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true')
    return null
  const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'))
  if (!key) return null
  let fiber = (node as unknown as Record<string, Fiber>)[key]
  // A host node can retain the previous render's fiber after React flips trees.
  let root = fiber
  for (let i = 0; root?.return && i < 100; i++) root = root.return
  if (root?.stateNode?.current && root.stateNode.current !== root && fiber?.alternate)
    fiber = fiber.alternate
  const seen = new Set<Fiber>()
  for (let i = 0; fiber && i < 100 && !seen.has(fiber); i++, fiber = fiber.return!) {
    seen.add(fiber)
    const props = fiber.memoizedProps
    if (
      props &&
      typeof props.onModelChange === 'function' &&
      Selection.safeParse(props.selectedModel).success &&
      NativeModels.safeParse(props.models).success
    )
      return {
        props,
        change: props.onModelChange as (selection: z.infer<typeof Selection>) => void,
      }
  }
  return null
}
// Runs in the page's MAIN world, where the actual React callback is accessible.
export function installNativeModelSelection(
  page: Pick<
    Window,
    'document' | 'location' | 'addEventListener' | 'dispatchEvent' | 'setTimeout'
  > & { CustomEvent: typeof CustomEvent },
) {
  let busy = false
  page.addEventListener(REQUEST, (event) => {
    let command: z.infer<typeof Command>
    try {
      command = Command.parse(JSON.parse((event as CustomEvent<string>).detail))
    } catch {
      return
    }
    const reply = (code?: string) =>
      page.dispatchEvent(
        new page.CustomEvent(RESULT, {
          detail: JSON.stringify({ id: command.id, ...(code ? { code } : {}) }),
        }),
      )
    if (busy) {
      reply('browser_busy')
      return
    }
    busy = true
    void (async () => {
      try {
        const route = page.location.href
        const state = nativeState(page.document)
        if (!state)
          throw new DomError(
            'native_model_selection_unavailable',
            'Native model selection callback is unavailable.',
          )
        const models = NativeModels.parse(state.props.models)
        const version = models.versionOptions.find((v) => v.id === command.choice.version)
        const allowed =
          version?.slugs.includes(command.choice.model) &&
          version.options.some(
            (o) =>
              o.isAvailable &&
              (o.slug === command.choice.model ||
                (o.lane && version.modelSlugByLane?.[o.lane] === command.choice.model)) &&
              (o.thinkingEffort ?? null) === command.choice.effort,
          )
        if (!allowed)
          throw new DomError(
            'model_unavailable',
            'Requested preset is unavailable in the native model state.',
          )
        const target = {
          slug: command.choice.model,
          thinkingEffort: command.choice.effort,
          versionId: command.choice.version,
        }
        const matches = () => {
          const current = nativeState(page.document)
          if (!current) return false
          const selected = Selection.parse(current.props.selectedModel)
          return (
            selected.slug === target.slug &&
            selected.thinkingEffort === target.thinkingEffort &&
            selected.versionId === target.versionId
          )
        }
        if (!matches()) state.change(target)
        const deadline = Date.now() + 2000
        while (!matches()) {
          if (page.location.href !== route)
            throw new DomError(
              'conversation_changed',
              'Conversation changed during model selection.',
            )
          if (Date.now() >= deadline)
            throw new DomError(
              'model_selection_failed',
              'Native model selection was not confirmed.',
            )
          await new Promise<void>((resolve) => page.setTimeout(resolve, 25))
        }
        if (page.location.href !== route)
          throw new DomError('conversation_changed', 'Conversation changed during model selection.')
        reply()
      } catch (error) {
        reply(error instanceof DomError ? error.code : 'native_model_selection_unavailable')
      } finally {
        busy = false
      }
    })()
  })
}
export async function selectModel(
  doc: Document,
  capabilities: Capabilities,
  model: string,
  effort?: string,
) {
  const choices = capabilities.choices.filter(
    (c) => c.model === model && (effort === undefined || c.effort === effort),
  )
  const target = choices.find((c) => c.effort === 'standard') ?? choices[0]
  if (!target)
    throw new DomError(
      'model_unavailable',
      'Requested model/effort was not observed as an available ChatGPT preset.',
    )
  const page = doc.defaultView
  if (!page)
    throw new DomError('native_model_selection_unavailable', 'Editor window is unavailable.')
  const id = page.crypto.randomUUID()
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      page.clearTimeout(timer)
      page.removeEventListener(RESULT, listener)
    }
    const listener = (event: Event) => {
      let receipt: z.infer<typeof Receipt>
      try {
        receipt = Receipt.parse(JSON.parse((event as CustomEvent<string>).detail))
      } catch {
        return
      }
      if (receipt.id !== id) return
      cleanup()
      if (receipt.code)
        reject(
          new DomError(
            receipt.code,
            'Native JS model selection failed; no UI fallback was attempted.',
          ),
        )
      else resolve()
    }
    const timer = page.setTimeout(() => {
      cleanup()
      reject(
        new DomError(
          'native_model_selection_unavailable',
          'Native JS model selection did not respond. Reload the LocalGPT extension and ChatGPT tab.',
        ),
      )
    }, 5000)
    page.addEventListener(RESULT, listener)
    page.dispatchEvent(
      new page.CustomEvent(REQUEST, { detail: JSON.stringify({ id, choice: target }) }),
    )
  })
  return target
}
