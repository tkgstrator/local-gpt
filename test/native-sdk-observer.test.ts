import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { NativeChatDispatcher, type NativeContract } from '../src/native-chat'
import { installPageObserver } from '../src/page-observer'
const a = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const b = 'a3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const ca = 'c3241425-4f9f-4e13-a3cb-8b0fd902f32a'
const cb = 'd3241425-4f9f-4e13-a3cb-8b0fd902f32a'
function graph(cid: string, user: string, text: string) {
  const final = crypto.randomUUID()
  return {
    conversation_id: cid,
    current_node: user,
    private: 'raw-secret',
    mapping: {
      [user]: { id: user, parent: null, message: { id: user, author: { role: 'user' } } },
      [final]: {
        id: final,
        parent: user,
        message: {
          id: final,
          author: { role: 'assistant' },
          channel: 'final',
          recipient: 'all',
          status: 'finished_successfully',
          end_turn: true,
          content: { content_type: 'text', parts: [text] },
        },
      },
    },
  }
}
test('connected dispatcher observer recovers separate A/B CIDs while SDK submits stay pending, then B continues', async () => {
  const page = new Window({ url: 'https://chatgpt.com/' })
  const events: any[] = [],
    reads: string[] = [],
    posts: any[] = []
  const snapshots = new Map<string, unknown>()
  page.fetch = (async (_input: any, init: any) => {
    expect(init.method).toBe('POST')
    posts.push(JSON.parse(init.body))
    return new Response('data: {\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as any
  const contract: NativeContract = {
    scope: {},
    projectRows: [],
    models: {
      versionOptions: [{ id: 'v', slugs: ['pro'], options: [{ slug: 'pro', isAvailable: true }] }],
    },
    selected: { slug: 'pro', thinkingEffort: null, versionId: 'v' },
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
    prepareExistingConversation: async (cid) => ({ conversationId: cid, parentMessageId: b }),
    readConversationSnapshot: async (cid) => {
      reads.push(cid)
      return snapshots.get(cid)
    },
    submit: (_scope, options) => {
      const user = options.userCompletionMessages.message.id
      const cid = options.conversationId ?? (user === a ? ca : cb)
      snapshots.set(cid, graph(cid, user, `final ${user}`))
      options.onServerThreadIdChange(cid)
      void page.fetch('/backend-api/f/conversation', {
        method: 'POST',
        body: JSON.stringify({
          conversation_id: cid,
          messages: [options.userCompletionMessages.message],
        }),
      })
      return new Promise(() => {})
    },
  }
  const dispatcher = new NativeChatDispatcher(
    async () => contract,
    (receipt) =>
      page.dispatchEvent(
        new page.CustomEvent('localgpt:native-result', { detail: JSON.stringify(receipt) }),
      ),
    () => {},
  )
  installPageObserver(page as any, dispatcher)
  page.addEventListener('localgpt:response-stream', (event: any) =>
    events.push(JSON.parse(event.detail)),
  )
  const send = async (requestId: string, user: string, cid?: string) => {
    await dispatcher.prepare({
      type: 'request',
      requestId,
      native: true,
      nativeUserMessageId: user,
      text: 'same',
      newChat: !cid,
      ...(cid ? { conversationId: cid } : {}),
    })
    page.dispatchEvent(
      new page.CustomEvent('localgpt:stream-arm', {
        detail: JSON.stringify({
          requestId,
          text: 'same',
          native: true,
          nativeUserMessageId: user,
          backgroundJob: true,
          ...(cid ? { serverConversationId: cid } : {}),
        }),
      }),
    )
    await dispatcher.dispatch(requestId, user)
  }
  try {
    await send('A', a)
    await send('B', b)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(
      events
        .filter((e) => e.kind === 'stop')
        .map((e) => [e.requestId, e.conversationId])
        .sort(),
    ).toEqual([
      ['A', ca],
      ['B', cb],
    ])
    for (const id of ['A', 'B']) {
      page.dispatchEvent(new page.CustomEvent('localgpt:stream-disarm', { detail: id }))
      dispatcher.disarm(id)
    }
    const continuation = crypto.randomUUID()
    await send('B2', continuation, cb)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(events.at(-1)).toMatchObject({ kind: 'stop', requestId: 'B2', conversationId: cb })
    expect(reads).toEqual([ca, cb, cb])
    expect(posts.length).toBe(3)
    expect(JSON.stringify(events)).not.toContain('raw-secret')
  } finally {
    await page.close()
  }
})

test('native missing SDK loader never tries anonymous graph GET even when it would return 401 or 404', async () => {
  for (const status of [401, 404]) {
    const page = new Window({ url: `https://chatgpt.com/c/${ca}` })
    let gets = 0
    const events: any[] = []
    page.fetch = (async (_input: any, init: any) => {
      if (init.method === 'GET') {
        gets++
        return new Response('', { status })
      }
      return new Response('data: {\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as any
    installPageObserver(page as any)
    page.addEventListener('localgpt:response-stream', (e: any) => events.push(JSON.parse(e.detail)))
    page.dispatchEvent(
      new page.CustomEvent('localgpt:stream-arm', {
        detail: JSON.stringify({
          requestId: 'missing',
          text: 'same',
          native: true,
          nativeUserMessageId: a,
          serverConversationId: ca,
          backgroundJob: true,
        }),
      }),
    )
    await page.fetch('/backend-api/f/conversation', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: ca,
        messages: [{ id: a, author: { role: 'user' }, content: { parts: ['same'] } }],
      }),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(gets).toBe(0)
    expect(events.some((e) => e.kind === 'stop')).toBe(false)
    await page.close()
  }
})

async function pendingHeaders(opts: {
  cid?: string
  reads: string[]
  snapshots: Map<string, unknown>
  gate?: Promise<void>
}) {
  const page = new Window({ url: 'https://chatgpt.com/' })
  const events: any[] = []
  let release!: (r: Response) => void
  const headers = new Promise<Response>((resolve) => (release = resolve))
  const watches = new Set<unknown>()
  const setTimer = page.setTimeout.bind(page),
    clearTimer = page.clearTimeout.bind(page)
  page.setTimeout = ((fn: () => void, delay: number) => {
    const id = setTimer(() => {
      watches.delete(id)
      fn()
    }, delay)
    if (delay === 1000) watches.add(id)
    return id
  }) as any
  page.clearTimeout = ((id: any) => {
    watches.delete(id)
    clearTimer(id)
  }) as any
  page.fetch = (() => headers) as any
  const recovery = {
    readConversationSnapshot: async (_r: string, _u: string, cid: string) => {
      opts.reads.push(cid)
      await opts.gate
      return opts.snapshots.get(cid)
    },
  }
  installPageObserver(page as any, recovery as any)
  page.addEventListener('localgpt:response-stream', (e: any) => events.push(JSON.parse(e.detail)))
  page.dispatchEvent(
    new page.CustomEvent('localgpt:stream-arm', {
      detail: JSON.stringify({
        requestId: 'H',
        text: 'same',
        native: true,
        nativeUserMessageId: a,
        backgroundJob: true,
        ...(opts.cid ? { serverConversationId: opts.cid } : {}),
      }),
    }),
  )
  const consumer = page
    .fetch('/backend-api/f/conversation', {
      method: 'POST',
      body: JSON.stringify({
        ...(opts.cid ? { conversation_id: opts.cid } : {}),
        messages: [{ id: a, author: { role: 'user' }, content: { parts: ['same'] } }],
      }),
    })
    .then((r) => r)
  return { page, events, release, consumer, watches }
}
const realNow = Date.now
const jump = (ms: number) => {
  const base = realNow()
  Date.now = () => realNow() + ms + 0 * base
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('late headers while SDK recovery is pending can complete through the resumed stream', async () => {
  const reads: string[] = []
  let releaseRead!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const h = await pendingHeaders({
    cid: ca,
    reads,
    gate,
    snapshots: new Map([[ca, graph(ca, a, 'stale SDK final')]]),
  })
  try {
    jump(11 * 60 * 1000)
    await sleep(1200)
    expect(reads).toEqual([ca])
    const body = `data: ${JSON.stringify({ conversation_id: ca, message: { id: crypto.randomUUID(), author: { role: 'assistant' }, channel: 'final', recipient: 'all', status: 'finished_successfully', end_turn: true, content: { content_type: 'text', parts: ['stream final'] } } })}\n\ndata: [DONE]\n\n`
    h.release(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    expect(await (await h.consumer).text()).toBe(body)
    await sleep(100)
    expect(h.events.filter((e) => e.kind === 'stop').length).toBe(1)
    expect(h.events.filter((e) => e.kind === 'answer').map((e) => e.text)).toEqual(['stream final'])
    releaseRead()
    await sleep(100)
    expect(h.events.filter((e) => e.kind === 'stop').length).toBe(1)
    expect(h.events.filter((e) => e.kind === 'answer').map((e) => e.text)).toEqual(['stream final'])
  } finally {
    releaseRead()
    Date.now = realNow
    await h.page.close()
  }
})

test('pending POST headers: idle watcher recovers via exact existing CID, once at a time', async () => {
  const reads: string[] = [],
    snapshots = new Map<string, unknown>([[ca, graph(ca, a, 'late final')]])
  const h = await pendingHeaders({ cid: ca, reads, snapshots })
  try {
    await sleep(1200)
    expect(h.events.some((e) => e.phase === 'unresponsive')).toBe(false)
    jump(11 * 60 * 1000)
    await sleep(2500)
    expect(h.events.filter((e) => e.phase === 'unresponsive').length).toBe(1)
    expect(h.events.filter((e) => e.kind === 'stop').map((e) => e.conversationId)).toEqual([ca])
    expect(reads).toEqual([ca])
    // Late headers after recovered terminal: no extra observer/terminal, consumer unaffected.
    h.release(new Response('data: {\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    const response = await h.consumer
    expect(response.ok).toBe(true)
    await sleep(100)
    expect(h.events.filter((e) => e.kind === 'stop').length).toBe(1)
    expect(h.events.filter((e) => e.kind === 'error').length).toBe(0)
  } finally {
    Date.now = realNow
    await h.page.close()
  }
})

test('pending POST headers with unknown CID waits, never reads visible route, then recovers after identity', async () => {
  const reads: string[] = [],
    snapshots = new Map<string, unknown>([[cb, graph(cb, a, 'adopted')]])
  const h = await pendingHeaders({ reads, snapshots })
  try {
    h.page.happyDOM.setURL(`https://chatgpt.com/c/${ca}`)
    jump(11 * 60 * 1000)
    await sleep(2500)
    expect(reads).toEqual([])
    expect(h.events.some((e) => e.kind === 'stop')).toBe(false)
    h.page.dispatchEvent(
      new h.page.CustomEvent('localgpt:native-result', {
        detail: JSON.stringify({
          kind: 'identity',
          requestId: 'H',
          nativeUserMessageId: a,
          conversationId: cb,
        }),
      }),
    )
    await sleep(5500)
    expect(reads).toEqual([cb])
    expect(h.events.filter((e) => e.kind === 'stop').map((e) => e.conversationId)).toEqual([cb])
  } finally {
    Date.now = realNow
    await h.page.close()
  }
}, 15000)

test('disarm cancels a pending-header watcher immediately without resolving original fetch', async () => {
  const reads: string[] = []
  const h = await pendingHeaders({ cid: ca, reads, snapshots: new Map() })
  try {
    expect(h.watches.size).toBe(1)
    let settled = false
    void h.consumer.then(() => {
      settled = true
    })
    h.page.dispatchEvent(new h.page.CustomEvent('localgpt:stream-disarm', { detail: 'H' }))
    expect(h.watches.size).toBe(0)
    expect(settled).toBe(false)
    expect(reads).toEqual([])
  } finally {
    await h.page.close()
  }
})

test('early headers cancel the watcher: no unresponsive after fast response', async () => {
  const reads: string[] = [],
    snapshots = new Map<string, unknown>()
  const h = await pendingHeaders({ cid: ca, reads, snapshots })
  try {
    h.release(new Response('data: {\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    await h.consumer
    await sleep(100)
    jump(11 * 60 * 1000)
    await sleep(2500)
    expect(
      h.events.filter((e) => e.phase === 'unresponsive' && e.requestId === 'H').length,
    ).toBeLessThanOrEqual(1)
    expect(reads.length).toBeLessThanOrEqual(1)
  } finally {
    Date.now = realNow
    await h.page.close()
  }
})
