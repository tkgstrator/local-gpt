import { expect, test } from 'bun:test'
import { BrowserRequestSchema, BrowserEventSchema } from '../src/protocol'
const id = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
test('native readiness negotiation is explicit and versioned', () => {
  expect(
    BrowserRequestSchema.safeParse({ type: 'native_readiness', requestId: 'probe' }).success,
  ).toBe(true)
  expect(
    BrowserEventSchema.safeParse({
      type: 'native_ready',
      requestId: 'probe',
      protocol: 1,
      ready: true,
    }).success,
  ).toBe(true)
})
test('native generation preserves the preallocated user identity', () => {
  const result = BrowserRequestSchema.parse({
    type: 'request',
    requestId: 'A',
    text: 'same text',
    newChat: true,
    native: true,
    nativeUserMessageId: id,
  })
  expect(result).toMatchObject({ native: true, nativeUserMessageId: id })
})
test('native intent and identity receipts distinguish local and remote thread IDs', () => {
  expect(
    BrowserEventSchema.safeParse({ type: 'native_intent', requestId: 'A', nativeUserMessageId: id })
      .success,
  ).toBe(true)
  expect(
    BrowserEventSchema.parse({
      type: 'native_identity',
      requestId: 'A',
      nativeUserMessageId: id,
      clientThreadId: 'local-thread',
      conversationId: id,
    }),
  ).toMatchObject({ clientThreadId: 'local-thread', conversationId: id })
  expect(
    BrowserEventSchema.safeParse({
      type: 'native_identity',
      requestId: 'A',
      nativeUserMessageId: id,
      conversationId: 'local-thread',
    }).success,
  ).toBe(false)
})
test('terminal and pre-dispatch evidence survives protocol parsing', () => {
  expect(
    BrowserEventSchema.parse({
      type: 'stop',
      requestId: 'A',
      conversationId: id,
      nativeUserMessageId: id,
      terminalEvidence: true,
    }),
  ).toMatchObject({ nativeUserMessageId: id, terminalEvidence: true })
  expect(
    BrowserEventSchema.parse({
      type: 'error',
      requestId: 'A',
      code: 'native_unavailable',
      message: '',
      nativeUserMessageId: id,
      preDispatch: true,
    }),
  ).toMatchObject({ preDispatch: true, nativeUserMessageId: id })
})
import { ExtensionRequestSchema } from '../src/extension-protocol'
test('extension forwards native poll negotiation and still rejects other fields', () => {
  const request = {
    type: 'bridge_request',
    browserId: 'owner',
    path: 'poll',
    data: { nativeProtocol: 1 },
  }
  expect(ExtensionRequestSchema.safeParse(request).success).toBe(true)
  expect(
    ExtensionRequestSchema.safeParse({ ...request, data: { nativeProtocol: 2 } }).success,
  ).toBe(false)
  expect(
    ExtensionRequestSchema.safeParse({ ...request, data: { nativeProtocol: 1, extra: true } })
      .success,
  ).toBe(false)
  expect(ExtensionRequestSchema.safeParse({ ...request, data: {} }).success).toBe(true)
})
