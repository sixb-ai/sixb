import type { GetActivityVisitTimelineResponse } from "@sixb/client"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { Bot, FileText, type LucideIcon, MousePointerClick, Workflow, Zap } from "lucide-react"
import { Fragment, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { actionRunHref, objectHref, workflowRunHref } from "../../routes"
import { humanize, MetaDot, Pill, RunStatusPill, ToolbarTabs, useNumbers } from "../../section-ui"
import { formatChartMoney, nanosToNumber } from "../ai-usage/format"
import { useUtcFormat } from "./format"
import { type ActivityMessages, useActivityMessages } from "./messages"
import { MetaItems } from "./meta-items"

type Timeline = GetActivityVisitTimelineResponse
type Entry = Timeline["entries"][number]
type Connection = NonNullable<Timeline["connection"]>
type Filter = "all" | Entry["kind"]

const filters: readonly Filter[] = ["all", "page", "interaction", "action", "workflow", "agent"]

const icons: Readonly<Record<Entry["kind"], LucideIcon>> = {
  page: FileText,
  interaction: MousePointerClick,
  action: Zap,
  workflow: Workflow,
  agent: Bot,
}

/** What a visit did, by time, with a filter by kind that counts each. */
export function VisitEntries({ timeline }: { readonly timeline: Timeline }) {
  const messages = useActivityMessages().visit
  const [filter, setFilter] = useState<Filter>("all")
  const format = useUtcFormat()
  const time = (at: string) => format.timeIn(timeline.visit.startedAt, at)

  const counts = useMemo(() => {
    const byKind = new Map<Filter, number>([["all", timeline.entries.length]])
    for (const entry of timeline.entries) {
      byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1)
    }
    return byKind
  }, [timeline.entries])

  const shown =
    filter === "all" ? timeline.entries : timeline.entries.filter((entry) => entry.kind === filter)

  return (
    <>
      <div className="overflow-x-auto border-b border-border px-3 py-2">
        <ToolbarTabs
          tabs={filters.map((id) => ({
            id,
            label: messages.filters[id],
            count: counts.get(id) ?? 0,
          }))}
          value={filter}
          onChange={setFilter}
        />
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-6 text-[0.8125rem] text-muted-foreground">
          {filter === "all" ? messages.noPages : messages.nothingOfKind}
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {shown.map((entry) => (
            <EntryRow key={entryKey(entry)} entry={entry} time={time} />
          ))}
        </ol>
      )}
    </>
  )
}

function EntryRow({
  entry,
  time,
}: {
  readonly entry: Entry
  readonly time: (value: string) => string
}) {
  const Icon = icons[entry.kind]

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <time
        dateTime={entry.at}
        className="min-w-16 shrink-0 pt-px text-xs text-muted-foreground tabular-nums"
      >
        {time(entry.at)}
      </time>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <EntryContent entry={entry} />
      </div>
    </li>
  )
}

function EntryContent({ entry }: { readonly entry: Entry }) {
  const messages = useActivityMessages().visit
  const locale = useLocale()
  const { count } = useNumbers()

  switch (entry.kind) {
    case "page":
      return <RoutePattern route={entry.route} />

    case "interaction":
      return (
        <>
          <span className="font-mono text-[0.8125rem] font-medium break-all">{entry.name}</span>
          <RoutePattern route={entry.route} className="text-xs text-muted-foreground" />
        </>
      )

    case "action": {
      const name = humanize(entry.actionId)
      return (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <RunName name={name} href={entry.runVisible ? actionRunHref(entry.runId) : undefined} />
            <EntryStatus status={entry.status} />
          </div>
          {entry.object ? (
            <Link
              to={objectHref(entry.object.objectTypeId, entry.object.primaryId)}
              className="w-fit max-w-full truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {humanize(entry.object.objectTypeId)} · {entry.object.primaryId}
            </Link>
          ) : null}
        </>
      )
    }

    case "workflow": {
      const name = humanize(entry.workflowId)
      return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <RunName name={name} href={entry.runVisible ? workflowRunHref(entry.runId) : undefined} />
          <EntryStatus status={entry.status} />
        </div>
      )
    }

    case "agent":
      return (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[0.8125rem] font-medium">{messages.agentRun}</span>
            <EntryStatus status={entry.status} />
          </div>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{messages.messages(entry.messages, count(entry.messages))}</span>
            {entry.cost && entry.cost.amounts.length > 0 ? (
              <>
                <MetaDot />
                <span className="tabular-nums">
                  {entry.cost.amounts
                    .map((amount) =>
                      formatChartMoney(nanosToNumber(amount.amountNanos), amount.currency, locale)
                    )
                    .join(" + ")}
                </span>
              </>
            ) : null}
          </p>
        </>
      )
  }
}

/**
 * A route pattern that wraps after a slash when it must, not inside a segment; a segment wider
 * than the row still breaks anywhere.
 */
function RoutePattern({
  route,
  className,
}: {
  readonly route: string
  readonly className?: string
}) {
  const segments = route.split("/")
  return (
    <span className={cn("font-mono text-[0.8125rem] [overflow-wrap:anywhere]", className)}>
      {segments.map((segment, index) => (
        // Each prefix of the route is distinct, so it keys the segment that ends it.
        <Fragment key={segments.slice(0, index + 1).join("/")}>
          {segment}
          {index < segments.length - 1 ? (
            <>
              /<wbr />
            </>
          ) : null}
        </Fragment>
      ))}
    </span>
  )
}

/** A run's name, linking to its page in Observability › Runs when the viewer may read it. */
function RunName({ name, href }: { readonly name: string; readonly href: string | undefined }) {
  const messages = useActivityMessages().visit
  if (!href) {
    return <span className="text-[0.8125rem] font-medium">{name}</span>
  }

  return (
    <Link
      to={href}
      aria-label={messages.openRun(name)}
      className="text-[0.8125rem] font-medium underline-offset-2 hover:underline"
    >
      {name}
    </Link>
  )
}

function EntryStatus({
  status,
}: {
  readonly status: Extract<Entry, { readonly status: unknown }>["status"]
}) {
  const messages = useActivityMessages().visit
  return status === "incomplete" ? (
    <Pill tone="warn">{messages.incomplete}</Pill>
  ) : (
    <RunStatusPill status={status} />
  )
}

/** The device or shared link a visit came through, on one line. */
export function ConnectionLine({ connection }: { readonly connection: Connection }) {
  const messages = useActivityMessages()
  const format = useUtcFormat()

  // A shared link is named by the visit's header; its connection says when it was opened.
  const facts =
    connection.type === "session"
      ? [
          connectionDevice(connection, messages.connection.unknownDevice),
          messages.connection.signedIn(`${format.at(connection.createdAt)} ${messages.utc}`),
        ]
      : [messages.connection.opened(`${format.at(connection.createdAt)} ${messages.utc}`)]

  // No line of it starts or ends on a separator, however it wraps.
  return (
    <div className="text-xs leading-5 text-muted-foreground">
      <MetaItems
        items={[
          <span key="label" className="text-foreground/80">
            {messages.connection.label}
          </span>,
          ...facts,
          <ConnectionStatus key="status" status={connection.status} />,
        ]}
      />
    </div>
  )
}

export function ConnectionStatus({ status }: { readonly status: Connection["status"] }) {
  const messages = useActivityMessages().connection.status
  const tone = status === "active" ? "ok" : status === "revoked" ? "error" : "muted"
  return <Pill tone={tone}>{messages[status]}</Pill>
}

/**
 * A shared link by its share definition, or by the end of its grant id once the grant is gone; the
 * full id is the element's title.
 */
export function sharedLinkName(
  link: { readonly grantId: string; readonly definitionId?: string },
  messages: ActivityMessages["visits"]
): string {
  return (
    link.definitionId ?? messages.sharedLinkId(link.grantId.replace(/[^a-zA-Z0-9]/g, "").slice(-6))
  )
}

/** "Chrome · macOS", a native client's own label, or Unknown device. */
export function connectionDevice(
  connection: {
    readonly device: { readonly browser?: string; readonly os?: string }
    readonly clientName?: string
  },
  unknown: string
): string {
  if (connection.clientName) {
    return connection.clientName
  }

  const parts = [connection.device.browser, connection.device.os].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : unknown
}

function entryKey(entry: Entry): string {
  return entry.kind === "page" || entry.kind === "interaction"
    ? `${entry.kind}:${entry.sequence}`
    : `execution:${entry.executionId}`
}
