import type { Agent, AgentThread } from "./types"

export const THREAD_PAGE_SIZE = 50

/** Search across the human-visible thread and agent identity without changing its date order. */
export function filterThreadNavigation(
  threads: readonly AgentThread[],
  agentsById: ReadonlyMap<string, Agent>,
  searchTerm: string
): readonly AgentThread[] {
  const query = searchTerm.trim().toLowerCase()
  if (!query) return threads

  return threads.filter((thread) => {
    const title = thread.title?.trim() || "Untitled chat"
    const agentName = agentsById.get(thread.agentId)?.name ?? thread.agentId
    return `${title}\n${agentName}`.toLowerCase().includes(query)
  })
}
