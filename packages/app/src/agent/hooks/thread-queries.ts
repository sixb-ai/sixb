import {
  getAgentThreadOptions,
  listAgentThreadMessagesOptions,
  listAgentThreadRunsOptions,
} from "@sixb/client/hooks"
import { type QueryClient, queryOptions, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

/**
 * How long a thread's reads count as fresh. Opening a thread its prefetch just read shows them
 * without reading them again; an event that changes the thread marks them stale, whatever their
 * age (`markThreadReadsStale`).
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

/** The operations a thread's reads are cached under, each keyed by the thread it reads. */
const THREAD_READS = Object.values(threadQueryOptions("")).map((read) => read.queryKey[0]._id)

/**
 * Mark a thread's cached reads stale without reading them, or every thread's when no thread is
 * named: whatever shows one next reads it again. A thread nobody has open learns of a change this
 * way, from an activity event or the feed reconnecting, since its reads stay fresh for a while once
 * read and nothing else would read them again.
 */
export function markThreadReadsStale(queryClient: QueryClient, threadId?: string): void {
  for (const _id of THREAD_READS) {
    void queryClient.invalidateQueries({
      queryKey: [threadId === undefined ? { _id } : { _id, path: { threadId } }],
      refetchType: "none",
    })
  }
}
