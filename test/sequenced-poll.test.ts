import { test, expect } from 'bun:test'
const { PollJournal } = await import('../src/sequenced-poll').catch(() => ({
  PollJournal: undefined as any,
}))
const target = { browserId: '7:browser-a', tabId: 7, documentId: 'doc-a' }
const stream = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const request = { type: 'native_readiness' as const, requestId: 'first' }
function fixture(options = {}) {
  expect(typeof PollJournal).toBe('function')
  const journal = new PollJournal(options)
  const opened = journal.open(target, stream, 1000)
  const read = (sequence: number, changes = {}, owner = true, blocked = false) =>
    journal.read(
      target,
      {
        protocol: 1,
        epoch: opened.epoch,
        streamId: stream,
        sequence,
        activation: 1000,
        nativeProtocol: 1,
        ...changes,
      },
      () => {
        calls++
        return request
      },
      () => owner,
      blocked,
    )
  let calls = 0
  return { journal, opened, read, calls: () => calls }
}
test('the same logical poll returns one cached request without draining twice', () => {
  const f = fixture()
  expect(f.read(1).request).toEqual(request)
  expect(f.read(1).request).toEqual(request)
  expect(f.calls()).toBe(1)
  expect(f.read(2).request).toEqual(request)
  expect(f.calls()).toBe(2)
  expect(f.read(1).error).toBe('stale_poll')
  expect(f.calls()).toBe(2)
})
test('cached commands retire when request ownership or maintenance exclusivity changes', () => {
  const f = fixture()
  f.read(1)
  expect(f.read(1, {}, false).request).toBe(null)
  expect(f.calls()).toBe(1)
  f.read(2)
  expect(f.read(2, {}, true, true).request).toBe(null)
  expect(f.calls()).toBe(2)
})
test('replacement documents fence old streams before any dequeue', () => {
  const f = fixture()
  f.read(1)
  f.journal.open({ ...target, documentId: 'doc-b' }, other, 2000)
  expect(f.read(1).error).toBe('stream_replaced')
  expect(f.calls()).toBe(1)
  expect(f.journal.open(target, stream, 1000).error).toBe('inactive_document')
})
test('wrong boot epoch and missing sequence never become a fresh read', () => {
  const f = fixture()
  expect(f.read(1, { epoch: other }).error).toBe('epoch_changed')
  expect(f.calls()).toBe(0)
  expect(f.read(2).error).toBe('invalid_sequence')
  expect(f.calls()).toBe(0)
})
test('a replay-only reconciliation cannot dequeue a read the server has not processed', () => {
  const f = fixture()
  expect(f.read(1, { reconcile: true }).error).toBe('poll_not_processed')
  expect(f.calls()).toBe(0)
})
test('bounded journal refuses capacity instead of forgetting a high-water tombstone', () => {
  const f = fixture({ maxStreams: 1 })
  f.read(1)
  expect(f.journal.open({ ...target, documentId: 'doc-b' }, other, 2000).error).toBe(
    'poll_capacity',
  )
  expect(f.read(1).request).toEqual(request)
  expect(f.calls()).toBe(1)
})

test('late first opens cannot steal activation and BFCache resumes without resetting high-water', () => {
  const f = fixture()
  f.read(1)
  f.journal.open({ ...target, documentId: 'doc-b' }, other, 2000)
  expect(
    f.journal.open(
      { ...target, documentId: 'late-first-doc' },
      '33333333-3333-4333-8333-333333333333',
      1500,
    ).error,
  ).toBe('inactive_document')
  expect(f.journal.open(target, stream, 3000).error).toBeUndefined()
  expect(f.read(1, { activation: 3000 }).request).toBe(null)
  expect(f.calls()).toBe(1)
  expect(f.read(2, { activation: 1000 }).error).toBe('inactive_document')
  expect(f.calls()).toBe(1)
  expect(f.read(2, { activation: 3000 }).request).toEqual(request)
})
