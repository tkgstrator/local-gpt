import { DomError, isVisible, findEditor, userNodes, assistantNodes } from './chatgpt-dom'
import { ProjectIdSchema, parseChatRoute } from './projects'
import { z } from 'zod'
export const PROJECT_ARM_EVENT = 'localgpt:project-arm'
export const PROJECT_CHECK_EVENT = 'localgpt:project-check'
export const PROJECT_EVENT = 'localgpt:conversation-project'
export const ProjectReceiptSchema = z
  .object({ conversationId: z.string().uuid(), projectId: ProjectIdSchema })
  .strict()
type Wait = <T>(check: () => T | null | false, deadline: number) => Promise<T>
const exact = (doc: ParentNode, selector: string, name: string | RegExp) => {
  const matches = [...doc.querySelectorAll<HTMLElement>(selector)].filter(
    (el) =>
      isVisible(el) &&
      (typeof name === 'string'
        ? (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() === name
        : name.test((el.getAttribute('aria-label') ?? el.textContent ?? '').trim())),
  )
  if (matches.length > 1)
    throw new DomError('project_ambiguous', 'Multiple matching project controls were found.')
  return matches[0] ?? null
}
export async function ensureProjectTarget(
  doc: Document,
  name: string,
  wait: Wait,
  deadline: number,
  assertReady = () => {},
  expectedId?: string,
) {
  const lookup = () => {
    const rows = [
      ...doc.querySelectorAll<HTMLElement>('[data-app-action-sidebar-project-id]'),
    ].filter((el) => el.getAttribute('data-app-action-sidebar-project-label') === name)
    if (rows.length > 1)
      throw new DomError('project_ambiguous', 'More than one project has the requested name.')
    const id = ProjectIdSchema.safeParse(
      rows[0]?.getAttribute('data-app-action-sidebar-project-id'),
    )
    return id.success ? id.data : null
  }
  const present = lookup()
  if (present) {
    if (expectedId && present !== expectedId)
      throw new DomError('project_mismatch', 'The selected project identity changed.')
    return present
  }
  if (expectedId) {
    const namedRows = [
      ...doc.querySelectorAll<HTMLElement>('[data-app-action-sidebar-project-id]'),
    ].filter((el) => el.getAttribute('data-app-action-sidebar-project-label') === name)
    if (namedRows.length)
      throw new DomError('project_mismatch', 'The selected project identity changed.')
    return ProjectIdSchema.parse(expectedId)
  }
  assertReady()
  const add = exact(
    doc,
    'button',
    /^(Add new project|New project|新しいプロジェクト|プロジェクトを作成)$/,
  )
  if (!add)
    throw new DomError(
      'project_control_unavailable',
      'The project is not visible and the new-project control is unavailable.',
    )
  add.click()
  const dialog = await wait(
    () =>
      [...doc.querySelectorAll<HTMLElement>('[role="dialog"]')]
        .filter(isVisible)
        .find((el) =>
          /Create project|プロジェクトを作成|新しいプロジェクト/i.test(el.textContent ?? ''),
        ) ?? null,
    deadline,
  )
  const input = dialog.querySelector<HTMLInputElement>('input')
  if (!input) throw new DomError('project_control_unavailable', 'Project name input was not found.')
  assertReady()
  const setter = Object.getOwnPropertyDescriptor(
    doc.defaultView!.HTMLInputElement.prototype,
    'value',
  )?.set
  if (!setter)
    throw new DomError('project_control_unavailable', 'Project name input cannot be filled.')
  setter.call(input, name)
  input.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }))
  input.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }))
  const create = await wait(() => {
    const el = exact(dialog, 'button', /^(Create project|プロジェクトを作成|作成)$/)
    return el && !(el as HTMLButtonElement).disabled ? el : null
  }, deadline)
  assertReady()
  create.click()
  return wait(lookup, deadline)
}
export async function openProjectChat(
  doc: Document,
  name: string,
  projectId: string,
  wait: Wait,
  deadline: number,
  assertReady: () => void,
) {
  const row = [...doc.querySelectorAll<HTMLElement>('[data-app-action-sidebar-project-id]')].find(
    (el) =>
      el.getAttribute('data-app-action-sidebar-project-id') === projectId &&
      el.getAttribute('data-app-action-sidebar-project-label') === name,
  )
  if (!row)
    throw new DomError('project_control_unavailable', 'The selected project is no longer visible.')
  assertReady()
  const button = exact(row, 'button', `New chat in ${name}`)
  if (!button)
    throw new DomError(
      'project_control_unavailable',
      'The new-chat control for this project is unavailable.',
    )
  button.click()
  await wait(() => {
    const route = parseChatRoute(doc.defaultView!.location.pathname)
    if (
      route?.projectId !== projectId ||
      route.conversationId ||
      route.provisionalId ||
      userNodes(doc).length ||
      assistantNodes(doc).length
    )
      return false
    try {
      const editor = findEditor(doc)
      const draft = 'value' in editor ? String(editor.value) : (editor.textContent ?? '')
      if (draft.trim()) throw new DomError('composer_not_empty', 'The project has an unsent draft.')
      return editor
    } catch (error) {
      if (error instanceof DomError && error.code === 'composer_not_empty') throw error
      return false
    }
  }, deadline)
}
export async function moveConversationToProject(
  doc: Document,
  cid: string,
  name: string,
  pid: string,
  assertReady: () => void,
  wait: Wait,
  deadline: number,
) {
  const page = doc.defaultView!
  const route = () => parseChatRoute(page.location.pathname)
  if (route()?.conversationId !== cid)
    throw new DomError('conversation_changed', 'The targeted conversation is not open.')
  if (route()?.projectId === pid) {
    let confirmed = false
    const receipt = (event: Event) => {
      try {
        const value = ProjectReceiptSchema.safeParse(
          JSON.parse((event as CustomEvent<string>).detail),
        )
        if (value.success && value.data.conversationId === cid && value.data.projectId === pid)
          confirmed = true
      } catch {}
    }
    page.addEventListener(PROJECT_EVENT, receipt)
    try {
      assertReady()
      page.dispatchEvent(
        new page.CustomEvent(PROJECT_CHECK_EVENT, {
          detail: JSON.stringify({ conversationId: cid, projectId: pid }),
        }),
      )
      await wait(() => {
        assertReady()
        if (route()?.conversationId !== cid)
          throw new DomError('conversation_changed', 'The target conversation changed.')
        return confirmed && route()?.projectId === pid
      }, deadline)
    } finally {
      page.removeEventListener(PROJECT_EVENT, receipt)
      page.dispatchEvent(new page.CustomEvent('localgpt:project-disarm'))
    }
    return
  }
  if ([...doc.querySelectorAll('[role="menu"], [role="dialog"]')].some(isVisible))
    throw new DomError(
      'browser_ui_busy',
      'Close the open menu or dialog before moving the conversation.',
    )
  const assertTarget = () => {
    assertReady()
    if (route()?.conversationId !== cid)
      throw new DomError(
        'conversation_changed',
        'The conversation changed during the project move.',
      )
  }
  const action = conversationActions(doc, cid)
  if (!action)
    throw new DomError(
      'project_control_unavailable',
      'The sidebar action for this conversation was not found.',
    )
  assertTarget()
  action.click()
  const move = await wait(
    () =>
      exact(
        doc,
        '[role="menu"] [role="menuitem"]',
        /^(Move to project|プロジェクトに移動|プロジェクトへ移動)$/,
      ),
    deadline,
  )
  assertTarget()
  move.click()
  const destination = await wait(
    () => exact(doc, '[role="menu"] [role="menuitem"]', name),
    deadline,
  )
  let confirmed = false
  const receipt = (event: Event) => {
    try {
      const value = ProjectReceiptSchema.safeParse(
        JSON.parse((event as CustomEvent<string>).detail),
      )
      if (value.success && value.data.conversationId === cid && value.data.projectId === pid)
        confirmed = true
    } catch {}
  }
  page.addEventListener(PROJECT_EVENT, receipt)
  try {
    assertTarget()
    page.dispatchEvent(
      new page.CustomEvent(PROJECT_ARM_EVENT, {
        detail: JSON.stringify({ conversationId: cid, projectId: pid }),
      }),
    )
    destination.click()
    await wait(() => {
      assertTarget()
      return confirmed && route()?.projectId === pid
    }, deadline)
  } finally {
    page.removeEventListener(PROJECT_EVENT, receipt)
    page.dispatchEvent(new page.CustomEvent('localgpt:project-disarm'))
  }
}
export function conversationActions(doc: Document, cid: string) {
  const links = [...doc.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((a) => {
    try {
      return (
        parseChatRoute(new URL(a.href, doc.defaultView!.location.href).pathname)?.conversationId ===
        cid
      )
    } catch {
      return false
    }
  })
  for (const link of links) {
    let row: HTMLElement | null = link.parentElement
    for (let i = 0; row && i < 3; i++, row = row.parentElement) {
      const button = exact(row, 'button', /^(Chat actions|チャットの操作|会話の操作)$/)
      if (button) return button
    }
  }
  return null
}
