import { expect, test } from 'bun:test'
import { discoverCachedNativeExports } from '../src/native-chat'
test('completion/upload resolution uses loaded cached named exports, never invokes module require', async () => {
  let calls = 0
  const runtime = Object.assign(
    () => {
      calls++
      throw new Error('must not load')
    },
    {
      c: {
        completion: { exports: { submitChatGPTCompletion: async () => {} } },
        upload: { exports: { uploadChatGptConversationFile: async () => {} } },
        builder: {
          exports: {
            d: function builder() {
              return {
                extraDeveloperInstructionMessages: [],
                message: { author: { role: 'user' }, content: { content_type: 'text' } },
              }
            },
          },
        },
      },
    },
  )
  const result = await discoverCachedNativeExports(runtime)
  expect(result.submit).toBe(runtime.c.completion.exports.submitChatGPTCompletion)
  expect(result.upload).toBe(runtime.c.upload.exports.uploadChatGptConversationFile)
  expect(result.builder).toBe(runtime.c.builder.exports.d)
  expect(calls).toBe(0)
})
test('multiple independent completion exports are unsupported', async () => {
  await expect(
    discoverCachedNativeExports({
      c: {
        a: { exports: { submitChatGPTCompletion: async () => {} } },
        b: { exports: { submitChatGPTCompletion: async () => {} } },
      },
    }),
  ).rejects.toThrow('ambiguous')
})
test('async cache namespaces are inspected through observed runtime symbol', async () => {
  const aE = Symbol('async exports'),
    submit = async () => {},
    upload = async () => {}
  const builder = function () {
    return {
      extraDeveloperInstructionMessages: [],
      message: { author: { role: 'user' }, content: { content_type: 'text' } },
    }
  }
  const result = await discoverCachedNativeExports({
    aE,
    c: {
      a: {
        exports: {
          [aE]: {
            submitChatGPTCompletion: submit,
            uploadChatGptConversationFile: upload,
            d: builder,
          },
        },
      },
    },
  })
  expect(result.submit).toBe(submit)
})
