import { z } from 'zod'

export const ProjectIdSchema = z.string().regex(/^g-p-[a-f0-9]{32}$/)
export const ProjectNameSchema = z.string().trim().min(1).max(200)

export interface ChatRoute {
  projectId: string | null
  conversationId: string | null
  provisionalId: string | null
}

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const project = '(g-p-[a-f0-9]{32})(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?'
const conversationRoute = new RegExp(`^/c/(local-chatgpt%3A)?(${uuid})$`)
const projectRoute = new RegExp(`^/g/${project}/(project|c/(local-chatgpt%3A)?(${uuid}))$`)

export function parseChatRoute(path: string): ChatRoute | null {
  const direct = conversationRoute.exec(path)
  const grouped = direct ? null : projectRoute.exec(path)
  if (!direct && !grouped) return null
  const projectId = grouped?.[1] ?? null
  const id = direct?.[2] ?? grouped?.[4] ?? null
  if (id && !z.string().uuid().safeParse(id).success) return null
  const provisional = Boolean(direct?.[1] ?? grouped?.[3])
  return {
    projectId,
    conversationId: provisional ? null : id,
    provisionalId: provisional ? id : null,
  }
}

export function conversationPath(conversationId: string, projectId?: string | null): string {
  const id = z.string().uuid().parse(conversationId)
  return projectId ? `/g/${ProjectIdSchema.parse(projectId)}/c/${id}` : `/c/${id}`
}

export function projectPath(projectId: string): string {
  return `/g/${ProjectIdSchema.parse(projectId)}/project`
}
