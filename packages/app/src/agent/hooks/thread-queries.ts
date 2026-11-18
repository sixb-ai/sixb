import {
  getAgentThreadOptions,
  listAgentThreadMessagesOptions,
  listAgentThreadRunsOptions,
} from "@sixb/client/hooks"
import { queryOptions, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

/**
 * How long a thread's reads count as fresh. Opening a thread its prefetch just read shows them
 * without reading them again; an event that changes the thread invalidates them, whatever their age.
 */
const THREAD_READS_FRESH_MS = 30_000

/** How long a thread's messages stay cached once nothing shows them: coming back is instant. */
const THREAD_MESSAGES_CACHE_MS = 30 * 60_000

/**
 * The reads opening a thread makes. Opening and prefetching both use these, so they share each
 * query by its key and agree on when it is fresh.
 */
export function threadQueryOptions(threadId: string) {
  const path = { threadId }

  return {
    thread: queryOptions({ ...getAgentThreadOptions({ path }), staleTime: THREAD_READS_FRESH_MS }),
    messages: queryOptions({
      ...listAgentThreadMessagesOptions({ path, query: { order: "asc" } }),
      staleTime: THREAD_READS_FRESH_MS,
      gcTime: THREAD_MESSAGES_CACHE_MS,
    }),
    runs: queryOptions({
      ...listAgentThreadRunsOptions({ path, query: { order: "desc" } }),
      staleTime: THREAD_READS_FRESH_MS,
    }),
  }
}

/**
 * Load a thread before it opens, such as when the pointer rests on its link, so opening it shows
 * its messages at once. Reads still fresh are left as they are.
 */
export function usePrefetchAgentThread(): (threadId: string) => void {
  const queryClient = useQueryClient()

  return useCallback(
    (threadId: string) => {
      const reads = threadQueryOptions(threadId)

      void queryClient.prefetchQuery(reads.thread)
      void queryClient.prefetchQuery(reads.messages)
      void queryClient.prefetchQuery(reads.runs)
    },
    [queryClient]
  )
}
