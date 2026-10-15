/**
 * The building blocks every built-in section page shares: page blocks, panels of hairline rows,
 * pills, empty and loading states, and the small form and copy controls. Settings and Data are made
 * of these, so they look and behave alike.
 */
import { isSixbApiError } from "@sixb/client"
import { Button } from "@sixb/ui/components"
import { defineMessages, type MessageTree, type Translation, useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { Check, CircleAlert, Copy } from "lucide-react"
import { type ComponentType, type ReactNode, useMemo, useState } from "react"
import { Link } from "react-router-dom"

type Icon = ComponentType<{ readonly className?: string }>

export const en = {
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Copying failed. Select the text and copy it by hand.",
  unknown: "Unknown",
} satisfies MessageTree

export const fr: Translation<typeof en> = {
  copy: "Copier",
  copied: "Copié",
  copyFailed: "La copie a échoué. Sélectionnez le texte et copiez-le à la main.",
  unknown: "Inconnu",
}

const sectionUiMessages = defineMessages<typeof en>({ en, fr })
const useSectionUiMessages = sectionUiMessages.useMessages

/**
 * What the API said went wrong, for a person to read: the server's own message, or `fallback`
 * when it gave none. The client's error message names the request and status, which is for logs.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const body = isSixbApiError(error) ? error.body : error
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error.trim() || fallback
  }
  return fallback
}

/** Dates and times in the reader's locale. */
export function useFormat() {
  const locale = useLocale()
  const unknown = useSectionUiMessages().unknown
  return useMemo(() => {
    const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
    const parse = (timestamp: string) => {
      const date = new Date(timestamp)
      return Number.isNaN(date.getTime()) ? null : date
    }
    return {
      date(timestamp: string): string {
        const date = parse(timestamp)
        if (!date) return unknown
        return date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })
      },
      dateTime(timestamp: string): string {
        const date = parse(timestamp)
        if (!date) return unknown
        return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
      },
      /** "now", "5 minutes ago", "yesterday", in the reader's language. */
      relative(timestamp: string): string {
        const date = parse(timestamp)
        if (!date) return unknown
        const seconds = Math.round((date.getTime() - Date.now()) / 1000)
        const minutes = Math.round(seconds / 60)
        const hours = Math.round(minutes / 60)
        const days = Math.round(hours / 24)
        if (Math.abs(seconds) < 60) return relativeFormat.format(0, "second")
        if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute")
        if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour")
        return relativeFormat.format(days, "day")
      },
    }
  }, [locale, unknown])
}

// ---------------------------------------------------------------------------
// Layout: a page is a stack of blocks, each a small heading over a panel of hairline rows.
// ---------------------------------------------------------------------------

/** A titled block of a section page: heading and actions over its panel. */
export function PageSection({
  title,
  description,
  action,
  children,
}: {
  readonly title?: string
  readonly description?: string
  readonly action?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      {title || action ? (
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-[0.9375rem] leading-6 font-semibold tracking-[-0.01em]">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="text-[0.8125rem] leading-5 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}

/** A white card on the page's sheet. Rows inside are separated by hairlines. */
export function Panel({
  toolbar,
  footer,
  children,
}: {
  readonly toolbar?: ReactNode
  readonly footer?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]">
      {toolbar ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          {toolbar}
        </div>
      ) : null}
      <div className="divide-y divide-border">{children}</div>
      {footer ? (
        <div className="border-t border-border bg-muted/40 px-5 py-3 text-[0.8125rem] leading-5 text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  )
}

/**
 * One row of a panel: a leading mark, its text, and trailing actions. With `href` or `onClick` the
 * row's text opens something; trailing actions stay their own targets.
 */
export function PanelRow({
  leading,
  title,
  meta,
  trailing,
  href,
  onClick,
  muted,
  children,
}: {
  readonly leading?: ReactNode
  readonly title: ReactNode
  readonly meta?: ReactNode
  readonly trailing?: ReactNode
  readonly href?: string
  readonly onClick?: () => void
  readonly muted?: boolean
  /**
   * Shown under the row's text, such as a failure. Only on a row without `href` or `onClick`: a
   * failure's Details button cannot sit inside a link or a button.
   */
  readonly children?: ReactNode
}) {
  const body = (
    <>
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className={cn("min-w-0 flex-1", muted && "opacity-60")}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          {title}
        </div>
        {meta ? (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[0.8125rem] text-muted-foreground">
            {meta}
          </div>
        ) : null}
        {children ? <div className="mt-2 min-w-0">{children}</div> : null}
      </div>
    </>
  )

  if (href || onClick) {
    const targetClass =
      "flex min-w-0 flex-1 items-center gap-3.5 py-3.5 pl-4 text-left outline-none focus-visible:bg-muted/60"
    return (
      <div className="group flex items-center gap-3 pr-3 transition-colors hover:bg-muted/40">
        {href ? (
          <Link to={href} className={targetClass}>
            {body}
          </Link>
        ) : (
          <button type="button" onClick={onClick} className={targetClass}>
            {body}
          </button>
        )}
        {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3.5 px-4 py-3.5">
      {body}
      {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
    </div>
  )
}

/** Separates the facts on a row's second line. */
export function MetaDot() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  )
}

/** A small tile holding an icon, leading a row or an empty state. */
export function IconTile({
  icon: Icon,
  size = "md",
}: {
  readonly icon: Icon
  readonly size?: "md" | "lg"
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center border border-border bg-background text-muted-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]",
        size === "lg" ? "size-11 rounded-xl" : "size-9 rounded-lg"
      )}
    >
      <Icon className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  )
}

export type Tone = "ok" | "warn" | "error" | "info" | "muted"

const toneClasses: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
  info: "bg-sky-500",
  muted: "bg-muted-foreground/50",
}

/** A short status in a quiet pill, led by a colored dot unless `tone` is omitted. */
export function Pill({ tone, children }: { readonly tone?: Tone; readonly children: ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2 text-[0.6875rem] font-medium whitespace-nowrap text-foreground/75">
      {tone ? (
        <span aria-hidden className={cn("size-1.5 rounded-full", toneClasses[tone])} />
      ) : null}
      {children}
    </span>
  )
}

/** The panel body while its rows load. */
export function PanelSkeleton({ rows = 3 }: { readonly rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3.5 px-4 py-3.5">
          <span className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3 w-40 animate-pulse rounded bg-muted" />
            <span className="h-2.5 w-64 max-w-full animate-pulse rounded bg-muted/70" />
          </span>
        </div>
      ))}
    </>
  )
}

/** What a panel shows with nothing in it, or when it could not load. */
export function PanelEmpty({
  icon,
  title,
  description,
  action,
  tone = "muted",
}: {
  readonly icon: Icon
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
  readonly tone?: "muted" | "error"
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {tone === "error" ? (
        <IconTile icon={CircleAlert} size="lg" />
      ) : (
        <IconTile icon={icon} size="lg" />
      )}
      <p className="mt-4 text-sm font-medium">{title}</p>
      {description ? (
        <p className="mt-1 max-w-[44ch] text-[0.8125rem] leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

/** Segmented tabs in a panel's toolbar, each with a count. */
export function ToolbarTabs<TTab extends string>({
  tabs,
  value,
  onChange,
}: {
  readonly tabs: readonly { readonly id: TTab; readonly label: string; readonly count?: number }[]
  readonly value: TTab
  readonly onChange: (tab: TTab) => void
}) {
  return (
    <div role="tablist" className="flex items-center gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[0.8125rem] font-medium transition-colors",
            value === tab.id
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
        >
          {tab.label}
          {tab.count === undefined ? null : (
            <span className="text-xs text-muted-foreground tabular-nums">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/** A form field: label, control, optional hint. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: ReactNode
  readonly htmlFor?: string
  readonly hint?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-[0.8125rem] font-medium">
          {label}
        </label>
      ) : (
        <span className="text-[0.8125rem] font-medium">{label}</span>
      )}
      {children}
      {hint ? <p className="text-xs leading-4 text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** Copies `value`, says so for a moment, and explains when the browser refuses. */
export function CopyButton({ value }: { readonly value: string }) {
  const messages = useSectionUiMessages()
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setState("copied")
      window.setTimeout(() => setState("idle"), 1600)
    } catch {
      setState("failed")
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={copy}
      title={state === "failed" ? messages.copyFailed : undefined}
      className="shrink-0 text-muted-foreground"
    >
      {state === "copied" ? <Check /> : <Copy />}
      {state === "copied" ? messages.copied : messages.copy}
    </Button>
  )
}
