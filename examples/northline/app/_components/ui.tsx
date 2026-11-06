import { Skeleton } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import type { PropsWithChildren, ReactNode } from "react"

const critical = new Set([
  "critical",
  "breached",
  "failed",
  "unhealthy",
  "offline",
  "emergency",
  "not_covered",
  "declined",
])
const warning = new Set([
  "high",
  "urgent",
  "at_risk",
  "watch",
  "awaiting_authorization",
  "internal_review",
  "sent",
  "paused",
  "partial",
  "expiring",
  "awaiting_parts",
  "follow_up_required",
])
const success = new Set([
  "healthy",
  "approved",
  "resolved",
  "closed",
  "completed",
  "met",
  "covered",
  "available",
  "active",
  "resolved_on_site",
  "on_track",
])
const info = new Set([
  "dispatching",
  "in_service",
  "dispatched",
  "scheduled",
  "assigned",
  "en_route",
  "on_site",
  "in_progress",
  "triage",
  "new",
])

export type Tone = "critical" | "warning" | "success" | "info" | "neutral"

export function statusTone(status: string | undefined): Tone {
  const value = status ?? "unknown"
  if (critical.has(value)) return "critical"
  if (warning.has(value)) return "warning"
  if (success.has(value)) return "success"
  if (info.has(value)) return "info"
  return "neutral"
}

const toneStyles: Record<Tone, { dot: string; text: string; pill: string }> = {
  critical: {
    dot: "bg-destructive",
    text: "text-destructive",
    pill: "bg-[color-mix(in_srgb,var(--destructive)_11%,transparent)] text-destructive",
  },
  warning: {
    dot: "bg-[color:var(--warning)]",
    text: "text-[color:var(--warning)]",
    pill: "bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[color:var(--warning)]",
  },
  success: {
    dot: "bg-[color:var(--success)]",
    text: "text-[color:var(--success)]",
    pill: "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[color:var(--success)]",
  },
  info: {
    dot: "bg-[color:var(--info)]",
    text: "text-[color:var(--info)]",
    pill: "bg-[color-mix(in_srgb,var(--info)_11%,transparent)] text-[color:var(--info)]",
  },
  neutral: {
    dot: "bg-muted-foreground/60",
    text: "text-muted-foreground",
    pill: "bg-muted text-muted-foreground",
  },
}

/** A state as a tinted pill: the word carries the meaning, the tint only supports it. */
export function StatusBadge({ value, label }: { value: string | undefined; label?: string }) {
  const status = value ?? "unknown"
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-[12px] font-semibold whitespace-nowrap",
        toneStyles[statusTone(status)].pill
      )}
    >
      {label ?? humanize(status)}
    </span>
  )
}

export function StatusIndicator({
  value,
  label,
  className = "",
}: {
  value: string | undefined
  label?: string
  className?: string
}) {
  const status = value ?? "unknown"
  const tone = toneStyles[statusTone(status)]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[13px] font-medium whitespace-nowrap",
        tone.text,
        className
      )}
    >
      <span className={cn("size-2 rounded-full", tone.dot)} aria-hidden="true" />
      {label ?? humanize(status)}
    </span>
  )
}

/** The large title every page opens with; the eyebrow is a quiet breadcrumb above it. */
export function PageHeader({
  title,
  description,
  action,
  eyebrow,
  children,
}: PropsWithChildren<{
  title: string
  description?: ReactNode
  action?: ReactNode
  eyebrow?: ReactNode
}>) {
  return (
    <header className="mb-8 flex flex-col gap-5">
      <div className="flex items-start justify-between gap-6 max-sm:flex-col max-sm:gap-4">
        <div className="min-w-0">
          {eyebrow ? <div className="mb-2 text-[14px] text-muted-foreground">{eyebrow}</div> : null}
          <h1 className="text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance text-foreground sm:text-[40px]">
            {title}
          </h1>
          {description ? (
            <p className="mt-2 max-w-3xl text-[16px] leading-6 text-pretty text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? (
          <div className="flex shrink-0 items-center gap-2 max-sm:w-full">{action}</div>
        ) : null}
      </div>
      {children}
    </header>
  )
}

/** A labelled value in a record's facts row; place it inside a `<dl>`. */
export function Fact({ label, children }: PropsWithChildren<{ label: string }>) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-[14.5px] font-medium tabular-nums">{children}</dd>
    </div>
  )
}

/** A white card on the page ground. Rows inside use `px-6` and a hairline between them. */
export function Section({
  title,
  description,
  action,
  children,
  className = "",
}: PropsWithChildren<{
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}>) {
  return (
    <section className={cn("rounded-[20px] bg-card shadow-[var(--shadow-card)]", className)}>
      {title || action ? (
        <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-[19px] leading-6 font-semibold tracking-[-0.015em]">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-1 text-[13.5px] leading-5 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0 pt-0.5 text-[14px]">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

/** One headline number with what it means underneath. */
export function StatTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: Tone
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-[18px] bg-card px-5 py-4 shadow-[var(--shadow-card)]">
      <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
      <span className="text-[30px] leading-9 font-semibold tracking-[-0.02em] text-foreground">
        {value}
      </span>
      {detail ? (
        <span
          className={cn(
            "truncate text-[13px]",
            tone ? toneStyles[tone].text : "text-foreground/75"
          )}
        >
          {detail}
        </span>
      ) : null}
    </div>
  )
}

export function QueryState({
  loading,
  error,
  empty,
  emptyMessage,
  children,
}: PropsWithChildren<{
  loading: boolean
  error: boolean
  empty: boolean
  emptyMessage: string
}>) {
  if (loading) {
    return (
      <div className="grid gap-2 p-4" aria-label="Loading">
        {[0, 1, 2].map((value) => (
          <Skeleton key={value} className="h-14 w-full rounded-[14px]" />
        ))}
      </div>
    )
  }
  if (error) {
    return (
      <p role="alert" className="px-6 py-10 text-center text-[14px] text-destructive">
        Northline data could not be loaded. Try again.
      </p>
    )
  }
  if (empty) {
    return (
      <p className="px-6 py-12 text-center text-[14px] text-muted-foreground">{emptyMessage}</p>
    )
  }
  return children
}

export function humanize(value: string): string {
  const words = value.replaceAll("_", " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function formatDate(value: string | Date | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(calendarDate(value))
}

/**
 * A date to show or count by. A date without a time, such as a quote's valid-until day, is that day
 * where the reader is; `new Date("2026-11-20")` would be UTC midnight, the evening before in the US.
 */
export function calendarDate(value: string | Date): Date {
  if (typeof value === "string") {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
  }
  return new Date(value)
}

export function formatTime(value: string | Date | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(value))
}

export function formatRelativeTime(value: string | Date | undefined): string {
  if (!value) return "No recent signal"
  const difference = Date.now() - new Date(value).getTime()
  const minutes = Math.max(0, Math.round(difference / 60_000))
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** A moment in words close to now: "Today, 6:49 PM", "Tomorrow, 9:00 AM", "Nov 3, 2:15 PM". */
export function formatDateTime(value: string | Date | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date)
  const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000)
  if (days === 0) return `Today, ${time}`
  if (days === -1) return `Yesterday, ${time}`
  if (days === 1) return `Tomorrow, ${time}`
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(date)
  return `${day}, ${time}`
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** A span of minutes as a contract states it: "45 min", "1.5 hr", "4 hr". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr`
}

/** Whole days from today to a date; negative once it has passed, infinity without one. */
export function daysUntil(value: string | Date | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = calendarDate(value)
  target.setHours(0, 0, 0, 0)
  // Rounded, not ceiled: a day across a clock change is 23 or 25 hours.
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

export function formatMoney(value: number | undefined): string {
  return value === undefined
    ? "—"
    : new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: value % 1 === 0 ? 0 : 2,
      }).format(value)
}

export interface CaseClockFields {
  readonly status?: string
  readonly slaStatus?: string
  readonly responseDeadline?: string | Date
  readonly resolutionDeadline?: string | Date
}

export interface CaseClock {
  /** Which commitment is running: "Response", "Resolution" or "Commitment" once it is over. */
  readonly label: string
  /** The clock on its own, for a labelled fact: "47m left", "2h overdue", "Met". */
  readonly value: string
  /** The clock as a phrase, for rows that have no label: "47m to respond". */
  readonly summary: string
  readonly tone: Tone
  /** When the running commitment falls due, for sorting; infinity once it is over. */
  readonly dueAt: number
}

const awaitingResponse = new Set(["new", "triage", "dispatching"])
const finished = new Set(["resolved", "closed", "cancelled"])

/**
 * The commitment that matters at a case's stage. Until a technician is on site the customer is
 * waiting on a response; after that, on a resolution, which pauses while the customer authorizes
 * a repair; once resolved, the commitment was met or missed.
 */
export function caseClock(serviceCase: CaseClockFields): CaseClock {
  const status = serviceCase.status ?? "new"
  const atRisk = serviceCase.slaStatus === "at_risk" || serviceCase.slaStatus === "breached"
  if (finished.has(status)) {
    const missed = serviceCase.slaStatus === "breached"
    return {
      label: "Commitment",
      value: missed ? "Missed" : "Met",
      summary: missed ? "Commitment missed" : "Commitment met",
      tone: missed ? "critical" : "neutral",
      dueAt: Number.POSITIVE_INFINITY,
    }
  }

  // Contracts stop the resolution clock while the customer decides on work outside coverage.
  if (status === "awaiting_authorization") {
    return {
      label: "Resolution",
      value: "Paused",
      summary: "Waiting on the customer",
      tone: "neutral",
      dueAt: Number.POSITIVE_INFINITY,
    }
  }

  const responding = awaitingResponse.has(status)
  const label = responding ? "Response" : "Resolution"
  const deadline = responding ? serviceCase.responseDeadline : serviceCase.resolutionDeadline
  if (!deadline) {
    const dueAt = Number.POSITIVE_INFINITY
    return { label, value: "No deadline", summary: "No deadline", tone: "neutral", dueAt }
  }

  const dueAt = new Date(deadline).getTime()
  const remaining = dueAt - Date.now()
  const duration = formatDuration(Math.abs(remaining))
  if (remaining < 0) {
    return {
      label,
      value: `${duration} overdue`,
      summary: `${label} ${duration} overdue`,
      tone: "critical",
      dueAt,
    }
  }
  return {
    label,
    value: `${duration} left`,
    summary: `${duration} to ${responding ? "respond" : "resolve"}`,
    tone: atRisk ? "warning" : "neutral",
    dueAt,
  }
}

/** At risk is what the clock shows: overdue, or flagged by the contract while time remains. */
export function isCaseAtRisk(serviceCase: CaseClockFields): boolean {
  return caseClock(serviceCase).tone !== "neutral"
}

/** A case's clock in its tone; neutral clocks take the surrounding text color. */
export function CaseClockText({
  serviceCase,
  variant = "summary",
  className,
}: {
  serviceCase: CaseClockFields
  variant?: "summary" | "value"
  className?: string
}) {
  const clock = caseClock(serviceCase)
  return (
    <span
      // The tone comes last so it wins over a caller's text color; a neutral clock keeps theirs.
      className={cn(
        "tabular-nums",
        className,
        clock.tone === "neutral" ? undefined : toneStyles[clock.tone].text
      )}
    >
      {clock[variant]}
    </span>
  )
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** Up to two initials for an avatar: "Marcus Reed" becomes "MR". */
export function initials(name: string | undefined): string {
  return (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase()
}
