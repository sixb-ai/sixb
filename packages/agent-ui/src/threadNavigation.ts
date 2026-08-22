import type { Agent, AgentThread } from "./types"

export const THREAD_PAGE_SIZE = 50

export interface ThreadNavigationSections {
  readonly running: readonly AgentThread[]
  readonly recent: readonly AgentThread[]
}

/** Search across the human-visible thread and agent identity, then prioritize active work. */
export function threadNavigationSections(
  threads: readonly AgentThread[],
  agentsById: ReadonlyMap<string, Agent>,
  searchTerm: string
): ThreadNavigationSections {
  const query = searchTerm.trim().toLocaleLowerCase()
  const visible = query
    ? threads.filter((thread) => {
        const title = thread.title?.trim() || "Untitled chat"
        const agentName = agentsById.get(thread.agentId)?.name ?? thread.agentId
        return `${title}\n${agentName}`.toLocaleLowerCase().includes(query)
      })
    : threads

  return {
    running: visible.filter((thread) => thread.activeRunId !== null),
    recent: visible.filter((thread) => thread.activeRunId === null),
  }
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
