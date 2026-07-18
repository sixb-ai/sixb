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
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  ListFilter,
  Search,
  SearchX,
  Trash2,
  X,
} from "lucide-react"
import type { ReactNode } from "react"
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

/**
 * A live log console over a `logs` builder: loads retained history, tails new
 * lines, and streams the newest line in at the top, pinning there unless the
 * reader scrolls down into history. Shared by the Logs page. The parent sets the
 * height through `className`.
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
  // `useSixbLogs` accumulates oldest-first; the console reads newest-first.
  const orderedLines = useMemo(() => [...visibleLines].reverse(), [visibleLines])

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
            {formatEntryCount(orderedLines.length, retainedLines.length, Boolean(deferredSearch))}
          </span>
        </div>

        {orderedLines.length === 0 ? (
          <LogEmptyState
            error={error}
            emptyLabel={emptyLabel}
            searchQuery={searchQuery}
            hadSourceLines={lines.length > 0}
            viewWasCleared={hiddenCursors.size > 0}
          />
        ) : (
          <MessageScrollerProvider defaultScrollPosition="start">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport
                className="bg-background"
                role="log"
                aria-label="Live logs"
                aria-live="off"
              >
                <MessageScrollerContent className="gap-0">
                  {orderedLines.map((line, index) => {
                    const previous = orderedLines[index - 1]
                    const startsDateGroup =
                      index === 0 || localDateKey(previous.at) !== localDateKey(line.at)
                    const startsRunGroup =
                      startsDateGroup || previous.context.run.id !== line.context.run.id
                    return (
                      <MessageScrollerItem
                        key={line.cursor}
                        messageId={line.cursor}
                        style={{ containIntrinsicSize: "auto 3rem" }}
                      >
                        {startsDateGroup ? <DateGroup value={line.at} /> : null}
                        <LogLineRow
                          line={line}
                          showKind={showKind}
                          showRun={showRun}
                          startsRunGroup={startsRunGroup}
                        />
                      </MessageScrollerItem>
                    )
                  })}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <LogTail
                latestCursor={orderedLines[0]?.cursor ?? null}
                lineCount={orderedLines.length}
              />
            </MessageScroller>
          </MessageScrollerProvider>
        )}
      </Card>
    </TooltipProvider>
  )
}

/**
 * Keeps the console pinned to the newest line at the top and surfaces a
 * jump-to-latest pill while the reader is scrolled down into history.
 *
 * The underlying scroller is a bottom-anchored chat component, so there is no
 * native "follow the top edge" mode. We drive it manually: capture whether the
 * reader is at the top before a new line prepends, then re-pin after the
 * scroller's own prepend-restore runs (`requestAnimationFrame` fires after that
 * synchronous adjustment, so our `scrollToStart` wins before paint). When the
 * reader has scrolled down, we leave their position alone — `preserveScrollOnPrepend`
 * (on by default) holds it steady — and count the unread arrivals instead.
 */
function LogTail({ latestCursor, lineCount }: { latestCursor: string | null; lineCount: number }) {
  const { scrollToStart } = useMessageScroller()
  const scrollable = useMessageScrollerScrollable()
  const atTop = !scrollable.start

  const pinnedRef = useRef(true)
  const prevCursorRef = useRef(latestCursor)
  const baselineRef = useRef(lineCount)

  // While the newest line is unchanged, track the live pin state. Freeze it across
  // the render that introduces a new newest line so the effect reads the pre-append value.
  if (latestCursor === prevCursorRef.current) {
    pinnedRef.current = atTop
  }

  useLayoutEffect(() => {
    if (latestCursor === prevCursorRef.current) return
    prevCursorRef.current = latestCursor
    if (!pinnedRef.current) return
    const raf = requestAnimationFrame(() => scrollToStart({ behavior: "auto" }))
    return () => cancelAnimationFrame(raf)
  }, [latestCursor, scrollToStart])

  // The unread count is the number of lines that have arrived since the reader left the top.
  useEffect(() => {
    if (atTop) baselineRef.current = lineCount
  }, [atTop, lineCount])
  const newCount = atTop ? 0 : Math.max(0, lineCount - baselineRef.current)

  if (atTop) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => scrollToStart({ behavior: "smooth" })}
        className="pointer-events-auto gap-1.5 rounded-full shadow-sm"
      >
        <ArrowUp />
        {newCount > 0 ? `${newCount} new ${newCount === 1 ? "log" : "logs"}` : "Jump to latest"}
      </Button>
    </div>
  )
}

const logLevelClasses: Record<LogLevel, string> = {
  debug: "bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
}

// Every row carries a 2px left rail so the message column stays aligned; only
// warnings and errors get a visible accent + tint so problems stand out while a
// quiet run reads calmly.
const logRowAccent: Record<LogLevel, string> = {
  debug: "border-l-transparent",
  info: "border-l-transparent",
  warn: "border-l-amber-500 bg-amber-500/[0.06] hover:bg-amber-500/[0.10]",
  error: "border-l-red-500 bg-red-500/[0.07] hover:bg-red-500/[0.12]",
}

const kindClasses: Record<string, string> = {
  sync: "text-violet-600 dark:text-violet-400",
  pipeline: "text-cyan-600 dark:text-cyan-400",
  workflow: "text-emerald-600 dark:text-emerald-400",
  action: "text-fuchsia-600 dark:text-fuchsia-400",
  webhook: "text-orange-600 dark:text-orange-400",
}

function LogLineRow({
  line,
  showKind,
  showRun,
  startsRunGroup,
}: {
  line: SixbLogLine
  showKind: boolean
  showRun: boolean
  startsRunGroup: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const fields =
    line.fields && Object.keys(line.fields).length > 0
      ? (line.fields as Record<string, unknown>)
      : null
  const { error: errorField, entries } = useMemo(() => splitLogFields(fields), [fields])

  const showRunMeta = startsRunGroup && (showKind || showRun)
  const showMeta =
    showRunMeta ||
    line.context.stepId !== undefined ||
    line.context.phase !== undefined ||
    line.context.attempt !== undefined
  const previewEntries = entries.slice(0, 2)
  const hasHiddenDetail =
    entries.length > previewEntries.length ||
    Boolean(errorField?.stack) ||
    entries.some(([, value]) => isComplexValue(value))
  // Whether anything renders on its own line under the message. When nothing does,
  // the row is a single line and its content is vertically centered (not top-pinned).
  const hasBody = showMeta || Boolean(errorField) || entries.length > 0
  const { head, tail } = formatLogTime(line.at)

  return (
    <div
      className={cn(
        "border-b border-l-2 border-border/50 px-3 py-2 transition-colors hover:bg-muted/35 sm:px-4",
        logRowAccent[line.level]
      )}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[6rem_minmax(0,1fr)_auto]">
        <time
          dateTime={line.at}
          title={formatAbsolute(line.at)}
          className="col-start-1 row-start-1 whitespace-nowrap font-mono text-[11px] leading-5 tabular-nums text-muted-foreground"
        >
          {head}
          {tail ? <span className="text-muted-foreground/60">{tail}</span> : null}
        </time>
        <div className="col-span-2 col-start-1 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
              {line.message}
            </p>
            {hasHiddenDetail ? (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                aria-label={expanded ? "Hide details" : "Show details"}
                className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
              >
                <ChevronRight
                  className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                />
              </button>
            ) : null}
          </div>
        </div>
        <div className="col-start-2 row-start-1 justify-self-end sm:col-start-3">
          <LogLevelBadge level={line.level} />
        </div>
      </div>
      {hasBody ? (
        <div className="mt-1.5 min-w-0 space-y-1.5 sm:pl-[6.75rem]">
          {showMeta ? <LogMetadata line={line} showKind={showKind} showRun={showRunMeta} /> : null}
          {!expanded && (errorField || previewEntries.length > 0) ? (
            <LogFieldPreview errorField={errorField} entries={previewEntries} />
          ) : null}
          {expanded ? <LogFieldDetails errorField={errorField} entries={entries} /> : null}
        </div>
      ) : null}
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
        <span
          className={cn(
            "font-semibold uppercase tracking-wide",
            kindClasses[line.context.run.kind] ?? "text-muted-foreground"
          )}
        >
          {line.context.run.kind}
        </span>
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

/** A one-line teaser of a row's structured detail, shown while the row is collapsed. */
function LogFieldPreview({
  errorField,
  entries,
}: {
  errorField: LogErrorField | null
  entries: [string, unknown][]
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[11px] leading-4 text-muted-foreground">
      {errorField ? (
        <span className="inline-flex min-w-0 items-baseline gap-1 text-red-600 dark:text-red-400">
          <span className="opacity-75">error</span>
          <span className="opacity-40">=</span>
          <span className="truncate">{errorField.name ?? "Error"}</span>
        </span>
      ) : null}
      {entries.map(([key, value]) => (
        <span key={key} className="inline-flex min-w-0 items-baseline gap-1">
          <span className="text-muted-foreground/75">{key}</span>
          <span className="text-muted-foreground/40">=</span>
          <span className="max-w-[24rem] truncate text-foreground/80">
            {formatFieldValue(value)}
          </span>
        </span>
      ))}
    </div>
  )
}

/** The full structured detail of a row: every field plus any error stack. */
function LogFieldDetails({
  errorField,
  entries,
}: {
  errorField: LogErrorField | null
  entries: [string, unknown][]
}) {
  return (
    <div className="mt-1.5 space-y-2 rounded-md border border-border/60 bg-muted/25 p-2.5">
      {entries.length > 0 ? (
        <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11px] leading-5">
          {entries.map(([key, value]) => (
            <div key={key} className="col-span-2 grid grid-cols-subgrid">
              <dt className="truncate text-muted-foreground/75">{key}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground/85">
                {formatFieldValue(value, true)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {errorField ? (
        <div className="space-y-1">
          {errorField.name ? (
            <p className="font-mono text-[11px] font-medium text-red-600 dark:text-red-400">
              {errorField.name}
            </p>
          ) : null}
          {errorField.stack ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
              {errorField.stack}
            </pre>
          ) : null}
        </div>
      ) : null}
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

interface LogErrorField {
  readonly name?: string
  readonly stack?: string
}

/** Split a line's fields into a recognized error object and the remaining entries. */
function splitLogFields(fields: Record<string, unknown> | null): {
  error: LogErrorField | null
  entries: [string, unknown][]
} {
  if (!fields) return { error: null, entries: [] }
  const rawError = fields.error
  const errorObject =
    rawError && typeof rawError === "object" && !Array.isArray(rawError)
      ? (rawError as Record<string, unknown>)
      : null
  if (!errorObject) return { error: null, entries: Object.entries(fields) }
  const { error: _error, ...rest } = fields
  return {
    error: {
      name: typeof errorObject.name === "string" ? errorObject.name : undefined,
      stack: typeof errorObject.stack === "string" ? errorObject.stack : undefined,
    },
    entries: Object.entries(rest),
  }
}

function isComplexValue(value: unknown): boolean {
  if (typeof value === "string") return value.length > 80 || value.includes("\n")
  return typeof value === "object" && value !== null
}

function formatFieldValue(value: unknown, pretty = false): string {
  if (typeof value === "string") return value
  if (pretty && typeof value === "object" && value !== null) {
    return JSON.stringify(value, null, 2)
  }
  return JSON.stringify(value) ?? String(value)
}

/** Split a timestamp into its formatted `HH:MM:SS` head and locale tail (e.g. " PM"). */
function formatLogTime(value: string): { head: string; tail: string } {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { head: value, tail: "" }
  // 2-digit hour keeps the column a fixed width so times align cleanly down the gutter.
  const formatted = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)
  const match = formatted.match(/^(.*\d{1,2}:\d{2}:\d{2})(.*)$/)
  if (!match) return { head: formatted, tail: "" }
  return { head: match[1], tail: match[2] }
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
  // The row shows seconds precision; the hover tooltip keeps the milliseconds.
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(date)
}
