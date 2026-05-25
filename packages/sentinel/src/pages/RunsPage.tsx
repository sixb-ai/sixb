import { listWorkflowRunsInfiniteOptions, listWorkflowsOptions } from "@pario/client/hooks"
import { Card, CardContent } from "@pario/ui/components"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { History } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import { LoadingInline, PageFrame } from "../components/common"
import { RunHistoryFilters } from "../features/workflows/components/RunHistoryFilters"
import { RunHistoryTable } from "../features/workflows/components/RunHistoryTable"
import { useRunHistorySearch } from "../features/workflows/hooks/useRunHistorySearch"
import { RUN_HISTORY_PAGE_SIZE } from "../features/workflows/utils/workflows"

export function RunsPage() {
  const { selectedStatus, selectedWorkflowId, filtered, clearSearch, updateSearch } =
    useRunHistorySearch()
  const query = {
    limit: String(RUN_HISTORY_PAGE_SIZE),
    order: "desc" as const,
    ...(selectedWorkflowId !== "all" ? { workflowId: selectedWorkflowId } : {}),
    ...(selectedStatus !== "all" ? { status: selectedStatus } : {}),
  }
  const workflowsQuery = useQuery(listWorkflowsOptions())
  const runsQuery = useInfiniteQuery({
    ...listWorkflowRunsInfiniteOptions({ query }),
    initialPageParam: { query },
    getNextPageParam: (lastPage, _pages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined

      const currentOffset =
        typeof lastPageParam === "object" && lastPageParam.query?.offset
          ? Number.parseInt(String(lastPageParam.query.offset), 10)
          : 0
      const nextOffset = Number.isFinite(currentOffset)
        ? currentOffset + RUN_HISTORY_PAGE_SIZE
        : RUN_HISTORY_PAGE_SIZE

      return {
        query: {
          ...query,
          offset: String(nextOffset),
        },
      }
    },
    refetchInterval:
      selectedStatus === "all" || selectedStatus === "queued" || selectedStatus === "running"
        ? 5000
        : false,
  })
  const runs = useMemo(
    () => runsQuery.data?.pages.flatMap((page) => page.runs) ?? [],
    [runsQuery.data]
  )
  const total = runsQuery.data?.pages[0]?.total ?? 0
  const loadMoreRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = loadMoreRef.current
    if (!element || !runsQuery.hasNextPage) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !runsQuery.isFetchingNextPage) {
          void runsQuery.fetchNextPage()
        }
      },
      { rootMargin: "240px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [runsQuery.fetchNextPage, runsQuery.hasNextPage, runsQuery.isFetchingNextPage])

  return (
    <PageFrame
      eyebrow="Runs"
      title="Workflow Runs"
      description="Filter, inspect, and page through workflow execution history."
    >
      <RunHistoryFilters
        workflows={workflowsQuery.data ?? []}
        workflowId={selectedWorkflowId}
        status={selectedStatus}
        onWorkflowIdChange={(workflowId) => updateSearch({ workflowId })}
        onStatusChange={(status) => updateSearch({ status })}
        onClear={clearSearch}
      />

      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="p-0">
          {runsQuery.isLoading ? (
            <div className="px-5 py-8">
              <LoadingInline label="Loading run history..." />
            </div>
          ) : runsQuery.isError ? (
            <RunsEmpty
              title="Run history unavailable"
              description="Could not load workflow run history."
            />
          ) : runs.length === 0 ? (
            <RunsEmpty
              title={filtered ? "No matching runs" : "No run history"}
              description={
                filtered
                  ? "Try another workflow or status to broaden the history view."
                  : "Queued, running, and finished workflow runs will appear here."
              }
            />
          ) : (
            <>
              <RunHistoryTable runs={runs} variant="plain" />
              <InfiniteRunLoader
                loaderRef={loadMoreRef}
                loaded={runs.length}
                total={total}
                hasMore={runsQuery.hasNextPage}
                loading={runsQuery.isFetchingNextPage}
              />
            </>
          )}
        </CardContent>
      </Card>
    </PageFrame>
  )
}

function InfiniteRunLoader({
  loaderRef,
  loaded,
  total,
  hasMore,
  loading,
}: {
  loaderRef: React.Ref<HTMLDivElement>
  loaded: number
  total: number
  hasMore: boolean
  loading: boolean
}) {
  return (
    <div ref={loaderRef} className="border-t border-border px-5 py-4">
      <p className="text-sm text-muted-foreground">
        Showing <span className="font-medium text-foreground">{loaded}</span> of{" "}
        <span className="font-medium text-foreground">{total}</span>
      </p>
      {hasMore || loading ? (
        <div className="mt-3">
          <LoadingInline label={loading ? "Loading more runs..." : "Scroll to load more runs..."} />
        </div>
      ) : null}
    </div>
  )
}

function RunsEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="px-5 py-12">
      <div className="mx-auto flex max-w-sm flex-col items-center text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <History className="h-5 w-5" />
        </span>
        <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
