import type { SessionSummary } from '../adapter/ports/channel-session.js'
import { normalizeWorkspaceCwd } from './view.js'

/** Conversations shown by the workspace supervisor, including the live tip. */
export function visibleWorkspaceSessions(
  sessions: readonly SessionSummary[],
  currentId: string,
): readonly SessionSummary[] {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const ancestors = new Set<string>()
  let cursor = byId.get(currentId)
  while (cursor?.kind.kind === 'fork') {
    const parent = cursor.kind.parent
    if (parent === undefined || ancestors.has(parent)) break
    ancestors.add(parent)
    cursor = byId.get(parent)
  }
  return sessions.filter(session =>
    !session.archived && session.hasPrompt && session.kind.kind !== 'subagent' && !ancestors.has(session.id))
}

/** Count an already-filtered listing by exact normalized working directory. */
export function workspaceSessionCounts(sessions: readonly SessionSummary[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const session of sessions) {
    const key = normalizeWorkspaceCwd(session.cwd)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}
