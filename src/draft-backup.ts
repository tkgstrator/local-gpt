import { DomError, findEditor, writeEditor, readPlainDraft } from './chatgpt-dom'
export { readPlainDraft } from './chatgpt-dom'
import { assertNoManualAttachments } from './browser-files'
import { parseChatRoute } from './projects'

export const DRAFT_KEY = 'localgpt:draft-backups:v1'
const LIMIT = 65536
type SavedDraft = { route: string; text: string }
const validRoute = (route: string) => route === '/' || Boolean(parseChatRoute(route))

function clearEditor(editor: HTMLElement, expected: string) {
  const doc = editor.ownerDocument,
    win = doc.defaultView!
  editor.focus()
  if (!editor.isConnected || findEditor(doc) !== editor || readPlainDraft(editor) !== expected)
    throw new DomError(
      'draft_clear_failed',
      'The draft changed after saving; the newer composer is protected.',
    )
  if (editor instanceof win.HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set?.call(
      editor,
      '',
    )
    editor.dispatchEvent(new win.Event('input', { bubbles: true }))
  } else {
    const selection = win.getSelection(),
      range = doc.createRange()
    range.selectNodeContents(editor)
    selection?.removeAllRanges()
    selection?.addRange(range)
    if (!doc.execCommand?.('delete', false))
      throw new DomError('draft_clear_failed', 'The draft is saved, but native clearing failed.')
  }
  if (readPlainDraft(editor) !== '')
    throw new DomError('draft_clear_failed', 'The draft is saved, but the editor did not clear.')
}

export class DraftBackups {
  constructor(private storage: () => Storage) {}
  list(): SavedDraft[] {
    try {
      const raw = this.storage().getItem(DRAFT_KEY)
      if (raw === null) return []
      const data: unknown = JSON.parse(raw)
      if (
        !Array.isArray(data) ||
        data.length > 8 ||
        !data.every(
          (d) =>
            d &&
            typeof d.route === 'string' &&
            validRoute(d.route) &&
            typeof d.text === 'string' &&
            d.text.length > 0 &&
            new TextEncoder().encode(d.text).length <= LIMIT,
        )
      )
        throw new Error('Invalid backup')
      return data.map((d) => ({ route: d.route, text: d.text }))
    } catch {
      throw new DomError(
        'draft_storage_unavailable',
        'Draft storage is unavailable; the composer is protected.',
      )
    }
  }
  private save(records: SavedDraft[]) {
    try {
      const value = JSON.stringify(records),
        storage = this.storage()
      storage.setItem(DRAFT_KEY, value)
      if (storage.getItem(DRAFT_KEY) !== value) throw new Error('Unconfirmed backup')
    } catch {
      throw new DomError(
        'draft_storage_unavailable',
        'The draft could not be saved; the composer is protected.',
      )
    }
  }
  suspend(doc: Document, route: string) {
    const editor = findEditor(doc)
    assertNoManualAttachments(editor)
    const text = readPlainDraft(editor)
    if (text === '') return
    if (!validRoute(route))
      throw new DomError('draft_unsupported', 'This draft route is unsupported.')
    if (new TextEncoder().encode(text).length > LIMIT)
      throw new DomError('draft_too_large', 'The draft is too large to safely suspend.')
    const records = this.list(),
      existing = records.find((d) => d.route === route)
    if (existing && existing.text !== text)
      throw new DomError(
        'draft_backup_conflict',
        'A different saved draft is pending; recover it first.',
      )
    if (!existing) {
      if (records.length >= 8)
        throw new DomError('draft_backup_conflict', 'Recover a saved draft before continuing.')
      this.save([...records, { route, text }])
    }
    // Storage is verified before any editor mutation. A failed clear retains the backup.
    clearEditor(editor, text)
    if (doc.defaultView!.location.pathname !== route)
      throw new DomError(
        'draft_clear_failed',
        'The conversation changed while saving; the backup is retained.',
      )
  }
  restore(doc: Document, route: string): boolean {
    const records = this.list(),
      draft = records.find((d) => d.route === route)
    if (!draft) return false
    const editor = findEditor(doc)
    assertNoManualAttachments(editor)
    const current = readPlainDraft(editor)
    if (current === draft.text) {
      this.save(records.filter((d) => d !== draft))
      return true
    }
    if (current !== '') return false
    editor.focus()
    if (!editor.isConnected || findEditor(doc) !== editor || readPlainDraft(editor) !== '')
      return false
    writeEditor(doc, draft.text, editor)
    if (
      doc.defaultView!.location.pathname !== route ||
      readPlainDraft(findEditor(doc)) !== draft.text
    )
      throw new DomError(
        'draft_restore_failed',
        'Native restoration was not confirmed; the saved draft is retained.',
      )
    this.save(records.filter((d) => d !== draft))
    return true
  }
}
