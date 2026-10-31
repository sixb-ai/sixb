import { listActivityConnections } from "@sixb/client"
import { Button } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useInfiniteQuery } from "@tanstack/react-query"
import { MonitorSmartphone } from "lucide-react"
import {
  MetaDot,
  PageSection,
  Panel,
  PanelEmpty,
  PanelSkeleton,
  useNumbers,
} from "../../section-ui"
import { useUtcFormat } from "./format"
import { useActivityMessages } from "./messages"
import { activityQueryKey } from "./period"
import { ConnectionStatus, connectionDevice } from "./timeline"

const pageSize = 10

/** A user's sign-ins, newest first, each with the latest visits it opened. */
export function UserConnections({
  userId,
  selected,
  onSelect,
}: {
  readonly userId: string
  readonly selected: string | undefined
  readonly onSelect: (visitId: string) => void
}) {
  const messages = useActivityMessages()
  const format = useUtcFormat()
  const { count } = useNumbers()
  const query = useInfiniteQuery({
    queryKey: [...activityQueryKey, "connections", userId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listActivityConnections({
          query: { userId, limit: pageSize, ...(pageParam ? { cursor: pageParam } : {}) },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  })

  const connections = query.data?.pages.flatMap((page) => page.connections) ?? []

  return (
    <PageSection title={messages.connections.title} description={messages.connections.description}>
      <Panel
        footer={
          query.hasNextPage ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {messages.connections.loadMore}
              </Button>
            </div>
          ) : undefined
        }
      >
        {query.isPending ? (
          <PanelSkeleton rows={2} />
        ) : query.isError ? (
          <PanelEmpty
            tone="error"
            icon={MonitorSmartphone}
            title={messages.connections.unavailable}
          />
        ) : connections.length === 0 ? (
          <PanelEmpty icon={MonitorSmartphone} title={messages.connections.empty} />
        ) : (
          <ul className="divide-y divide-border">
            {connections.map((connection, index) => (
              <li
                key={`${connection.createdAt}:${index}`}
                className="flex flex-col gap-2 px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-medium">
                    {connectionDevice(connection, messages.connection.unknownDevice)}
                  </span>
                  <ConnectionStatus status={connection.status} />
                </div>

                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                  <span>{messages.connection.signedIn(format.at(connection.createdAt))}</span>
                  {connection.lastSeenAt ? (
                    <>
                      <MetaDot />
                      <span>{messages.connection.lastSeen(format.at(connection.lastSeenAt))}</span>
                    </>
                  ) : null}
                  <span className="text-[0.6875rem] text-muted-foreground/80">{messages.utc}</span>
                  <MetaDot />
                  <span>
                    {messages.connections.visits(connection.visits, count(connection.visits))}
                  </span>
                </p>

                {connection.latestVisits.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {connection.latestVisits.map((visit) => (
                      <button
                        key={visit.id}
                        type="button"
                        aria-pressed={visit.id === selected}
                        onClick={() => onSelect(visit.id)}
                        className={cn(
                          "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs tabular-nums transition-colors hover:bg-muted/60",
                          visit.id === selected && "bg-muted text-foreground"
                        )}
                      >
                        {format.range(visit.startedAt, visit.lastSeenAt)}
                        <MetaDot />
                        {messages.visits.pageViews(visit.pageViews, count(visit.pageViews))}
                      </button>
                    ))}
                    {connection.visits > connection.latestVisits.length ? (
                      <span className="text-xs text-muted-foreground">
                        {messages.connections.earlier(
                          connection.visits - connection.latestVisits.length,
                          count(connection.visits - connection.latestVisits.length)
                        )}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </PageSection>
  )
}
