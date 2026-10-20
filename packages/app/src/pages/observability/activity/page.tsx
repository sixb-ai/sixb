import {
  type GetActivitySummaryResponse,
  type GetActivityVisitTimelineResponse,
  getActivitySummary,
  getActivityVisitTimeline,
  isSixbApiError,
  type ListActivityVisitsResponse,
  listActivityVisits,
} from "@sixb/client"
import { Button } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link2, MousePointerClick, RefreshCw, UserRound, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { SectionPage } from "../../section-page"
import {
  PageSection,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  useLoadFailure,
  useNumbers,
} from "../../section-ui"
import { ActivityCalendar } from "./calendar"
import { UserConnections } from "./connections"
import { type UtcFormat, useUtcFormat } from "./format"
import { useActivityMessages } from "./messages"
import { MetaItems } from "./meta-items"
import {
  type ActivityRange,
  activityPeriod,
  activityQueryKey,
  activityRanges,
  parseActivityDay,
  parseActivityRange,
} from "./period"
import { ConnectionLine, sharedLinkName, VisitEntries } from "./timeline"
import { UserFilter, useActivityUsers } from "./users"

type Visit = ListActivityVisitsResponse["visits"][number]
type Period = { readonly from: string; readonly to: string; readonly userId?: string }
type Cursor = { readonly beforeAt: string; readonly beforeId: string }

const pageSize = 25

/**
 * Observability › Activity: who used the app in a period, their visits, and the pages viewed in
 * each. A user's calendar shows their active days in a year; a day opens its visits.
 */
export function ObservabilityActivityPage() {
  const messages = useActivityMessages()
  const locale = useLocale()
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  // The period ends when it was chosen; Refresh moves it to now.
  const [end, setEnd] = useState(() => new Date())

  const range = parseActivityRange(params.get("range"))
  const day = parseActivityDay(params.get("day"))
  const userId = params.get("user") || undefined
  const visitId = params.get("visit") || undefined
  // The calendar opens on the chosen day's year, else this one.
  const year =
    parseYear(params.get("year")) ?? (day ? Number(day.slice(0, 4)) : end.getUTCFullYear())

  const period: Period = useMemo(
    () => ({ ...activityPeriod({ range, day, end }), ...(userId ? { userId } : {}) }),
    [range, day, end, userId]
  )

  const update = (changes: Readonly<Record<string, string | undefined>>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        for (const [name, value] of Object.entries(changes)) {
          if (value === undefined) {
            next.delete(name)
          } else {
            next.set(name, value)
          }
        }
        return next
      },
      { replace: true }
    )

  const summary = useQuery({
    queryKey: [...activityQueryKey, "summary", period],
    queryFn: async ({ signal }) =>
      (await getActivitySummary({ query: period, signal, throwOnError: true })).data,
    retry: false,
  })
  const users = useActivityUsers(period)
  const names = users.names

  // A rolling range moves to now, which gives its queries new keys; what a period does not key
  // (a chosen day, the calendar, connections, a visit's timeline) is reloaded in place. Each loads
  // once.
  const refresh = () => {
    if (day === undefined) {
      setEnd(new Date())
      void queryClient.invalidateQueries({ queryKey: [...activityQueryKey, "calendar"] })
      void queryClient.invalidateQueries({ queryKey: [...activityQueryKey, "connections"] })
      void queryClient.invalidateQueries({ queryKey: [...activityQueryKey, "visit"] })
    } else {
      void queryClient.invalidateQueries({ queryKey: activityQueryKey })
    }
  }
  const failure = useLoadFailure(summary.error, {
    denied: messages.denied,
    fallback: messages.unavailable,
  })

  return (
    <SectionPage
      section="observability"
      page="activity"
      width="wide"
      title={messages.title}
      description={messages.description}
    >
      <div className="flex flex-wrap items-center gap-2">
        <UserFilter
          userId={userId}
          users={users}
          onChange={(next) => update({ user: next, visit: undefined })}
        />

        {day === undefined ? null : (
          <span className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-card pr-1 pl-3 text-[0.8125rem]">
            {messages.day(formatDay(day, locale))}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={messages.clearDay}
              onClick={() => update({ day: undefined, visit: undefined })}
            >
              <X />
            </Button>
          </span>
        )}

        {/* One toolbar on every width: on a phone it wraps instead of stacking under the title. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <RangeToggle
            value={day === undefined ? range : undefined}
            onChange={(next) => {
              update({ range: next, day: undefined, visit: undefined })
              setEnd(new Date())
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={refresh}
            aria-label={messages.refresh}
          >
            <RefreshCw />
          </Button>
        </div>
      </div>

      {summary.error ? (
        <Panel>
          <PanelEmpty
            tone="error"
            icon={MousePointerClick}
            title={failure.title}
            description={failure.description}
            action={
              isSixbApiError(summary.error) && summary.error.status === 403 ? undefined : (
                <Button type="button" variant="outline" size="sm" onClick={refresh}>
                  {messages.retry}
                </Button>
              )
            }
          />
        </Panel>
      ) : (
        <>
          <Metrics summary={summary.data} forUser={userId !== undefined} />

          {userId ? (
            <>
              <ActivityCalendar
                userId={userId}
                year={year}
                selectedDay={day}
                onYear={(next) => update({ year: String(next) })}
                onDay={(next) => update({ day: next, year: next.slice(0, 4), visit: undefined })}
              />
              <UserConnections
                userId={userId}
                selected={visitId}
                onSelect={(id) => update({ visit: id })}
              />
            </>
          ) : null}

          <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
            <Visits
              period={period}
              names={names}
              forUser={userId !== undefined}
              selected={visitId}
              onSelect={(id) => update({ visit: id })}
            />
            <VisitTimeline key={visitId ?? "none"} visitId={visitId} names={names} />
          </div>
        </>
      )}
    </SectionPage>
  )
}

function RangeToggle({
  value,
  onChange,
}: {
  /** Undefined while a calendar day is shown instead. */
  readonly value: ActivityRange | undefined
  readonly onChange: (range: ActivityRange) => void
}) {
  const messages = useActivityMessages()
  return (
    <div className="inline-flex rounded-lg bg-muted/70 p-0.5 ring-1 ring-border/70">
      {activityRanges.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-pressed={value === entry.id}
          onClick={() => onChange(entry.id)}
          className={cn(
            "h-7 rounded-md px-2.5 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground",
            value === entry.id && "bg-background text-foreground ring-1 ring-border"
          )}
        >
          {messages.ranges[entry.id]}
        </button>
      ))}
    </div>
  )
}

function Metrics({
  summary,
  forUser,
}: {
  readonly summary: GetActivitySummaryResponse | undefined
  /** One user's numbers: counting users or shared links says nothing then. */
  readonly forUser: boolean
}) {
  const messages = useActivityMessages().metrics
  const { count } = useNumbers()
  const metrics = [
    ...(forUser
      ? []
      : [{ label: messages.users, value: summary?.users, detail: messages.usersDetail }]),
    { label: messages.visits, value: summary?.visits, detail: messages.visitsDetail },
    ...(forUser
      ? []
      : [
          {
            label: messages.sharedVisits,
            value: summary?.sharedVisits,
            detail: messages.sharedVisitsDetail,
          },
        ]),
    { label: messages.pageViews, value: summary?.pageViews, detail: messages.pageViewsDetail },
  ]

  return (
    <div className={cn("grid grid-cols-2 gap-3", forUser ? "sm:grid-cols-2" : "lg:grid-cols-4")}>
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="flex min-w-0 flex-col rounded-xl border border-border bg-card px-4 py-3.5 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          <p className="truncate text-xs text-muted-foreground">{metric.label}</p>
          <p className="mt-1.5 truncate text-2xl font-semibold tracking-tight tabular-nums">
            {count(metric.value)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{metric.detail}</p>
        </div>
      ))}
    </div>
  )
}

function Visits({
  period,
  names,
  forUser,
  selected,
  onSelect,
}: {
  readonly period: Period
  readonly names: ReadonlyMap<string, string>
  /** One user's visits: the row is named by its time, not by the user again. */
  readonly forUser: boolean
  readonly selected: string | undefined
  readonly onSelect: (visitId: string) => void
}) {
  const messages = useActivityMessages()
  const { count } = useNumbers()
  const format = useUtcFormat()
  const query = useInfiniteQuery({
    queryKey: [...activityQueryKey, "visits", period],
    initialPageParam: undefined as Cursor | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listActivityVisits({
          query: { ...period, ...pageParam, limit: pageSize },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => {
      const last = page.visits.at(-1)
      return page.hasMore && last ? { beforeAt: last.lastSeenAt, beforeId: last.id } : undefined
    },
    retry: false,
  })

  // Live activity can move a visit to a later page; it is listed once.
  const visits = [
    ...new Map(
      (query.data?.pages.flatMap((page) => page.visits) ?? []).map((visit) => [visit.id, visit])
    ).values(),
  ]

  return (
    <PageSection title={messages.visits.title} description={messages.visits.description}>
      <Panel
        footer={
          query.hasNextPage || query.isFetchNextPageError ? (
            <div className="flex items-center justify-between gap-3">
              <span>{query.isFetchNextPageError ? messages.visits.moreFailed : null}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {messages.visits.loadMore}
              </Button>
            </div>
          ) : undefined
        }
      >
        {query.isPending ? (
          <PanelSkeleton rows={4} />
        ) : query.isError ? (
          <PanelEmpty tone="error" icon={MousePointerClick} title={messages.unavailable} />
        ) : visits.length === 0 ? (
          <PanelEmpty
            icon={MousePointerClick}
            title={messages.visits.emptyTitle}
            description={period.userId ? messages.visits.emptyUser : messages.visits.empty}
          />
        ) : (
          visits.map((visit) => {
            const when = <VisitRange visit={visit} format={format} />
            const facts = [
              ...(forUser ? [] : [when]),
              messages.visits.pageViews(visit.pageViews, count(visit.pageViews)),
              sourceLabel(visit, messages.source),
            ]

            return (
              <div
                key={visit.id}
                aria-current={visit.id === selected ? "true" : undefined}
                className="aria-[current]:bg-muted/70 aria-[current]:shadow-[inset_2px_0_0_var(--foreground)]"
              >
                <PanelRow
                  onClick={() => onSelect(visit.id)}
                  leading={<ActorMark visit={visit} />}
                  title={forUser ? when : <ActorName visit={visit} names={names} />}
                  meta={<MetaItems items={facts} />}
                />
              </div>
            )
          })
        )}
      </Panel>
    </PageSection>
  )
}

function VisitTimeline({
  visitId,
  names,
}: {
  readonly visitId: string | undefined
  readonly names: ReadonlyMap<string, string>
}) {
  const messages = useActivityMessages()
  const query = useQuery({
    queryKey: [...activityQueryKey, "visit", visitId],
    enabled: visitId !== undefined,
    queryFn: async ({ signal }) =>
      (
        await getActivityVisitTimeline({
          path: { visitId: visitId ?? "" },
          signal,
          throwOnError: true,
        })
      ).data,
    retry: false,
  })

  const timeline = query.data

  // Below the list on a narrow screen, the chosen visit would open out of sight.
  const panel = useRef<HTMLDivElement>(null)
  const shownId = timeline?.visit.id
  useEffect(() => {
    if (shownId && window.matchMedia?.("(max-width: 1023px)").matches) {
      panel.current?.scrollIntoView({ block: "start", behavior: "smooth" })
    }
  }, [shownId])

  return (
    <div ref={panel} className="min-w-0 scroll-mt-4">
      <PageSection title={messages.visit.title}>
        {visitId === undefined ? (
          <Panel>
            <p className="px-4 py-3.5 text-[0.8125rem] text-muted-foreground">
              {messages.visit.select}
            </p>
          </Panel>
        ) : (
          <Panel
            toolbar={timeline ? <VisitHeader timeline={timeline} names={names} /> : undefined}
            footer={
              timeline?.truncated ? (
                <>
                  <p>{messages.visit.truncated}</p>
                  <p className="mt-1">{messages.visit.note}</p>
                </>
              ) : (
                messages.visit.note
              )
            }
          >
            {query.isPending ? (
              <PanelSkeleton rows={3} />
            ) : query.isError || !timeline ? (
              <PanelEmpty
                tone="error"
                icon={MousePointerClick}
                title={messages.visit.unavailable}
              />
            ) : (
              <VisitEntries timeline={timeline} />
            )}
          </Panel>
        )}
      </PageSection>
    </div>
  )
}

function VisitHeader({
  timeline,
  names,
}: {
  readonly timeline: GetActivityVisitTimelineResponse
  readonly names: ReadonlyMap<string, string>
}) {
  const messages = useActivityMessages().source
  const format = useUtcFormat()
  const { visit } = timeline
  const facts = [
    { label: messages.label, value: sourceLabel(visit, messages) },
    ...(visit.attribution?.medium
      ? [{ label: messages.medium, value: visit.attribution.medium }]
      : []),
    ...(visit.attribution?.campaign
      ? [{ label: messages.campaign, value: visit.attribution.campaign }]
      : []),
  ]

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-1 py-0.5">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <ActorName visit={visit} names={names} />
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        <VisitRange visit={visit} format={format} />
      </p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {facts.map((fact) => (
          <div key={fact.label} className="flex min-w-0 gap-1.5">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="min-w-0 break-words">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {timeline.connection ? <ConnectionLine connection={timeline.connection} /> : null}
    </div>
  )
}

function ActorMark({ visit }: { readonly visit: Visit }) {
  const Icon = visit.actor.type === "user" ? UserRound : Link2
  return (
    <span
      aria-hidden
      className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
    >
      <Icon className="size-4" />
    </span>
  )
}

function ActorName({
  visit,
  names,
}: {
  readonly visit: Visit
  readonly names: ReadonlyMap<string, string>
}) {
  const messages = useActivityMessages().visits
  if (visit.actor.type === "user") {
    return <span className="truncate">{names.get(visit.actor.userId) ?? visit.actor.userId}</span>
  }

  return (
    <>
      <span className="shrink-0">{messages.sharedLink}</span>
      <span
        className="truncate text-xs font-normal text-muted-foreground"
        title={visit.actor.grantId}
      >
        {sharedLinkName(visit.actor, messages)}
      </span>
    </>
  )
}

/** UTM source, else the referring host, else Direct; `null` attribution was never collected. */
function sourceLabel(
  visit: Visit,
  messages: ReturnType<typeof useActivityMessages>["source"]
): string {
  const attribution = visit.attribution
  if (attribution === null) {
    return messages.notRecorded
  }
  if (attribution.source) {
    return attribution.source
  }
  if (attribution.medium || attribution.campaign) {
    return messages.unspecified
  }
  return attribution.referrer ?? messages.direct
}

function VisitRange({ visit, format }: { readonly visit: Visit; readonly format: UtcFormat }) {
  const messages = useActivityMessages()
  return (
    <span className="tabular-nums">
      {format.range(visit.startedAt, visit.lastSeenAt)}{" "}
      <span className="text-[0.6875rem] text-muted-foreground/80">{messages.utc}</span>
    </span>
  )
}

function formatDay(day: string, locale: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  })
}

function parseYear(value: string | null): number | undefined {
  const year = Number(value)
  return Number.isInteger(year) && year >= 1970 && year <= new Date().getUTCFullYear()
    ? year
    : undefined
}
