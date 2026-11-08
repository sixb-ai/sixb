import { cn } from "@sixb/ui/lib/utils"
import { ClipboardCheck, type LucideIcon, ShieldCheck, Wrench } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { quotePath } from "../_lib/quotes"
import { formatMoney, formatTime, StatusBadge } from "./ui"

export interface TimelineEntry {
  readonly id: string
  readonly at: string | Date | undefined
  readonly icon: LucideIcon
  readonly title: string
  readonly detail?: string
  /** Where the entry came from, such as "Building controls" or "Field service". */
  readonly source?: string
  readonly status?: string
  /** A dark icon marks the entries that matter most, such as the alarm that opened a case. */
  readonly emphasis?: boolean
  readonly action?: ReactNode
}

/** Everything that happened to a record, newest first, grouped by day. */
export function Timeline({
  entries,
  limit,
}: {
  entries: readonly TimelineEntry[]
  limit?: number
}) {
  const sorted = [...entries].sort((left, right) => time(right.at) - time(left.at))
  const visible = limit ? sorted.slice(0, limit) : sorted
  const groups: Array<{ day: string; entries: TimelineEntry[] }> = []
  for (const entry of visible) {
    const day = dayLabel(entry.at)
    const last = groups.at(-1)
    if (last && last.day === day) last.entries.push(entry)
    else groups.push({ day, entries: [entry] })
  }

  if (visible.length === 0) {
    return <p className="px-6 pt-2 pb-7 text-[14px] text-muted-foreground">Nothing yet.</p>
  }

  return (
    <div className="px-6 pb-3">
      {groups.map((group) => (
        <div key={group.day}>
          <p className="pt-3 pb-1 text-[12px] font-semibold text-muted-foreground">{group.day}</p>
          <ol>
            {group.entries.map((entry) => (
              <li
                key={entry.id}
                className="grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-3.5 border-t border-border/70 py-3.5"
              >
                <span
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full",
                    entry.emphasis ? "bg-foreground text-background" : "bg-muted text-foreground/70"
                  )}
                >
                  <entry.icon className="size-4" strokeWidth={1.8} />
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-[15px] leading-5 font-semibold">{entry.title}</span>
                  {entry.detail ? (
                    <span className="text-[14px] leading-[1.45] text-pretty text-foreground/80">
                      {entry.detail}
                    </span>
                  ) : null}
                  {entry.source || entry.status ? (
                    <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
                      {entry.source ? <span>{entry.source}</span> : null}
                      {entry.status ? <StatusBadge value={entry.status} /> : null}
                    </span>
                  ) : null}
                  {entry.action}
                </span>
                <time className="pt-0.5 text-[13px] whitespace-nowrap text-muted-foreground tabular-nums">
                  {entry.at ? formatTime(entry.at) : ""}
                </time>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
}

interface VisitFields {
  readonly primaryId: string
  readonly properties: {
    readonly number: string
    readonly scheduledStart?: string | Date
    readonly startedAt?: string | Date
    readonly completedAt?: string | Date
    readonly workPerformed?: string
    readonly completionDisposition?: string
  }
}

/** A visit's start and, once done, its completion; `detail` says who went or for which case. */
export function visitEntries(visit: VisitFields, detail?: string): TimelineEntry[] {
  const { number, scheduledStart, startedAt, completedAt } = visit.properties
  const entries: TimelineEntry[] = [
    {
      id: `${visit.primaryId}-start`,
      at: startedAt ?? scheduledStart,
      icon: Wrench,
      title: `${number} ${startedAt ? "started" : "scheduled"}`,
      detail,
      source: "Field service",
    },
  ]
  if (completedAt) {
    entries.push({
      id: `${visit.primaryId}-complete`,
      at: completedAt,
      icon: ClipboardCheck,
      title: `${number} completed`,
      detail: visit.properties.workPerformed,
      source: "Field service",
      status: visit.properties.completionDisposition,
    })
  }
  return entries
}

interface QuoteFields {
  readonly primaryId: string
  readonly properties: {
    readonly number: string
    readonly amount: number
    readonly scope: string
    readonly status: string
    readonly decisionAt?: string | Date
    readonly sourceUpdatedAt?: string | Date
  }
}

/** A quote at its latest moment: decided, or last updated in the business system. */
export function quoteEntry(quote: QuoteFields): TimelineEntry {
  const { number, amount, scope, status, decisionAt, sourceUpdatedAt } = quote.properties
  return {
    id: quote.primaryId,
    at: decisionAt ?? sourceUpdatedAt,
    icon: ShieldCheck,
    title: `${number} · ${formatMoney(amount)}`,
    detail: scope,
    source: "Business system",
    status,
    action: <TimelineLink to={quotePath(quote.primaryId)}>Open quote</TimelineLink>,
  }
}

/** A link under an entry, such as to the record it is about. */
export function TimelineLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="w-fit text-[13px] font-medium text-primary hover:underline">
      {children}
    </Link>
  )
}

function time(value: string | Date | undefined): number {
  return value ? new Date(value).getTime() : 0
}

/** A day heading; another year's days carry the year, so two Octobers never share a group. */
function dayLabel(value: string | Date | undefined): string {
  if (!value) return "Undated"
  const date = new Date(value)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  const sameYear = date.getFullYear() === today.getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(date)
}
