import type { ListActionRunsResponse } from "@sixb/client"
import { listActionRunsInfiniteOptions, listActionsOptions } from "@sixb/client/hooks"
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sixb/ui/components"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { ChevronRight, Loader2, Zap } from "lucide-react"
import { actionRunHref } from "../../routes"
import {
  formatDuration,
  IconTile,
  isUnrecorded,
  MetaDot,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  RunStatusPill,
  UnrecordedHistory,
  useFormat,
  useLoadFailure,
  useNumbers,
  useRunStatusLabels,
} from "../../section-ui"
import { humanizeIdentifier } from "./lib/labels"

type ActionRun = ListActionRunsResponse["runs"][number]

const statuses = ["succeeded", "failed"] as const
type ActionRunStatus = (typeof statuses)[number]

const pageSize = 20

/** Runs record no event, so the list is read again while it is displayed. */
const pollMs = 10_000

/** Where the runs list lives, so a run's page can lead back to it. */
export const ACTION_RUNS_HREF = "/console/actions?view=runs"

/**
 * Every action run, newest first, filtered by action and by how it went. Each opens its page: its
 * input, subject, phases, effects and logs.
 */
export function ActionRuns({
  actionId,
  status,
  onFilter,
}: {
  readonly actionId: string | null
  readonly status: string | null
  /** One update per change, so the action and the status never race for the URL. */
  readonly onFilter: (changes: {
    readonly action?: string | null
    readonly status?: string | null
  }) => void
}) {
  const format = useFormat()
  const numbers = useNumbers()
  const statusLabels = useRunStatusLabels()
  const actions = useQuery({ ...listActionsOptions(), retry: false }).data ?? []
  const actionIds = actions.map((action) => action.id)
  const shownStatus = statuses.find((candidate) => candidate === status) ?? null
  const query = useInfiniteQuery({
    ...listActionRunsInfiniteOptions({
      query: {
        limit: String(pageSize),
        order: "desc",
        ...(actionId ? { actionId } : {}),
        ...(shownStatus ? { status: shownStatus } : {}),
      },
    }),
    // Each next page starts where the loaded runs end.
    initialPageParam: "0",
    getNextPageParam: (lastPage, pages) =>
      lastPage.hasMore ? String(pages.reduce((sum, page) => sum + page.runs.length, 0)) : undefined,
    retry: false,
    refetchInterval: pollMs,
  })
  const failure = useLoadFailure(query.error, { fallback: "The runs could not be loaded." })
  // Pages are read by offset from the newest, so runs that start between two reads shift the next
  // page onto runs already shown; each run is listed once.
  const runs = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.runs) ?? []).map((run) => [run.id, run])
    ).values(),
  ]
  const total = query.data?.pages[0]?.total ?? 0
  const filtered = Boolean(actionId || shownStatus)

  return (
    <Panel
      toolbar={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Select
            value={actionId ?? "all"}
            onValueChange={(value) => onFilter({ action: value === "all" ? null : value })}
          >
            <SelectTrigger size="sm" className="h-7 w-44 text-xs" aria-label="Action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="all" className="text-xs">
                All actions
              </SelectItem>
              {/* A link can name one the project no longer defines; it still shows as chosen. */}
              {actionId && !actionIds.includes(actionId) ? (
                <SelectItem value={actionId} className="text-xs">
                  {humanizeIdentifier(actionId)}
                </SelectItem>
              ) : null}
              {actionIds.map((id) => (
                <SelectItem key={id} value={id} className="text-xs">
                  {humanizeIdentifier(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={shownStatus ?? "all"}
            onValueChange={(value) => onFilter({ status: value === "all" ? null : value })}
          >
            <SelectTrigger size="sm" className="h-7 w-32 text-xs" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="all" className="text-xs">
                All statuses
              </SelectItem>
              {statuses.map((value: ActionRunStatus) => (
                <SelectItem key={value} value={value} className="text-xs">
                  {statusLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
      footer={
        runs.length > 0 && total > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <span className="tabular-nums">
              {query.isError ? (
                <span className="text-red-600 dark:text-red-400">
                  {query.isFetchNextPageError
                    ? "The next runs could not be loaded."
                    : "The list could not be refreshed."}
                </span>
              ) : (
                `${numbers.count(runs.length)} of ${numbers.count(total)}`
              )}
            </span>
            {query.hasNextPage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-my-1"
                disabled={query.isFetchingNextPage}
                onClick={() => query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
                Load more
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {query.isPending ? (
        <PanelSkeleton rows={4} />
      ) : query.isError && runs.length === 0 ? (
        isUnrecorded(query.error) ? (
          <UnrecordedHistory what="Action runs" />
        ) : (
          <PanelEmpty
            tone="error"
            icon={Zap}
            title={failure.title}
            description={failure.description}
          />
        )
      ) : runs.length === 0 ? (
        <PanelEmpty
          icon={Zap}
          title={filtered ? "No runs match" : "No runs yet"}
          description={
            filtered
              ? "Try another action or status."
              : "An action's runs appear here once someone applies one."
          }
        />
      ) : (
        runs.map((run) => (
          <ActionRunRow key={run.id} run={run} at={format.relative(run.startedAt)} />
        ))
      )}
    </Panel>
  )
}

function ActionRunRow({ run, at }: { readonly run: ActionRun; readonly at: string }) {
  return (
    <PanelRow
      href={actionRunHref(run.id)}
      leading={<IconTile icon={Zap} />}
      title={<span className="truncate">{humanizeIdentifier(run.actionId)}</span>}
      meta={
        <>
          {run.subject.kind === "none" ? (
            <span>No subject</span>
          ) : (
            <span className="min-w-0 truncate font-mono text-xs">
              {run.subject.objectTypeId} · {run.subject.primaryId}
            </span>
          )}
          <MetaDot />
          <span>{at}</span>
          {run.finishedAt ? (
            <>
              <MetaDot />
              <span className="tabular-nums">{formatDuration(run.startedAt, run.finishedAt)}</span>
            </>
          ) : null}
          {run.error ? (
            <>
              <MetaDot />
              <span className="min-w-0 truncate text-red-600 dark:text-red-400">
                {run.error.message}
              </span>
            </>
          ) : null}
        </>
      }
      trailing={
        <>
          <RunStatusPill status={run.status} />
          <ChevronRight className="size-4 text-muted-foreground/60" />
        </>
      }
    />
  )
}
