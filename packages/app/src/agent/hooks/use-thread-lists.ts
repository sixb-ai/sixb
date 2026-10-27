import { listAgentApprovalsOptions, listAgentThreadsInfiniteOptions } from "@sixb/client/hooks"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { THREAD_PAGE_SIZE } from "../thread-navigation"

const THREAD_LIST_QUERY = {
  limit: String(THREAD_PAGE_SIZE),
  order: "desc" as const,
}

/** The threads others shared with the reader: one page, newest first. */
const SHARED_THREAD_LIST_QUERY = {
  sharedWithMe: "true" as const,
  limit: String(THREAD_PAGE_SIZE),
  order: "desc" as const,
}

/** The calls waiting for the reader across threads, for the thread list. */
const PENDING_APPROVALS_QUERY = { status: "pending" as const, limit: "200" }

/**
 * The reader's threads, the ones shared with them, and those where a call waits for them: what a
 * thread's header counts and the threads page lists. One read for both, so opening the page from a
 * thread shows what the thread already had.
 */
export function useAgentThreadLists(options: {
  /** How often to read again while nothing announces changes; off by default. */
  readonly refetchInterval?: number | false
}) {
  const refetchInterval = options.refetchInterval ?? false
  const threadsQuery = useInfiniteQuery({
    ...listAgentThreadsInfiniteOptions({ query: THREAD_LIST_QUERY }),
    initialPageParam: { query: THREAD_LIST_QUERY },
    getNextPageParam: nextPage(THREAD_LIST_QUERY),
    refetchInterval,
  })
  // Nothing announces a new share or a removal: read the list again when the reader comes back.
  const sharedThreadsQuery = useInfiniteQuery({
    ...listAgentThreadsInfiniteOptions({ query: SHARED_THREAD_LIST_QUERY }),
    initialPageParam: { query: SHARED_THREAD_LIST_QUERY },
    getNextPageParam: nextPage(SHARED_THREAD_LIST_QUERY),
    refetchInterval,
    refetchOnWindowFocus: true,
  })
  const pendingApprovalsQuery = useQuery({
    ...listAgentApprovalsOptions({ query: PENDING_APPROVALS_QUERY }),
    refetchInterval,
    retry: false,
  })

  const threads = useMemo(
    () => threadsQuery.data?.pages.flatMap((page) => page.threads) ?? [],
    [threadsQuery.data]
  )
  const sharedThreads = useMemo(
    () => sharedThreadsQuery.data?.pages.flatMap((page) => page.threads) ?? [],
    [sharedThreadsQuery.data]
  )
  /** The threads where a call waits for the reader. */
  const waitingThreadIds = useMemo(
    () =>
      new Set(
        (pendingApprovalsQuery.data?.approvals ?? []).map((approval) => approval.threadId)
      ) as ReadonlySet<string>,
    [pendingApprovalsQuery.data]
  )

  return { threadsQuery, sharedThreadsQuery, threads, sharedThreads, waitingThreadIds }
}

/** The page after those read so far, while the server says there are more. */
function nextPage<Query extends object>(query: Query) {
  return (lastPage: { readonly hasMore: boolean }, pages: readonly unknown[]) =>
    lastPage.hasMore
      ? { query: { ...query, offset: String(pages.length * THREAD_PAGE_SIZE) } }
      : undefined
}
