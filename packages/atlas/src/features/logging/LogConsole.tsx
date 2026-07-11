import { useSixbLogs } from "@sixb/client/hooks"
import type { LogLevel, LogsBuilder, SixbLogLine } from "@sixb/client/logs"
import {
  Card,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"

/**
 * A live log console over a `logs` builder: loads retained history, tails new
 * lines, and pins to the newest line unless the reader scrolls up. Shared by the
 * Logs page. The parent sets the height through `className`.
 */
export interface LogConsoleProps {
  readonly builder: LogsBuilder
  /** Retained lines to load before tailing. */
  readonly history?: number
  /** Cap on accumulated lines. */
  readonly max?: number
  /** Show each line's run kind (mixed-kind views). */
  readonly showKind?: boolean
  /** Show each line's run id. */
  readonly showRun?: boolean
  readonly emptyLabel?: string
  /** Height (and any layout) for the console card. */
  readonly className?: string
}

export function LogConsole({
  builder,
  history,
  max,
  showKind = false,
  showRun = false,
  emptyLabel = "No logs recorded yet.",
  className,
}: LogConsoleProps) {
  const { lines, connected, error } = useSixbLogs(builder, { history, max })

  return (
    <Card className={cn("flex min-h-0 flex-col overflow-hidden p-0", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground tabular-nums">
          {lines.length === 0 ? "No lines" : `${lines.length} line${lines.length === 1 ? "" : "s"}`}
        </span>
        <ConnectionIndicator connected={connected} error={error} />
      </div>

      {lines.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <p className="text-sm text-muted-foreground">{error ?? emptyLabel}</p>
        </div>
      ) : (
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport className="py-1">
              <MessageScrollerContent className="gap-0">
                {lines.map((line, index) => (
                  <MessageScrollerItem
                    key={line.cursor}
                    messageId={line.cursor}
                    scrollAnchor={index === lines.length - 1}
                    style={{ containIntrinsicSize: "auto 2.25rem" }}
                  >
                    <LogLineRow line={line} showKind={showKind} showRun={showRun} />
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton direction="end" />
          </MessageScroller>
        </MessageScrollerProvider>
      )}
    </Card>
  )
}

// The console mirrors the run-status palette (sky/amber/red, slate for the
// quiet level) so severity reads the same here as everywhere else in Atlas.
const logLevelClasses: Record<LogLevel, string> = {
  debug:
    "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400",
  info: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300",
  warn: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
  error:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300",
}

function LogLineRow({
  line,
  showKind,
  showRun,
}: {
  line: SixbLogLine
  showKind: boolean
  showRun: boolean
}) {
  const fields =
    line.fields && Object.keys(line.fields).length > 0
      ? (line.fields as Record<string, unknown>)
      : null
  const showMeta = showKind || showRun

  return (
    <div className="flex gap-3 px-3 py-1 hover:bg-muted/40">
      <time
        dateTime={line.at}
        title={formatAbsolute(line.at)}
        className="flex w-[76px] shrink-0 flex-col items-end pt-[3px] text-right font-mono text-[10px] tabular-nums text-muted-foreground sm:w-[154px] sm:flex-row sm:justify-end sm:gap-1 sm:text-[11px]"
      >
        <span>{formatLogDate(line.at)}</span>
        <span>{formatLogTime(line.at)}</span>
      </time>
      <LogLevelBadge level={line.level} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
          {line.message}
        </p>
        {fields ? <LogFieldList fields={fields} /> : null}
        {showMeta ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            {showKind ? (
              <span className="uppercase tracking-wide">{line.context.run.kind}</span>
            ) : null}
            {showKind && showRun ? <span className="text-muted-foreground/40">·</span> : null}
            {showRun ? <RunRef run={line.context.run} /> : null}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function LogLevelBadge({ level }: { level: LogLevel }) {
  return (
    <span
      className={cn(
        "mt-[3px] inline-flex h-[15px] w-12 shrink-0 items-center justify-center rounded border text-[9px] font-semibold uppercase tracking-wider",
        logLevelClasses[level]
      )}
    >
      {level}
    </span>
  )
}

function LogFieldList({ fields }: { fields: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
      {Object.entries(fields).map(([key, value]) => (
        <span key={key} className="inline-flex min-w-0 items-baseline gap-1">
          <span className="text-muted-foreground/70">{key}</span>
          <span className="text-muted-foreground/40">=</span>
          <span className="break-all text-foreground/80">{formatFieldValue(value)}</span>
        </span>
      ))}
    </div>
  )
}

function RunRef({ run }: { run: SixbLogLine["context"]["run"] }) {
  return <span className="font-mono">{run.id}</span>
}

function ConnectionIndicator({ connected, error }: { connected: boolean; error: string | null }) {
  const state = error ? "error" : connected ? "live" : "connecting"
  const label = state === "error" ? "Disconnected" : state === "live" ? "Live" : "Connecting"
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
      title={error ?? undefined}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          state === "live" && "bg-emerald-500",
          state === "error" && "bg-red-500",
          state === "connecting" && "animate-pulse bg-amber-500"
        )}
      />
      {label}
    </span>
  )
}

function formatFieldValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function formatLogTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(date)
}

function formatLogDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Invalid date"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(date)
}

function formatAbsolute(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
    date
  )
}
