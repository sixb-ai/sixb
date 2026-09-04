import type { AgentThread } from "./types"

export const THREAD_PAGE_SIZE = 50

/** Search human-visible thread titles without changing their date order. */
export function filterThreadNavigation(
  threads: readonly AgentThread[],
  searchTerm: string
): readonly AgentThread[] {
  const query = searchTerm.trim().toLowerCase()
  if (!query) return threads

  return threads.filter((thread) => {
    const title = thread.title?.trim() || "Untitled chat"
    return title.toLowerCase().includes(query)
  })
}
