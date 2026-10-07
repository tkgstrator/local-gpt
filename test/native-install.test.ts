import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { installNativeChat, NATIVE_REQUEST_EVENT, NATIVE_RESULT_EVENT } from '../src/native-chat'
const id = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
test('missing verified runtime contracts advertises native unavailable, never legacy UI fallback', async () => {
  const page = new Window({ url: 'https://chatgpt.com/' })
  const receipts: any[] = []
  page.addEventListener(NATIVE_RESULT_EVENT, (e) =>
    receipts.push(JSON.parse((e as CustomEvent<string>).detail)),
  )
  installNativeChat(page as any)
  page.dispatchEvent(
    new page.CustomEvent(NATIVE_REQUEST_EVENT, {
      detail: JSON.stringify({ action: 'probe', requestId: 'probe' }),
    }),
  )
  await new Promise((r) => setTimeout(r, 10))
  expect(receipts).toContainEqual(expect.objectContaining({ kind: 'ready', ready: false }))
  await page.happyDOM.abort()
  page.close()
})
test('persisted native user identity prevents another request from regenerating after page loss', async () => {
  const page = new Window({ url: 'https://chatgpt.com/' })
  let sends = 0
  const receipts: any[] = []
  page.sessionStorage.setItem('localgpt:native-dispatch-journal', JSON.stringify({ previous: id }))
  page.addEventListener(NATIVE_RESULT_EVENT, (e) =>
    receipts.push(JSON.parse((e as CustomEvent<string>).detail)),
  )
  installNativeChat(page as any, async () => ({
    scope: {},
    models: {
      versionOptions: [{ id: 'v', slugs: ['m'], options: [{ slug: 'm', isAvailable: true }] }],
    },
    selected: { slug: 'm', thinkingEffort: null, versionId: 'v' },
    projectRows: [],
    upload: async () => {},
    build: (text) => ({
      extraDeveloperInstructionMessages: [],
      message: {
        id: crypto.randomUUID(),
        author: { role: 'user' },
        content: { content_type: 'text', parts: [text] },
        metadata: {},
      },
    }),
    submit: async () => {
      sends++
    },
  }))
  page.dispatchEvent(
    new page.CustomEvent(NATIVE_REQUEST_EVENT, {
      detail: JSON.stringify({
        action: 'prepare',
        type: 'request',
        requestId: 'newId',
        native: true,
        nativeUserMessageId: id,
        text: 'hi',
        newChat: true,
      }),
    }),
  )
  await new Promise((r) => setTimeout(r, 5))
  page.dispatchEvent(
    new page.CustomEvent(NATIVE_REQUEST_EVENT, {
      detail: JSON.stringify({ action: 'dispatch', requestId: 'newId', nativeUserMessageId: id }),
    }),
  )
  await new Promise((r) => setTimeout(r, 5))
  expect(sends).toBe(0)
  expect(receipts).toContainEqual(expect.objectContaining({ kind: 'error', preDispatch: false }))
  await page.happyDOM.abort()
  page.close()
})
test('page native bridge validates commands and never retries an attempted request', async () => {
  const page = new Window({ url: 'https://chatgpt.com/' })
  let sends = 0
  const receipts: any[] = []
  page.addEventListener(NATIVE_RESULT_EVENT, (e) =>
    receipts.push(JSON.parse((e as CustomEvent<string>).detail)),
  )
  installNativeChat(page as any, async () => ({
    scope: {},
    models: {
      versionOptions: [{ id: 'v', slugs: ['m'], options: [{ slug: 'm', isAvailable: true }] }],
    },
    selected: { slug: 'm', thinkingEffort: null, versionId: 'v' },
    projectRows: [],
    upload: async () => {},
    build: (text) => ({
      extraDeveloperInstructionMessages: [],
      message: {
        id: crypto.randomUUID(),
        author: { role: 'user' },
        content: { content_type: 'text', parts: [text] },
        metadata: {},
      },
    }),
    submit: async () => {
      sends++
    },
  }))
  const command = (data: any) =>
    page.dispatchEvent(new page.CustomEvent(NATIVE_REQUEST_EVENT, { detail: JSON.stringify(data) }))
  command({ action: 'probe', requestId: 'probe' })
  await new Promise((r) => setTimeout(r, 5))
  expect(receipts).toContainEqual(expect.objectContaining({ kind: 'ready', ready: true }))
  command({
    action: 'prepare',
    type: 'request',
    requestId: 'A',
    native: true,
    nativeUserMessageId: id,
    text: 'hi',
    newChat: true,
  })
  await new Promise((r) => setTimeout(r, 5))
  expect(sends).toBe(0)
  command({ action: 'dispatch', requestId: 'A', nativeUserMessageId: id })
  await new Promise((r) => setTimeout(r, 5))
  expect(sends).toBe(1)
  command({ action: 'dispatch', requestId: 'A', nativeUserMessageId: id })
  await new Promise((r) => setTimeout(r, 5))
  expect(sends).toBe(1)
  expect(receipts).toContainEqual(expect.objectContaining({ kind: 'error', preDispatch: false }))
  await page.happyDOM.abort()
  page.close()
})
