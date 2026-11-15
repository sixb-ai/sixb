import {
  getAgentThreadQueryKey,
  listAgentApprovalsOptions,
  listAgentThreadsInfiniteOptions,
  listAgentThreadsQueryKey,
  markAgentThreadReadMutation,
} from "@sixb/client/hooks"
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useMemo } from "react"
import { THREAD_PAGE_SIZE } from "../thread-navigation"
import type { AgentThread, AgentThreadRead } from "../types"

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
  const queryClient = useQueryClient()
  const markRead = useMutation(markAgentThreadReadMutation())

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

  /**
   * Record the reader's place in a thread, or its newest when no seq is given, which is what Done
   * sends. The answer is the state it produced, so the caches take it without a refetch.
   */
  const markThreadRead = async (
    threadId: string,
    throughSeq?: number
  ): Promise<AgentThreadRead> => {
    const { read } = await markRead.mutateAsync({
      path: { threadId },
      body: throughSeq === undefined ? {} : { throughSeq },
    })

    queryClient.setQueriesData<InfiniteData<{ threads: AgentThread[] }>>(
      { queryKey: listAgentThreadsQueryKey() },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            threads: page.threads.map((thread) =>
              thread.id === read.threadId ? { ...thread, read } : thread
            ),
          })),
        }
    )
    queryClient.setQueryData<AgentThread>(
      getAgentThreadQueryKey({ path: { threadId } }),
      (thread) => (thread ? { ...thread, read } : thread)
    )

    return read
  }

  return {
    threadsQuery,
    sharedThreadsQuery,
    threads,
    sharedThreads,
    waitingThreadIds,
    markThreadRead,
  }
}

/** The page after those read so far, while the server says there are more. */
function nextPage<Query extends object>(query: Query) {
  return (lastPage: { readonly hasMore: boolean }, pages: readonly unknown[]) =>
    lastPage.hasMore
      ? { query: { ...query, offset: String(pages.length * THREAD_PAGE_SIZE) } }
      : undefined
}
