import type { GetActivityVisitTimelineResponse } from "@sixb/client"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { Bot, FileText, type LucideIcon, MousePointerClick, Workflow, Zap } from "lucide-react"
import { Fragment, useMemo, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { actionRunHref, objectHref, observedThreadHref, workflowRunHref } from "../../routes"
import {
  formatDuration,
  humanize,
  MetaDot,
  Pill,
  RunStatusPill,
  ToolbarTabs,
  useNumbers,
} from "../../section-ui"
import { formatChartMoney, nanosToNumber } from "../usage/format"
import { useUtcFormat } from "./format"
import { type ActivityMessages, useActivityMessages } from "./messages"
import { MetaItems } from "./meta-items"
import { filterSteps, type VisitStep, visitSteps } from "./steps"

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

/**
 * What a visit did, as steps: each page view, with what happened while it was the last page
 * viewed. A filter by kind counts each and keeps the steps holding that kind.
 */
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

  const steps = useMemo(() => visitSteps(timeline), [timeline])
  const shown = filterSteps(steps, filter)

  return (
    <>
      <div className="border-b border-border px-3 py-2">
        {/* Every kind stays in sight: the chips wrap instead of scrolling. */}
        <ToolbarTabs
          className="flex-wrap gap-y-1"
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
        <ol aria-label={messages.steps.label} className="py-1.5">
          {shown.map((step, index) => (
            <StepRow key={step.key} step={step} time={time} joined={index < shown.length - 1} />
          ))}
        </ol>
      )}
    </>
  )
}

/**
 * A page view on a line joining it to the next, then what happened while it was the last page
 * viewed. A route viewed before says how many times.
 */
function StepRow({
  step,
  time,
  joined,
}: {
  readonly step: VisitStep
  readonly time: (value: string) => string
  /** Whether a line runs down to the next step shown. */
  readonly joined: boolean
}) {
  const messages = useActivityMessages().visit.steps

  return (
    <li className="relative flex items-start gap-3 px-4 py-2">
      {/* From this step's dot to the next one's, which covers its end. */}
      {joined ? (
        <span
          aria-hidden
          className="absolute top-[1.0625rem] -bottom-[1.0625rem] left-[1.28rem] w-px bg-border"
        />
      ) : null}
      <span
        aria-hidden
        className={cn(
          "relative mt-1.5 size-2.5 shrink-0 rounded-full border-2 bg-card",
          step.page ? "border-foreground/70" : "border-dashed border-muted-foreground/60"
        )}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {step.page ? (
            <RoutePattern route={step.page.route} className="font-medium" />
          ) : (
            <span className="text-[0.8125rem] font-medium text-muted-foreground italic">
              {messages.earlier}
            </span>
          )}
          {step.view > 1 ? (
            <span className="text-xs text-muted-foreground">
              <span aria-hidden>↩ </span>
              {messages.again(step.view)}
            </span>
          ) : null}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            <time dateTime={step.at}>{time(step.at)}</time>
            <StepDuration step={step} />
          </span>
        </div>

        {step.entries.length > 0 ? (
          <ol className="flex flex-col">
            {step.entries.map((entry) => (
              <EntryRow key={entryKey(entry)} entry={entry} time={time} route={step.page?.route} />
            ))}
          </ol>
        ) : null}
      </div>
    </li>
  )
}

/** How long the step lasted; the visit's last says it ended there. */
function StepDuration({ step }: { readonly step: VisitStep }) {
  const messages = useActivityMessages().visit.steps
  if (step.until === null) {
    return null
  }

  // Under a second, the last step is only where the visit ended.
  const brief = Date.parse(step.until) - Date.parse(step.at) < 1000
  const duration = step.last && brief ? null : formatDuration(step.at, step.until)
  const text = [duration, step.last ? messages.end : null].filter(Boolean).join(" · ")

  return <> · {text}</>
}

/** What happened during a step, at its time in the visit. */
function EntryRow({
  entry,
  time,
  route,
}: {
  readonly entry: Entry
  readonly time: (value: string) => string
  /** The step's route: an interaction there need not repeat it. */
  readonly route: string | undefined
}) {
  const Icon = icons[entry.kind]

  return (
    <li className="flex items-start gap-3 py-1.5">
      <time
        dateTime={entry.at}
        className="min-w-16 shrink-0 pt-px text-xs text-muted-foreground tabular-nums"
      >
        {time(entry.at)}
      </time>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <EntryContent entry={entry} route={route} />
      </div>
    </li>
  )
}

function EntryContent({
  entry,
  route,
}: {
  readonly entry: Entry
  readonly route: string | undefined
}) {
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
          {entry.route === route ? null : (
            <RoutePattern route={entry.route} className="text-xs text-muted-foreground" />
          )}
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
            {entry.thread ? (
              <ConversationLink threadId={entry.threadId} title={entry.thread.title} />
            ) : (
              <span className="text-[0.8125rem] font-medium">{messages.agentRun}</span>
            )}
            <EntryStatus status={entry.status} />
          </div>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {entry.thread ? (
              <>
                <span>{messages.agentRun}</span>
                <MetaDot />
              </>
            ) : null}
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

/**
 * A conversation by its title, opening it read-only. Only a reader who may read it gets one: the
 * entry names its thread for them alone.
 */
function ConversationLink({
  threadId,
  title,
}: {
  readonly threadId: string
  readonly title: string | undefined
}) {
  const messages = useActivityMessages()
  const location = useLocation()
  const name = title?.trim() || messages.thread.untitled

  return (
    <Link
      to={observedThreadHref(threadId)}
      state={{ from: `${location.pathname}${location.search}` }}
      title={messages.visit.openConversation}
      className="min-w-0 truncate text-[0.8125rem] font-medium underline-offset-2 hover:underline"
    >
      {name}
    </Link>
  )
}

/** A run's name, linking to its page in Console › Runs when the viewer may read it. */
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
