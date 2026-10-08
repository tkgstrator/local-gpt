import { expect, test } from 'bun:test'
import { observeConversationResponse } from '../src/conversation-stream'
const user = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a',
  cid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const identity = {
  requestId: 'native-terminal',
  messageId: user,
  nativeUserMessageId: user,
  conversationId: cid,
}
test('correlated HTTP refusals release native ownership but server faults stay unknown', async () => {
  for (const status of [429, 503]) {
    const events: any[] = []
    await observeConversationResponse(new Response('refused', { status }), identity, (e) =>
      events.push(e),
    )
    expect(events.at(-1).code).toBe('chatgpt_http_error')
    expect(events.at(-1).terminalEvidence === true).toBe(status === 429)
  }
})
test('failed image tool followed by assistant final is not an early native terminal', async () => {
  const image = {
    id: 'failed-tool',
    author: { role: 'tool' },
    status: 'failed',
    metadata: { async_task_type: 'image_gen' },
  }
  const final = {
    id: 'final',
    author: { role: 'assistant' },
    channel: 'final',
    recipient: 'all',
    status: 'finished_successfully',
    end_turn: true,
    content: { content_type: 'text', parts: ['Could not create image.'] },
  }
  const body =
    [{ ...image, status: 'in_progress' }, image, final]
      .map((message) => 'data: ' + JSON.stringify({ conversation_id: cid, message }) + '\n\n')
      .join('') + 'data: [DONE]\n\n'
  const events: any[] = []
  await observeConversationResponse(
    new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    identity,
    (e) => events.push(e),
  )
  expect(events.some((e) => e.kind === 'error' && e.terminalEvidence)).toBe(false)
  expect(events.some((e) => e.kind === 'answer' && e.text === 'Could not create image.')).toBe(true)
  expect(events.at(-1).kind).toBe('stop')
})
