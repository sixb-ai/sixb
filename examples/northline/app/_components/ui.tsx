import { Alert, AlertDescription, Badge, Skeleton } from "@sixb/ui/components"
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
])

function statusTone(status: string) {
  if (critical.has(status)) {
    return {
      dot: "bg-destructive",
      text: "text-destructive",
      badge: "border-destructive/20 bg-destructive/10 text-destructive",
    }
  }
  if (warning.has(status)) {
    return {
      dot: "bg-[color:var(--warning)]",
      text: "text-[color:var(--warning)]",
      badge:
        "border-[color:var(--warning)]/20 bg-[color:var(--warning)]/10 text-[color:var(--warning)]",
    }
  }
  if (success.has(status)) {
    return {
      dot: "bg-[color:var(--success)]",
      text: "text-[color:var(--success)]",
      badge:
        "border-[color:var(--success)]/20 bg-[color:var(--success)]/10 text-[color:var(--success)]",
    }
  }
  if (info.has(status)) {
    return {
      dot: "bg-[color:var(--info)]",
      text: "text-[color:var(--info)]",
      badge: "border-[color:var(--info)]/20 bg-[color:var(--info)]/10 text-[color:var(--info)]",
    }
  }
  return {
    dot: "bg-muted-foreground/65",
    text: "text-muted-foreground",
    badge: "border-border bg-muted text-muted-foreground",
  }
}

export function StatusBadge({ value }: { value: string | undefined }) {
  const status = value ?? "unknown"
  const className = statusTone(status).badge
  return (
    <Badge variant="outline" className={`font-medium ${className}`}>
      {humanize(status)}
    </Badge>
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
  const tone = statusTone(status)
  return (
    <span
      className={`inline-flex items-center gap-2 text-xs font-medium ${tone.text} ${className}`}
    >
      <span className={`size-1.5 rounded-full ${tone.dot}`} aria-hidden="true" />
      {label ?? humanize(status)}
    </span>
  )
}

export function PageHeader({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string
  description?: string
  action?: ReactNode
  eyebrow?: string
}) {
  return (
    <header className="mb-7 flex items-start justify-between gap-5 max-sm:flex-col">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-2 text-[11px] font-semibold tracking-[0.16em] text-primary uppercase">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-[32px] leading-9 font-semibold tracking-[-0.035em] text-foreground max-sm:text-[28px]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </header>
  )
}

export function Section({
  title,
  action,
  children,
  className = "",
}: PropsWithChildren<{ title?: string; action?: ReactNode; className?: string }>) {
  return (
    <section className={`rounded-md border border-border/90 bg-card/80 ${className}`}>
      {title || action ? (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b border-border/80 px-4 py-2.5">
          {title ? <h2 className="text-sm font-semibold">{title}</h2> : <span />}
          {action}
        </header>
      ) : null}
      {children}
    </section>
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
      <div className="grid gap-2" aria-label="Loading">
        {[0, 1, 2].map((value) => (
          <Skeleton key={value} className="h-14 w-full rounded-md" />
        ))}
      </div>
    )
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Northline data could not be loaded. Try again.</AlertDescription>
      </Alert>
    )
  }
  if (empty) {
    return <p className="px-4 py-12 text-center text-sm text-muted-foreground">{emptyMessage}</p>
  }
  return children
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

export function formatDate(value: string | Date | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value))
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

export function formatDateTime(value: string | Date | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

export function formatMoney(value: number | undefined): string {
  return value === undefined
    ? "—"
    : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value)
}

export function deadlineLabel(value: string | Date | undefined): string {
  if (!value) return "No deadline"
  const difference = new Date(value).getTime() - Date.now()
  const minutes = Math.round(Math.abs(difference) / 60_000)
  if (minutes < 60) return difference < 0 ? `${minutes}m overdue` : `${minutes}m remaining`
  const hours = Math.round(minutes / 60)
  return difference < 0 ? `${hours}h overdue` : `${hours}h remaining`
}
