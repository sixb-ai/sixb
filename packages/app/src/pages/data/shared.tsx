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
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { Cable, CalendarClock, DatabaseZap } from "lucide-react"
import type { ComponentType, ReactNode } from "react"
import { SectionPage } from "../section-page"
import {
  apiErrorMessage,
  CopyButton,
  MetaDot,
  Panel,
  PanelEmpty,
  PanelSkeleton,
  Pill,
  type Tone,
} from "../section-ui"
import { useDataMessages } from "./messages"

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "superseded"

const statusTones: Record<RunStatus, Tone> = {
  queued: "muted",
  running: "info",
  succeeded: "ok",
  failed: "error",
  cancelled: "warn",
  superseded: "muted",
}

/** A run's status as a pill. */
export function RunStatusPill({ status }: { readonly status: RunStatus }) {
  const messages = useDataMessages().status
  return <Pill tone={statusTones[status]}>{messages[status]}</Pill>
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

// Keyed by the adapter `type` each `@sixb/connector-*` package declares; the files live in
// `assets/connector-icons/`. Any other type, such as a project's own connector, gets a plug.
const connectorIconFiles: Readonly<Record<string, string>> = {
  "ace-iot": "ace-iot.ico",
  companycam: "companycam.png",
  exa: "exa.png",
  github: "github.svg",
  google: "google.ico",
  "google-ads": "googleads.svg",
  linkedin: "linkedin.svg",
  mercury: "mercury.svg",
  meta: "meta.svg",
  microsoft: "microsoft.ico",
  notion: "notion.svg",
  pandadoc: "pandadoc.png",
  pennylane: "pennylane.ico",
  pipedrive: "pipedrive.png",
  plaud: "plaud.png",
  quickbooks: "quickbooks.svg",
  stripe: "stripe.svg",
  teamleader: "teamleader.ico",
  tiktok: "tiktok.svg",
  unipile: "unipile.png",
}

/**
 * A connector's brand mark on a white tile, in both themes since several marks are black. Unknown
 * types get a plug.
 */
export function ConnectorIcon({
  type,
  size = "md",
}: {
  readonly type: string
  readonly size?: "md" | "lg"
}) {
  const file = Object.hasOwn(connectorIconFiles, type) ? connectorIconFiles[type] : undefined
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center border border-border shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]",
        size === "lg" ? "size-12 rounded-xl" : "size-9 rounded-lg",
        file ? "bg-white" : "bg-background text-muted-foreground"
      )}
    >
      {file ? (
        <img
          src={`/__sixb/assets/connector-icons/${file}`}
          alt=""
          draggable={false}
          className="size-[55%] object-contain"
        />
      ) : (
        <Cable className={size === "lg" ? "size-5" : "size-4"} />
      )}
    </span>
  )
}

/** The runtime answers 501 when nothing records this history: neither empty nor broken. */
/**
 * A detail page while its subject loads, or once it could not be: "Not found" for a 404 alone, so
 * a refusal or an outage says what it is.
 */
export function DetailFallback({
  page,
  back,
  name,
  id,
  icon,
  error,
}: {
  readonly page: string
  readonly back: { readonly href: string; readonly label: string }
  /** The title while it loads. */
  readonly name: string
  readonly id: string
  readonly icon: ComponentType<{ readonly className?: string }>
  /** `null` while it loads. */
  readonly error: unknown
}) {
  const messages = useDataMessages().common
  const missing = isSixbApiError(error) && error.status === 404
  const title = missing ? messages.notFoundTitle : messages.unavailableTitle
  return (
    <SectionPage section="data" page={page} back={back} title={error ? title : name}>
      <Panel>
        {error ? (
          <PanelEmpty
            tone="error"
            icon={icon}
            title={title}
            description={
              missing ? messages.notFound(id) : apiErrorMessage(error, messages.tryAgain)
            }
          />
        ) : (
          <PanelSkeleton rows={2} />
        )}
      </Panel>
    </SectionPage>
  )
}

export function isUnrecorded(error: unknown): boolean {
  return isSixbApiError(error) && error.status === 501
}

/** Shown when a run history is not recorded because no storage keeps it. */
export function UnrecordedHistory({ what }: { readonly what: string }) {
  const messages = useDataMessages().unrecorded
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
  const messages = useDataMessages().failure
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

/** The schedule that starts something, on a row's second line. */
export function ScheduleMeta({ id }: { readonly id: string }) {
  const messages = useDataMessages().common
  return (
    <>
      <MetaDot />
      <span className="inline-flex min-w-0 items-center gap-1" title={messages.schedule}>
        <CalendarClock className="size-3.5 shrink-0" />
        <span className="truncate">{id}</span>
      </span>
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
