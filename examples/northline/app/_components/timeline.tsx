import { cn } from "@sixb/ui/lib/utils"
import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { formatDateTime, StatusBadge } from "./ui"

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
                  {timeLabel(entry.at)}
                </time>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
}

function time(value: string | Date | undefined): number {
  if (!value) return 0
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

function dayLabel(value: string | Date | undefined): string {
  if (!value) return "Undated"
  const date = new Date(value)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)
}

function timeLabel(value: string | Date | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const today = date.toDateString() === new Date().toDateString()
  if (today) return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date)
  return sameYear
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
    : formatDateTime(date)
}
