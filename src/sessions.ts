import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { z } from 'zod'
import { ProjectIdSchema, ProjectNameSchema } from './projects'
export const SessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  conversationId: z.string().uuid().nullable(),
  projectName: ProjectNameSchema.nullable(),
  projectId: ProjectIdSchema.nullable(),
  model: z.string().max(200).nullable(),
  effort: z.string().max(200).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
// Saved effort belongs to the saved model: an explicit request wins, otherwise inherit only for the same known model.
export function resolveSessionSettings(
  session: { model: string | null; effort: string | null } | null | undefined,
  model?: string,
  reasoning?: { effort: string },
) {
  const resolvedModel = model ?? session?.model ?? undefined
  const inherited =
    session?.model && session.effort && resolvedModel === session.model
      ? { effort: session.effort }
      : undefined
  return { model: resolvedModel, reasoning: reasoning ?? inherited }
}
export const CreateSessionSchema = z
  .object({
    title: z.string().min(1).max(200).default('新しいセッション'),
    projectName: ProjectNameSchema.nullable().default('LocalGPT'),
    model: z.string().min(1).max(200).optional(),
    reasoning: z
      .object({ effort: z.string().min(1).max(200) })
      .strict()
      .optional(),
  })
  .strict()
export const DeleteSessionSchema = z.object({ session_id: z.string().uuid() }).strict()
export const DeleteSessionResultSchema = z.object({
  session_id: z.string().uuid(),
  deleted: z.literal(true),
  conversationDeleted: z.boolean(),
})
export function createSessionStore(path = ':memory:') {
  const db = new Database(path, { create: true })
  if (path !== ':memory:') chmodSync(path, 0o600)
  db.run(
    'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, conversationId TEXT, model TEXT, effort TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)',
  )
  db.transaction(() => {
    const columns = new Set(
      (db.query('PRAGMA table_info(sessions)').all() as { name: string }[]).map((row) => row.name),
    )
    if (!columns.has('projectName'))
      db.run("ALTER TABLE sessions ADD COLUMN projectName TEXT DEFAULT 'LocalGPT'")
    if (!columns.has('projectId')) db.run('ALTER TABLE sessions ADD COLUMN projectId TEXT')
  })()
  const get = (id: string) => {
    const row = db.query('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? SessionSchema.parse(row) : null
  }
  return {
    get,
    delete: (id: string) => db.query('DELETE FROM sessions WHERE id = ?').run(id).changes > 0,
    list: () =>
      z
        .array(SessionSchema)
        .parse(db.query('SELECT * FROM sessions ORDER BY updatedAt DESC LIMIT 1000').all()),
    create(value: unknown) {
      const body = CreateSessionSchema.parse(value)
      const id = randomUUID()
      const now = new Date().toISOString()
      db.query(
        'INSERT INTO sessions (id, title, conversationId, model, effort, createdAt, updatedAt, projectName, projectId) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL)',
      ).run(
        id,
        body.title,
        body.model ?? null,
        body.reasoning?.effort ?? null,
        now,
        now,
        body.projectName,
      )
      return get(id)!
    },
    setProject(id: string, projectName: string | null, projectId: string | null) {
      if (!get(id)) throw new Error('Unknown session')
      const name = ProjectNameSchema.nullable().parse(projectName)
      const project = ProjectIdSchema.nullable().parse(projectId)
      if (project && !name) throw new Error('A grouped session requires a project name')
      db.query(
        'UPDATE sessions SET projectName = ?, projectId = ?, updatedAt = ? WHERE id = ?',
      ).run(name, project, new Date().toISOString(), id)
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
        effort ?? (model && model !== session.model ? null : session.effort),
        new Date().toISOString(),
        id,
      )
    },
    close: () => db.close(),
  }
}
