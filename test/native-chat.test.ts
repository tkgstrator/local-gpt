import { expect, test } from 'bun:test'
import {
  discoverNativeRuntime,
  selectNativeModel,
  resolveNativeProject,
  validatePreparedMessage,
  NativeDispatchLedger,
} from '../src/native-chat'

test('runtime discovery imports only observed loaded same-origin assets and rejects ambiguity', async () => {
  const imported: string[] = []
  const runtime = { c: {}, aE: Symbol() }
  const load = async (url: string) => {
    imported.push(url)
    return { __webpack_require__: runtime }
  }
  expect(
    await discoverNativeRuntime(
      'https://chatgpt.com',
      ['https://evil.example/cdn/assets/a.js', 'https://chatgpt.com/cdn/assets/current.js'],
      load,
    ),
  ).toBe(runtime)
  expect(imported).toEqual(['https://chatgpt.com/cdn/assets/current.js'])
  await expect(
    discoverNativeRuntime(
      'https://chatgpt.com',
      ['https://chatgpt.com/cdn/assets/a.js', 'https://chatgpt.com/cdn/assets/b.js'],
      async () => ({ __webpack_require__: { c: {} } }),
    ),
  ).rejects.toThrow('ambiguous')
})
test('native model validation uses observed options without modifying selection', () => {
  const models = {
    versionOptions: [
      {
        id: 'pro',
        slugs: ['gpt-pro'],
        options: [
          { slug: 'gpt-pro', thinkingEffort: 'high', isAvailable: true },
          { slug: 'gpt-pro', thinkingEffort: 'low', isAvailable: false },
        ],
      },
    ],
  }
  const selected = { slug: 'gpt-pro', thinkingEffort: 'high', versionId: 'pro' }
  expect(selectNativeModel(models, selected, 'gpt-pro', 'high')).toEqual({
    model: 'gpt-pro',
    thinkingEffort: 'high',
    versionId: 'pro',
  })
  expect(() => selectNativeModel(models, selected, 'gpt-pro', 'low')).toThrow('unavailable')
  expect(selected).toEqual({ slug: 'gpt-pro', thinkingEffort: 'high', versionId: 'pro' })
})
test('a different requested model uses only a uniquely observed available effort', () => {
  const models = {
    versionOptions: [
      {
        id: 'pro',
        slugs: ['gpt-pro'],
        options: [{ slug: 'gpt-pro', thinkingEffort: 'high', isAvailable: true }],
      },
    ],
  }
  const selected = { slug: 'other', thinkingEffort: null, versionId: 'other' }
  expect(selectNativeModel(models, selected, 'gpt-pro')).toEqual({
    model: 'gpt-pro',
    thinkingEffort: 'high',
    versionId: 'pro',
  })
  expect(() =>
    selectNativeModel(
      {
        versionOptions: [
          {
            ...models.versionOptions[0],
            options: [
              ...models.versionOptions[0]!.options,
              { slug: 'gpt-pro', thinkingEffort: 'low', isAvailable: true },
            ],
          },
        ],
      },
      selected,
      'gpt-pro',
    ),
  ).toThrow('reasoning_required')
})
test('native project identity is exact and never borrowed from current route', () => {
  const rows = [{ label: 'LocalGPT', id: 'g-p-0123456789abcdef0123456789abcdef' }]
  expect(resolveNativeProject(rows, 'LocalGPT')).toBe(rows[0].id)
  expect(() => resolveNativeProject([...rows, ...rows], 'LocalGPT')).toThrow('ambiguous')
  expect(() => resolveNativeProject(rows, 'Other')).toThrow('unavailable')
  expect(() =>
    resolveNativeProject(rows, 'LocalGPT', 'g-p-ffffffffffffffffffffffffffffffff'),
  ).toThrow('mismatch')
})
test('native builder validates exact user message and UUID before dispatch', () => {
  const uuid = 'b3241425-4f9f-4e13-a3cb-8b0fd902f32a'
  const built = {
    extraDeveloperInstructionMessages: [],
    message: {
      id: crypto.randomUUID(),
      author: { role: 'user' },
      content: { content_type: 'text', parts: ['hello'] },
      metadata: {},
    },
  }
  expect(validatePreparedMessage(built, 'hello', uuid).message.id).toBe(uuid)
  expect(() =>
    validatePreparedMessage(
      { ...built, message: { ...built.message, author: { role: 'assistant' } } },
      'hello',
      uuid,
    ),
  ).toThrow()
  expect(() => validatePreparedMessage(built, 'different', uuid)).toThrow()
})
test('dispatch ledger refuses lost-ACK retries and mismatched receipt identity', () => {
  const ledger = new NativeDispatchLedger()
  ledger.prepare('A', 'uuid-A')
  ledger.attempt('A', 'uuid-A')
  expect(() => ledger.attempt('A', 'uuid-A')).toThrow('already')
  expect(() => ledger.attempt('A', 'uuid-B')).toThrow('identity')
  expect(() => ledger.prepare('__proto__', 'uuid-C')).toThrow('request_id')
  expect(() => ledger.prepare('foreign', 'uuid-A')).toThrow('identity')
  ledger.prepare('B', 'uuid-B')
  ledger.attempt('B', 'uuid-B')
})
