import {
  getAgentThreadOptions,
  listAgentThreadMessagesOptions,
  listAgentThreadRunsOptions,
} from "@sixb/client/hooks"
import { useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"

/** How long an opened thread's messages stay cached once nothing shows them: coming back is instant. */
export const THREAD_MESSAGES_CACHE_MS = 30 * 60_000

/** How recent a thread's reads may be for a prefetch to leave them: hovering does not fetch again. */
const PREFETCH_FRESH_MS = 30_000

/** The reads opening a thread makes. Prefetching warms these same queries, by these same keys. */
export function threadQueryOptions(threadId: string) {
  const path = { threadId }
  return {
    thread: getAgentThreadOptions({ path }),
    messages: listAgentThreadMessagesOptions({ path, query: { order: "asc" } }),
    runs: listAgentThreadRunsOptions({ path, query: { order: "desc" } }),
  }
}

/**
 * Load a thread before it opens, such as when the pointer rests on its link, so opening it shows
 * its messages at once. A thread read in the last 30 seconds is left as it is.
 */
export function usePrefetchAgentThread(): (threadId: string) => void {
  const queryClient = useQueryClient()
  return useCallback(
    (threadId: string) => {
      const options = threadQueryOptions(threadId)
      void queryClient.prefetchQuery({ ...options.thread, staleTime: PREFETCH_FRESH_MS })
      void queryClient.prefetchQuery({
        ...options.messages,
        staleTime: PREFETCH_FRESH_MS,
        gcTime: THREAD_MESSAGES_CACHE_MS,
      })
      void queryClient.prefetchQuery({ ...options.runs, staleTime: PREFETCH_FRESH_MS })
    },
    [queryClient]
  )
}
