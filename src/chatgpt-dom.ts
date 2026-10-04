export class DomError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DomError'
  }
}
export function isVisible(node: Element) {
  const win = node.ownerDocument.defaultView
  for (let parent: Element | null = node; parent; parent = parent.parentElement) {
    if (parent.hasAttribute('hidden') || parent.getAttribute('aria-hidden') === 'true') return false
    const style = win?.getComputedStyle(parent)
    if (style?.display === 'none' || style?.visibility === 'hidden') return false
  }
  return (
    node.ownerDocument.documentElement.clientWidth === 0 ||
    [...node.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)
  )
}
export function findEditor(doc: Document): HTMLElement | HTMLTextAreaElement {
  const editor = [
    ...doc.querySelectorAll<HTMLElement>(
      'textarea#prompt-textarea, #prompt-textarea[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea',
    ),
  ].find(isVisible)
  if (!editor) throw new DomError('editor_not_found', 'ChatGPT input editor was not found.')
  return editor
}
export function userNodes(doc: Document) {
  return [
    ...doc.querySelectorAll<HTMLElement>(
      '[data-message-author-role="user"], [data-user-message-bubble]',
    ),
  ].filter(isVisible)
}
export function userTurn(doc: Document, id: string) {
  return (
    userNodes(doc).find(
      (node) =>
        node.getAttribute('data-message-id') === id ||
        (
          node
            .closest('[data-chatgpt-search-message-ids]')
            ?.getAttribute('data-chatgpt-search-message-ids') ?? ''
        )
          .split(/\s+/)
          .includes(id),
    ) ?? null
  )
}
export function writeEditor(doc: Document, text: string, editor = findEditor(doc)) {
  if (!editor.isConnected || editor.ownerDocument !== doc)
    throw new DomError('conversation_changed', 'The message editor changed.')
  const win = doc.defaultView
  if (!win) throw new DomError('editor_not_found', 'Editor window is unavailable.')
  const existing =
    editor instanceof win.HTMLTextAreaElement ? editor.value : editor.textContent || ''
  if (existing.trim())
    throw new DomError(
      'composer_not_empty',
      'An unsent draft is present; the bridge will not overwrite it.',
    )
  editor.focus()
  if (editor instanceof win.HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) throw new DomError('editor_unavailable', 'Textarea setter is unavailable.')
    setter.call(editor, text)
    editor.dispatchEvent(new win.Event('input', { bubbles: true }))
  } else {
    // Native editing updates editor frameworks (including contenteditable editors).
    const selection = win.getSelection()
    const range = doc.createRange()
    range.selectNodeContents(editor)
    selection?.removeAllRanges()
    selection?.addRange(range)
    const inserted =
      typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, text)
    if (!inserted) {
      editor.textContent = text
      editor.dispatchEvent(
        new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
      )
    }
  }
}
export function findSendButton(doc: Document): HTMLButtonElement | null {
  return (
    [
      ...doc.querySelectorAll<HTMLButtonElement>(
        'button[data-testid="send-button"], button[aria-label="Send"], button[aria-label="Send prompt"], button[aria-label="送信"], button[aria-label="メッセージを送信する"]',
      ),
    ].find(isVisible) ?? null
  )
}
export function isGenerating(doc: Document) {
  return [
    ...doc.querySelectorAll(
      'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="生成を停止する"], button[aria-label="停止"]',
    ),
  ].some(isVisible)
}
export function assistantNodes(doc: Document) {
  return [
    ...doc.querySelectorAll<HTMLElement>(
      '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]',
    ),
  ]
    .filter(isVisible)
    .map((node) => node.closest<HTMLElement>('[data-chatgpt-selection-message-id]') ?? node)
}
export function readLatestAnswer(doc: Document): string {
  const node = assistantNodes(doc).at(-1)
  if (!node) return ''
  const content =
    node.querySelector<HTMLElement>(
      '.markdown, .prose, [data-markdown-text-style="assistant-message"]',
    ) || node
  return content.innerText ?? content.textContent ?? ''
}
export function findNewChatButton(doc: Document): HTMLElement | null {
  const explicit = doc.querySelector<HTMLElement>(
    '[data-testid="create-new-chat-button"], button[aria-label="New chat"], a[aria-label="New chat"], button[aria-label="新しいチャット"]',
  )
  return (
    (explicit && isVisible(explicit)
      ? explicit
      : [
          ...doc.querySelectorAll<HTMLElement>(
            '[data-testid="create-new-chat-button"], button[aria-label="New chat"], a[aria-label="New chat"], button[aria-label="新しいチャット"]',
          ),
        ].find(isVisible)) ||
    [...doc.querySelectorAll<HTMLElement>('button, a')]
      .filter(isVisible)
      .find((node) => ['New chat', '新しいチャット'].includes(node.textContent?.trim() || '')) ||
    null
  )
}

export function findModelSelector(doc: Document) {
  return (
    [
      ...doc.querySelectorAll<HTMLElement>(
        '[data-testid="model-switcher-dropdown-button"], button[aria-label="Select ChatGPT model"], button[aria-label="Model selector"], button[aria-label="モデルを選択"]',
      ),
    ].find(isVisible) ?? null
  )
}
// Read controls only. UI effort/mode labels are not model identifiers.
export function readModels(doc: Document) {
  const visible = (node: HTMLElement) => {
    for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.hidden || ancestor.getAttribute('aria-hidden') === 'true') return false
      const style = doc.defaultView?.getComputedStyle(ancestor)
      if (style?.display === 'none' || style?.visibility === 'hidden') return false
    }
    return true
  }
  const label = (node: HTMLElement) => {
    const clone = node.cloneNode(true) as HTMLElement
    clone.querySelectorAll('[aria-hidden="true"], [hidden]').forEach((child) => child.remove())
    return (
      (
        node.getAttribute('data-model-name') ||
        node.innerText ||
        clone.innerText ||
        clone.textContent ||
        ''
      )
        .replace(/^ChatGPT\s*/i, '')
        .trim()
        .split('\n')[0]
        ?.trim()
        .slice(0, 200) || ''
    )
  }
  const selector = findModelSelector(doc)
  const selectionLabel = selector && visible(selector) ? label(selector) || null : null
  const menus = [
    ...doc.querySelectorAll<HTMLElement>(
      '[role="menu"], [role="listbox"], [data-testid="model-switcher-menu"]',
    ),
  ].filter(
    (menu) =>
      ['Select ChatGPT model', 'Models', 'モデル'].includes(
        menu.getAttribute('aria-label') || '',
      ) ||
      menu.getAttribute('data-testid') === 'model-switcher-menu' ||
      (!!selector?.id &&
        (menu.getAttribute('aria-labelledby') || '').split(' ').includes(selector.id)),
  )
  const options = menus
    .flatMap((menu) => [
      ...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="option"]'),
    ])
    .filter(visible)
  const checked = options.find(
    (node) =>
      node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true',
  )
  const selected = checked
    ? label(checked) || null
    : selector?.getAttribute('aria-label') === 'Select ChatGPT model'
      ? null
      : selectionLabel
  return {
    selected,
    selectionLabel,
    models: [
      ...new Set([...(selected ? [selected] : []), ...options.map(label).filter(Boolean)]),
    ].slice(0, 100),
    source: 'visible_ui' as const,
  }
}
export async function inspectModels(doc: Document) {
  const selector = findModelSelector(doc)
  const wasOpen = selector?.getAttribute('aria-expanded') === 'true'
  const shouldOpen = !!selector && !wasOpen
  const before = readModels(doc).selectionLabel
  if (shouldOpen) {
    // Radix model menus open on pointerdown, rather than a synthetic click alone.
    const win = doc.defaultView
    if (win && typeof win.PointerEvent === 'function') {
      selector.dispatchEvent(
        new win.PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
          isPrimary: true,
        }),
      )
      selector.dispatchEvent(
        new win.PointerEvent('pointerup', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
          isPrimary: true,
        }),
      )
    } else selector.click()
  }
  try {
    if (shouldOpen) {
      const deadline = Date.now() + 1500
      while (Date.now() < deadline && readModels(doc).models.length === 0)
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return { ...readModels(doc), selectionLabel: before }
  } finally {
    if (shouldOpen) {
      const win = doc.defaultView
      if (win)
        doc.dispatchEvent(
          new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
        )
    }
  }
}
export function isWorkMode(doc: Document) {
  return [...doc.querySelectorAll('button')].some(
    (node) => node.textContent?.trim() === 'Work' && node.getAttribute('aria-pressed') === 'true',
  )
}
