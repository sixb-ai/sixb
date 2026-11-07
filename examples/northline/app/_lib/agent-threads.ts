import type { ListAgentThreadsResponse } from "@sixb/client"
import { listAgentThreadsInfiniteOptions } from "@sixb/client/hooks"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useMemo } from "react"

type AgentThreadSummary = ListAgentThreadsResponse["threads"][number]

const RECENT_QUERY = { limit: "12", order: "desc" as const }

/** The reader's latest conversations, newest first, for the sidebar's Recents. */
export function useRecentThreads() {
  const query = useInfiniteQuery({
    ...listAgentThreadsInfiniteOptions({ query: RECENT_QUERY }),
    initialPageParam: { query: RECENT_QUERY },
    getNextPageParam: () => undefined,
  })
  const threads = useMemo<readonly AgentThreadSummary[]>(
    () => query.data?.pages.flatMap((page) => page.threads) ?? [],
    [query.data]
  )
  return { threads, loading: query.isLoading }
}

/** A thread's name in a list; a thread is untitled until its first answer names it. */
export function threadTitle(thread: { readonly title?: string | null }): string {
  return thread.title?.trim() || "New conversation"
}

export function threadPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}`
}
