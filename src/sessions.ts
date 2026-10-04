import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { z } from 'zod'
export const SessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  conversationId: z.string().uuid().nullable(),
  model: z.string().max(200).nullable(),
  effort: z.string().max(200).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export const CreateSessionSchema = z
  .object({
    title: z.string().min(1).max(200).default('新しいセッション'),
    model: z.string().min(1).max(200).optional(),
    reasoning: z
      .object({ effort: z.string().min(1).max(200) })
      .strict()
      .optional(),
  })
  .strict()
export function createSessionStore(path = ':memory:') {
  const db = new Database(path, { create: true })
  if (path !== ':memory:') chmodSync(path, 0o600)
  db.run(
    'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, conversationId TEXT, model TEXT, effort TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)',
  )
  const get = (id: string) => {
    const row = db.query('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? SessionSchema.parse(row) : null
  }
  return {
    get,
    list: () =>
      z
        .array(SessionSchema)
        .parse(db.query('SELECT * FROM sessions ORDER BY updatedAt DESC LIMIT 1000').all()),
    create(value: unknown) {
      const body = CreateSessionSchema.parse(value)
      const id = randomUUID()
      const now = new Date().toISOString()
      db.query('INSERT INTO sessions VALUES (?, ?, NULL, ?, ?, ?, ?)').run(
        id,
        body.title,
        body.model ?? null,
        body.reasoning?.effort ?? null,
        now,
        now,
      )
      return get(id)!
    },
    bind(id: string, conversationId: string, model?: string, effort?: string) {
      const session = get(id)
      if (!session) throw new Error('Unknown session')
      if (session.conversationId && session.conversationId !== conversationId)
        throw new Error('Session conversation changed')
      db.query(
        'UPDATE sessions SET conversationId = ?, model = ?, effort = ?, updatedAt = ? WHERE id = ?',
      ).run(
        conversationId,
        model ?? session.model,
        effort ?? session.effort,
        new Date().toISOString(),
        id,
      )
    },
    close: () => db.close(),
  }
}
