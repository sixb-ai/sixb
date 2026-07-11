import { useSixbLogs } from "@sixb/client/hooks"
import type { LogLevel, LogsBuilder, SixbLogLine } from "@sixb/client/logs"
import {
  Badge,
  Button,
  Card,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ArrowDown, Check, Copy, ListFilter, Search, SearchX, Trash2, X } from "lucide-react"
import type { ReactNode } from "react"
import { useDeferredValue, useEffect, useMemo, useState } from "react"

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
  /** Controls placed beside search in the console toolbar. */
  readonly filters?: ReactNode
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
  filters,
  emptyLabel = "No logs recorded yet.",
  className,
}: LogConsoleProps) {
  const { lines, connected, error } = useSixbLogs(builder, { history, max })
  const [searchQuery, setSearchQuery] = useState("")
  const [hiddenCursors, setHiddenCursors] = useState<Set<string>>(() => new Set())
  const deferredSearch = useDeferredValue(searchQuery.trim().toLowerCase())
  const builderKey = JSON.stringify(builder.ir)

  // biome-ignore lint/correctness/useExhaustiveDependencies: builderKey resets transient UI state when the serialized log filter changes
  useEffect(() => {
    setHiddenCursors(new Set())
  }, [builderKey])

  const retainedLines = useMemo(
    () => lines.filter((line) => !hiddenCursors.has(line.cursor)),
    [hiddenCursors, lines]
  )
  const visibleLines = useMemo(
    () =>
      deferredSearch
        ? retainedLines.filter((line) => logLineMatches(line, deferredSearch))
        : retainedLines,
    [deferredSearch, retainedLines]
  )

  const clearView = () => {
    setHiddenCursors((current) => {
      const next = new Set(current)
      for (const line of lines) next.add(line.cursor)
      return next
    })
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Card className={cn("flex min-h-0 flex-col gap-0 overflow-hidden p-0", className)}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/15 p-2.5">
          <InputGroup className="h-8 min-w-[13rem] flex-1 sm:max-w-xs">
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search logs…"
              aria-label="Search logs"
              className="h-8 text-sm"
            />
            {searchQuery ? (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>

          {filters ? (
            <div className="flex min-w-0 flex-1 flex-wrap gap-2 sm:flex-none">{filters}</div>
          ) : null}

          <div className="ml-auto flex items-center gap-1">
            <ConnectionIndicator connected={connected} error={error} />
            <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearView}
                  disabled={lines.length === 0}
                  aria-label="Clear log view"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Trash2 />
                  <span className="hidden lg:inline">Clear</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Clear the current local view</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="flex min-h-8 items-center border-b border-border/60 bg-background px-3 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground tabular-nums">
            {formatEntryCount(visibleLines.length, retainedLines.length, Boolean(deferredSearch))}
          </span>
        </div>

        {visibleLines.length === 0 ? (
          <LogEmptyState
            error={error}
            emptyLabel={emptyLabel}
            searchQuery={searchQuery}
            hadSourceLines={lines.length > 0}
            viewWasCleared={hiddenCursors.size > 0}
          />
        ) : (
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport
                className="bg-background"
                role="log"
                aria-label="Live logs"
                aria-live="off"
              >
                <MessageScrollerContent className="gap-0">
                  {visibleLines.map((line, index) => {
                    const startsDateGroup =
                      index === 0 ||
                      localDateKey(visibleLines[index - 1].at) !== localDateKey(line.at)
                    return (
                      <MessageScrollerItem
                        key={line.cursor}
                        messageId={line.cursor}
                        scrollAnchor={index === visibleLines.length - 1}
                        style={{ containIntrinsicSize: "auto 3rem" }}
                      >
                        {startsDateGroup ? <DateGroup value={line.at} /> : null}
                        <LogLineRow line={line} showKind={showKind} showRun={showRun} />
                      </MessageScrollerItem>
                    )
                  })}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton direction="end" variant="outline" size="sm">
                <ArrowDown />
                Jump to latest
              </MessageScrollerButton>
            </MessageScroller>
          </MessageScrollerProvider>
        )}
      </Card>
    </TooltipProvider>
  )
}

const logLevelClasses: Record<LogLevel, string> = {
  debug: "bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
}

const logRowClasses: Partial<Record<LogLevel, string>> = {
  warn: "bg-amber-500/[0.025] hover:bg-amber-500/[0.06]",
  error: "bg-red-500/[0.03] hover:bg-red-500/[0.07]",
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
  const showMeta =
    showKind ||
    showRun ||
    line.context.stepId !== undefined ||
    line.context.phase !== undefined ||
    line.context.attempt !== undefined

  return (
    <div
      className={cn(
        "grid grid-cols-[5.75rem_minmax(0,1fr)] items-start gap-x-2 border-b border-border/50 px-3 py-2 transition-colors hover:bg-muted/35 sm:grid-cols-[6.5rem_3.25rem_minmax(0,1fr)] sm:gap-x-3 sm:px-4",
        logRowClasses[line.level]
      )}
    >
      <time
        dateTime={line.at}
        title={formatAbsolute(line.at)}
        className="col-start-1 row-start-1 pt-0.5 font-mono text-[11px] leading-5 tabular-nums text-muted-foreground sm:text-right"
      >
        {formatLogTime(line.at)}
      </time>
      <div className="col-start-2 row-start-1 pt-0.5">
        <LogLevelBadge level={line.level} />
      </div>
      <div className="col-span-2 col-start-1 row-start-2 mt-1 min-w-0 space-y-1.5 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:mt-0">
        <p className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
          {line.message}
        </p>
        {showMeta ? <LogMetadata line={line} showKind={showKind} showRun={showRun} /> : null}
        {fields ? <LogFieldList fields={fields} /> : null}
      </div>
    </div>
  )
}

function LogLevelBadge({ level }: { level: LogLevel }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-5 w-[3.25rem] rounded-sm border-0 px-1 font-mono text-[9px] font-semibold uppercase tracking-wider shadow-none",
        logLevelClasses[level]
      )}
    >
      {level}
    </Badge>
  )
}

function LogMetadata({
  line,
  showKind,
  showRun,
}: {
  line: SixbLogLine
  showKind: boolean
  showRun: boolean
}) {
  const metadata = [
    line.context.stepId ? `step ${line.context.stepId}` : null,
    line.context.phase ? `phase ${line.context.phase}` : null,
    line.context.attempt !== undefined ? `attempt ${line.context.attempt}` : null,
  ].filter((value): value is string => value !== null)

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
      {showKind ? (
        <span className="font-medium uppercase tracking-wide">{line.context.run.kind}</span>
      ) : null}
      {showKind && (showRun || metadata.length > 0) ? <MetadataSeparator /> : null}
      {showRun ? <RunRef run={line.context.run} /> : null}
      {showRun && metadata.length > 0 ? <MetadataSeparator /> : null}
      {metadata.map((value, index) => (
        <span key={value} className="contents">
          {index > 0 ? <MetadataSeparator /> : null}
          <span className="font-mono">{value}</span>
        </span>
      ))}
    </div>
  )
}

function MetadataSeparator() {
  return <span className="text-muted-foreground/40">·</span>
}

function LogFieldList({ fields }: { fields: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] leading-4 text-muted-foreground">
      {Object.entries(fields).map(([key, value]) => (
        <span key={key} className="inline-flex min-w-0 items-baseline gap-1">
          <span className="text-muted-foreground/75">{key}</span>
          <span className="text-muted-foreground/40">=</span>
          <span className="break-all text-foreground/80">{formatFieldValue(value)}</span>
        </span>
      ))}
    </div>
  )
}

function RunRef({ run }: { run: SixbLogLine["context"]["run"] }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyRunId = async () => {
    try {
      await navigator.clipboard.writeText(run.id)
      setCopied(true)
    } catch {
      // Clipboard access can be denied; leave the run reference usable as text.
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={copyRunId}
          className="-mx-1 h-5 min-w-0 max-w-full gap-1 px-1 font-mono text-[10px] font-normal text-muted-foreground hover:text-foreground"
          aria-label={`Copy run ID ${run.id}`}
        >
          <span className="truncate">{run.id}</span>
          {copied ? <Check className="text-emerald-600 dark:text-emerald-400" /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy run ID"}</TooltipContent>
    </Tooltip>
  )
}

function ConnectionIndicator({ connected, error }: { connected: boolean; error: string | null }) {
  const state = error ? "error" : connected ? "live" : "connecting"
  const label = state === "error" ? "Disconnected" : state === "live" ? "Live" : "Connecting"
  return (
    <Badge
      variant="ghost"
      className="h-7 gap-1.5 px-2 text-[11px] font-normal text-muted-foreground"
      title={error ?? undefined}
      aria-label={error ? `${label}: ${error}` : label}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          state === "live" && "bg-emerald-500",
          state === "error" && "bg-red-500",
          state === "connecting" && "animate-pulse bg-amber-500"
        )}
      />
      {label}
    </Badge>
  )
}

function DateGroup({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-3 bg-muted/20 px-3 py-2 sm:px-4">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {formatDateGroup(value)}
      </span>
      <Separator className="min-w-0 flex-1 shrink bg-border/60" />
    </div>
  )
}

function LogEmptyState({
  error,
  emptyLabel,
  searchQuery,
  hadSourceLines,
  viewWasCleared,
}: {
  error: string | null
  emptyLabel: string
  searchQuery: string
  hadSourceLines: boolean
  viewWasCleared: boolean
}) {
  const searching = searchQuery.trim().length > 0
  const title = searching
    ? "No matching logs"
    : viewWasCleared && hadSourceLines
      ? "Log view cleared"
      : error
        ? "Logs disconnected"
        : "Waiting for logs"
  const description = searching
    ? `No entries match “${searchQuery.trim()}”.`
    : viewWasCleared && hadSourceLines
      ? "New entries will appear here as they arrive."
      : (error ?? emptyLabel)

  return (
    <Empty className="flex-1 rounded-none">
      <EmptyHeader>
        <EmptyMedia variant="icon">{searching ? <SearchX /> : <ListFilter />}</EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function logLineMatches(line: SixbLogLine, query: string): boolean {
  const context = line.context
  const values = [
    line.message,
    line.level,
    context.run.kind,
    context.run.id,
    context.stepId,
    context.phase,
    context.attempt,
    line.fields ? JSON.stringify(line.fields) : null,
  ]
  return values.some(
    (value) => value !== undefined && value !== null && String(value).toLowerCase().includes(query)
  )
}

function formatEntryCount(visible: number, retained: number, filtered: boolean): string {
  if (filtered) return `${visible} of ${retained} ${retained === 1 ? "entry" : "entries"}`
  if (visible === 0) return "No entries"
  return `${visible} ${visible === 1 ? "entry" : "entries"}`
}

function formatFieldValue(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value) ?? String(value)
}

function formatLogTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(date)
}

function formatDateGroup(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown date"

  const today = new Date()
  if (isSameLocalDay(date, today)) return `Today · ${formatLongDate(date)}`

  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (isSameLocalDay(date, yesterday)) return `Yesterday · ${formatLongDate(date)}`

  return formatLongDate(date)
}

function formatLongDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date)
}

function localDateKey(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function formatAbsolute(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
    date
  )
}
