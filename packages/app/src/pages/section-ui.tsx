/**
 * The building blocks every built-in section page shares: page blocks, panels of hairline rows,
 * pills, empty and loading states, the small form and copy controls, and how a run's status and
 * failure read. Every section is made of these, so they look and behave alike.
 */
import { isSixbApiError } from "@sixb/client"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@sixb/ui/components"
import { defineMessages, type MessageTree, type Translation, useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { Check, CircleAlert, Copy, DatabaseZap } from "lucide-react"
import { type ComponentType, type ReactNode, useMemo, useState } from "react"
import { Link } from "react-router-dom"

type Icon = ComponentType<{ readonly className?: string }>

export const en = {
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Copying failed. Select the text and copy it by hand.",
  unknown: "Unknown",
  notFoundTitle: "Not found",
  notFound: (id: string) => `Nothing is called “${id}”. It may have been renamed or removed.`,
  unavailableTitle: "Could not load",
  deniedTitle: "No access",
  denied: "Your role does not allow this. Ask an admin if you should have it.",
  tryAgain: "Try again in a moment.",
  status: {
    queued: "Queued",
    running: "Running",
    waiting: "Waiting",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    superseded: "Superseded",
  },
  unrecorded: {
    title: (what: string) => `${what} are not recorded`,
    description:
      "This project's storage keeps no run history. Runs still happen; configure storage that records them to see them here.",
  },
  failure: {
    viewDetails: "Details",
    title: "What went wrong",
    occurredAt: "Occurred",
    upstreamStatus: "Upstream status",
    retry: "Retry",
    retryable: "Sixb retries this",
    notRetryable: "Not retried",
    redacted: "Some details were removed because they may hold secrets.",
    truncated: "The details were cut short because they were too long.",
    copyHint: "Copy everything to share it.",
  },
} satisfies MessageTree

export const fr: Translation<typeof en> = {
  copy: "Copier",
  copied: "Copié",
  copyFailed: "La copie a échoué. Sélectionnez le texte et copiez-le à la main.",
  unknown: "Inconnu",
  notFoundTitle: "Introuvable",
  notFound: (id: string) => `Rien ne s’appelle « ${id} ». Il a peut-être été renommé ou supprimé.`,
  unavailableTitle: "Chargement impossible",
  deniedTitle: "Accès refusé",
  denied:
    "Votre rôle ne le permet pas. Demandez à un administrateur si vous devriez y avoir accès.",
  tryAgain: "Réessayez dans un instant.",
  status: {
    queued: "En file",
    running: "En cours",
    waiting: "En attente",
    succeeded: "Réussi",
    failed: "Échec",
    cancelled: "Annulé",
    superseded: "Remplacé",
  },
  unrecorded: {
    title: (what: string) => `${what} : non enregistrées`,
    description:
      "Le stockage de ce projet ne conserve pas l’historique des exécutions. Elles ont bien lieu ; configurez un stockage qui les enregistre pour les voir ici.",
  },
  failure: {
    viewDetails: "Détails",
    title: "Ce qui s’est mal passé",
    occurredAt: "Survenu",
    upstreamStatus: "Statut du service",
    retry: "Nouvel essai",
    retryable: "Sixb réessaie",
    notRetryable: "Pas de nouvel essai",
    redacted: "Certains détails ont été retirés car ils pouvaient contenir des secrets.",
    truncated: "Les détails ont été tronqués car ils étaient trop longs.",
    copyHint: "Copiez le tout pour le partager.",
  },
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

/** Counts and sizes in the reader's locale. */
export function useNumbers() {
  const locale = useLocale()
  const integer = new Intl.NumberFormat(locale)
  return {
    count: (value: number | undefined) => (typeof value === "number" ? integer.format(value) : "—"),
    bytes(value: number | undefined): string {
      if (typeof value !== "number") return "—"
      if (value === 0) return "0 B"
      const units = ["B", "KB", "MB", "GB", "TB"]
      const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
      const scaled = value / 1024 ** index
      const digits = scaled >= 10 || index === 0 ? 0 : 1
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(scaled)} ${units[index]}`
    },
  }
}

/**
 * What to say when something could not be loaded: "Not found" for a 404, "No access" for a 403, and
 * the server's reason otherwise. A refusal names the grant it takes rather than repeat the server's
 * message, which is written for logs and names the principal.
 */
export function useLoadFailure(
  error: unknown,
  options: {
    /** What was asked for, for "Nothing is called …". */
    readonly id?: string
    /** What a refused person lacks, such as "Seeing AI usage takes …". */
    readonly denied?: string
    /** What to say when the server gave no reason. */
    readonly fallback?: string
  } = {}
): { readonly title: string; readonly description: string } {
  const messages = useSectionUiMessages()
  if (isSixbApiError(error) && error.status === 404 && options.id !== undefined) {
    return { title: messages.notFoundTitle, description: messages.notFound(options.id) }
  }
  if (isSixbApiError(error) && error.status === 403) {
    return { title: messages.deniedTitle, description: options.denied ?? messages.denied }
  }
  return {
    title: messages.unavailableTitle,
    description: apiErrorMessage(error, options.fallback ?? messages.tryAgain),
  }
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
export function CopyButton({
  value,
  compact = false,
}: {
  readonly value: string
  /** Only the icon, named by its tooltip, for a spot beside an id or a value. */
  readonly compact?: boolean
}) {
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
      size={compact ? "icon-xs" : "sm"}
      onClick={copy}
      title={
        state === "failed"
          ? messages.copyFailed
          : compact
            ? messages[state === "copied" ? "copied" : "copy"]
            : undefined
      }
      aria-label={compact ? messages.copy : undefined}
      className="shrink-0 text-muted-foreground"
    >
      {state === "copied" ? <Check /> : <Copy />}
      {compact ? null : state === "copied" ? messages.copied : messages.copy}
    </Button>
  )
}

export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded"

const statusTones: Record<RunStatus, Tone> = {
  queued: "muted",
  running: "info",
  waiting: "warn",
  succeeded: "ok",
  failed: "error",
  cancelled: "warn",
  superseded: "muted",
}

/** A run's status as a pill. */
export function RunStatusPill({ status }: { readonly status: RunStatus }) {
  const messages = useSectionUiMessages().status
  return <Pill tone={statusTones[status]}>{messages[status]}</Pill>
}

/** The labels of run statuses, for a page that names one outside a pill. */
export function useRunStatusLabels() {
  return useSectionUiMessages().status
}

/** An identifier as words: `sync-satellite-orbit` → "Sync satellite orbit". */
export function humanize(id: string): string {
  const words = id
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id
}

/** How long something took, compactly: "<1s", "12s", "4m 30s", "2h 5m". */
export function formatDuration(
  startedAt: string | undefined,
  finishedAt: string | undefined
): string {
  if (!startedAt || !finishedAt) return "—"
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return "<1s"
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

export function isUnrecorded(error: unknown): boolean {
  return isSixbApiError(error) && error.status === 501
}

/** Shown when a run history is not recorded because no storage keeps it. */
export function UnrecordedHistory({ what }: { readonly what: string }) {
  const messages = useSectionUiMessages().unrecorded
  return (
    <PanelEmpty
      icon={DatabaseZap}
      title={messages.title(what)}
      description={messages.description}
    />
  )
}

interface Failure {
  readonly code: string
  readonly message: string
  readonly at?: string
  readonly httpStatus?: number
  readonly retryable?: boolean
  readonly redacted?: boolean
  readonly truncated?: boolean
  readonly details?: unknown
}

/** What went wrong, in red, with its code and a dialog of everything recorded about it. */
export function FailureSummary({
  failure,
  compact = false,
}: {
  readonly failure: Failure
  /** One line, for rows; the full message is in the dialog. */
  readonly compact?: boolean
}) {
  const messages = useSectionUiMessages().failure
  return (
    <div className="min-w-0">
      <p
        className={cn(
          "text-[0.8125rem] text-red-600 dark:text-red-400",
          compact ? "truncate" : "break-words whitespace-pre-wrap"
        )}
        title={compact ? failure.message : undefined}
      >
        {failure.message}
      </p>
      <div className="mt-0.5 flex items-center gap-2">
        <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
          {failure.code}
        </span>
        <Dialog>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-[0.6875rem] text-muted-foreground"
            >
              {messages.viewDetails}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85dvh] gap-5 overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{messages.title}</DialogTitle>
              <DialogDescription className="font-mono text-xs break-all">
                {failure.code}
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm leading-6 break-words whitespace-pre-wrap text-red-600 dark:text-red-400">
              {failure.message}
            </p>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[0.8125rem]">
              {failure.at ? (
                <Fact label={messages.occurredAt}>
                  <span className="font-mono text-xs">{failure.at}</span>
                </Fact>
              ) : null}
              {failure.httpStatus !== undefined ? (
                <Fact label={messages.upstreamStatus}>
                  <span className="font-mono text-xs">{failure.httpStatus}</span>
                </Fact>
              ) : null}
              {failure.retryable !== undefined ? (
                <Fact label={messages.retry}>
                  {failure.retryable ? messages.retryable : messages.notRetryable}
                </Fact>
              ) : null}
            </dl>
            {failure.details !== undefined ? (
              <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
                {JSON.stringify(failure.details, null, 2)}
              </pre>
            ) : null}
            {failure.redacted ? (
              <p className="text-xs text-muted-foreground">{messages.redacted}</p>
            ) : null}
            {failure.truncated ? (
              <p className="text-xs text-muted-foreground">{messages.truncated}</p>
            ) : null}
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CopyButton value={JSON.stringify(failure, null, 2)} />
              {messages.copyHint}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

/** A grid of figures at the top of a detail page, such as a run's status and duration. */
export function Stats({
  items,
}: {
  readonly items: readonly { readonly label: string; readonly value: ReactNode }[]
}) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] lg:grid-cols-4">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={cn(
            "min-w-0 border-border px-4 py-3.5 sm:px-5 sm:py-4",
            index % 2 === 1 && "border-l",
            index >= 2 && "border-t lg:border-t-0",
            index % 4 !== 0 && "lg:border-l"
          )}
        >
          <p className="text-xs text-muted-foreground">{item.label}</p>
          <div className="mt-1.5 min-w-0 truncate text-[0.9375rem] font-medium tabular-nums">
            {item.value}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Label and value rows in a panel, for an item's details. */
export function Facts({
  items,
}: {
  readonly items: readonly { readonly label: string; readonly value: ReactNode }[]
}) {
  return (
    <>
      {items.map((item) => (
        <div
          key={item.label}
          className="grid gap-1 px-5 py-3.5 text-[0.8125rem] sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6"
        >
          <span className="text-muted-foreground">{item.label}</span>
          <span className="min-w-0 break-words">{item.value}</span>
        </div>
      ))}
    </>
  )
}
