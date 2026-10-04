import type { BrowserFile } from './attachment-protocol'
import { DomError, findEditor, findSendButton, isVisible } from './chatgpt-dom'
export function assertNoManualAttachments(editor: HTMLElement) {
  const form = editor.closest('form')
  if (form?.querySelector('[aria-label^="Remove"], [data-attachment-name]'))
    throw new DomError(
      'attachment_draft_present',
      'Manual attachments are present; refusing to send or discard them.',
    )
}
export async function attachFiles(
  doc: Document,
  files: BrowserFile[],
  assertConversation: () => void,
) {
  const editor = findEditor(doc)
  const form = editor.closest('form')
  const win = doc.defaultView
  if (!form || !win)
    throw new DomError(
      'attachment_input_unavailable',
      'The active ChatGPT attachment form was not found.',
    )
  assertNoManualAttachments(editor)
  const input = form.querySelector<HTMLInputElement>(
    'input[type="file"][aria-label="Attach files"], input[type="file"]:not([accept])',
  )
  if (!input)
    throw new DomError(
      'attachment_input_unavailable',
      'The active ChatGPT file input was not found.',
    )
  const globals = win as Window & typeof globalThis
  const transfer = new globals.DataTransfer()
  for (const file of files) {
    const binary = globals.atob(file.base64)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    transfer.items.add(new globals.File([bytes], file.name, { type: file.mime }))
  }
  assertConversation()
  input.files = transfer.files
  input.dispatchEvent(new globals.Event('change', { bubbles: true }))
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    assertConversation()
    if (!form.isConnected || findEditor(doc) !== editor)
      throw new DomError('conversation_changed', 'Attachment form changed while uploading.')
    const alert = [...form.querySelectorAll<HTMLElement>('[role="alert"]')].find(isVisible)
    if (alert?.textContent?.trim())
      throw new DomError('attachment_upload_failed', alert.textContent.trim())
    const namesPresent = files.every((file) =>
      [...form.querySelectorAll<HTMLElement>('[aria-label]')].some(
        (node) => isVisible(node) && node.getAttribute('aria-label') === `Remove ${file.name}`,
      ),
    )
    const uploading = [...form.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(
      isVisible,
    )
    if (namesPresent && !uploading && !findSendButton(doc)?.disabled) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new DomError(
    'attachment_upload_timeout',
    'File upload was not confirmed. The message was not sent; inspect the draft before retrying.',
  )
}
