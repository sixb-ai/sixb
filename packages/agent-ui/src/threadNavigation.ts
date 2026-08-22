import type { Agent, AgentThread } from "./types"

export const THREAD_PAGE_SIZE = 50

/** Search across the human-visible thread and agent identity without changing its date order. */
export function filterThreadNavigation(
  threads: readonly AgentThread[],
  agentsById: ReadonlyMap<string, Agent>,
  searchTerm: string
): readonly AgentThread[] {
  const query = searchTerm.trim().toLocaleLowerCase()
  if (!query) return threads

  return threads.filter((thread) => {
    const title = thread.title?.trim() || "Untitled chat"
    const agentName = agentsById.get(thread.agentId)?.name ?? thread.agentId
    return `${title}\n${agentName}`.toLocaleLowerCase().includes(query)
  })
}

/** Calculate the next offset for the Agent thread list's offset-based pagination. */
export function nextThreadPageOffset(
  hasMore: boolean,
  currentOffset: string | number | undefined
): number | undefined {
  if (!hasMore) return undefined
  const parsedOffset =
    typeof currentOffset === "number" ? currentOffset : Number.parseInt(currentOffset ?? "", 10)
  return (Number.isFinite(parsedOffset) ? parsedOffset : 0) + THREAD_PAGE_SIZE
}
