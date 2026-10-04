import { DomError, findModelSelector } from './chatgpt-dom'
import type { Capabilities } from './capabilities'
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function menuFor(doc: Document, selector: HTMLElement) {
  return [...doc.querySelectorAll<HTMLElement>('[role="menu"]')].find(
    (menu) =>
      (menu.getAttribute('aria-labelledby') ?? '').split(' ').includes(selector.id) ||
      menu.getAttribute('aria-label') === 'Select ChatGPT model',
  )
}
async function openMenu(doc: Document) {
  const selector = findModelSelector(doc)
  const win = doc.defaultView
  if (!selector || !win)
    throw new DomError('model_selector_unavailable', 'Model selector is unavailable.')
  if (selector.getAttribute('aria-expanded') !== 'true') selector.click()
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const menu = menuFor(doc, selector)
    if (menu && selector.getAttribute('aria-expanded') === 'true') return { selector, menu, win }
    await wait(50)
  }
  throw new DomError('model_selector_unavailable', 'Model menu did not open.')
}
function closeMenu(selector: HTMLElement, menu: HTMLElement, win: Window) {
  menu.dispatchEvent(
    new (win as Window & typeof globalThis).KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
    }),
  )
  if (selector.getAttribute('aria-expanded') === 'true') selector.click()
}
export async function selectModel(
  doc: Document,
  capabilities: Capabilities,
  model: string,
  effort?: string,
) {
  const choices = capabilities.choices.filter(
    (choice) => choice.model === model && (effort === undefined || choice.effort === effort),
  )
  const target = choices.find((choice) => choice.effort === 'standard') ?? choices[0]
  if (!target)
    throw new DomError(
      'model_unavailable',
      'Requested model/effort was not observed as an available ChatGPT preset.',
    )
  let controls = await openMenu(doc)
  try {
    const toggle = controls.menu.querySelector<HTMLElement>('[data-model-picker-view-toggle]')
    if (!toggle)
      throw new DomError('model_selector_unavailable', 'Version selector is unavailable.')
    toggle.click()
    await wait(100)
    const version = [...controls.menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (node) =>
        (node.innerText ?? node.textContent ?? '').trim().split('\n')[0] === target.versionLabel,
    )
    if (
      !version ||
      version.hasAttribute('data-disabled') ||
      version.getAttribute('aria-disabled') === 'true'
    )
      throw new DomError('model_unavailable', 'Requested model version is unavailable.')
    version.click()
    await wait(150)
    if (version.getAttribute('aria-checked') !== 'true')
      throw new DomError('model_selection_failed', 'Model version selection was not confirmed.')
    closeMenu(controls.selector, controls.menu, controls.win)
    await wait(100)
    controls = await openMenu(doc)
    const power = controls.menu.querySelector<HTMLElement>(
      '[data-reasoning-slider][role="menuitem"]',
    )
    const slider = controls.menu.querySelector<HTMLElement>('[role="slider"]')
    if (
      !power ||
      !slider ||
      power.hasAttribute('data-disabled') ||
      power.getAttribute('aria-disabled') === 'true' ||
      Number(slider.getAttribute('aria-valuemax')) !== target.count - 1
    )
      throw new DomError(
        'reasoning_selector_unavailable',
        'Reasoning control does not match the observed presets.',
      )
    power.focus()
    for (let step = 0; step < 30; step++) {
      const current = Number(slider.getAttribute('aria-valuenow'))
      if (!Number.isFinite(current))
        throw new DomError('model_selection_failed', 'Unable to read reasoning selection.')
      if (current === target.index) break
      const key = current < target.index ? 'ArrowRight' : 'ArrowLeft'
      power.dispatchEvent(
        new controls.win.KeyboardEvent('keydown', { key, code: key, bubbles: true }),
      )
      await wait(100)
      if (Number(slider.getAttribute('aria-valuenow')) === current)
        throw new DomError('model_selection_failed', 'Reasoning selection did not change.')
    }
    const label = controls.menu.querySelector<HTMLElement>('[role="status"]')?.textContent ?? ''
    if (
      Number(slider.getAttribute('aria-valuenow')) !== target.index ||
      !label.startsWith(target.title + ',')
    )
      throw new DomError('model_selection_failed', 'Requested reasoning preset was not confirmed.')
    return target
  } finally {
    closeMenu(controls.selector, controls.menu, controls.win)
  }
}
