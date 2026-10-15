import { isSixbApiError } from "@sixb/client"
import { listLogsOptions, useSixbLogs } from "@sixb/client/hooks"
import { type LogLevel, type LogsBuilder, logs, type SixbLogLine } from "@sixb/client/logs"
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowUp,
  ChevronRight,
  ListFilter,
  ScrollText,
  Search,
  SearchX,
  Trash2,
  X,
} from "lucide-react"
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { actionRunHref, workflowRunHref } from "../routes"
import { SectionWorkspace, WorkspaceHeader } from "../section-page"
import { CopyButton, IconTile, PageSection, Panel, PanelEmpty } from "../section-ui"
import { useObservabilityMessages } from "./messages"

const kinds = ["all", "sync", "pipeline", "workflow", "action", "webhook"] as const
type Kind = (typeof kinds)[number]
const levels = ["all", "debug", "info", "warn", "error"] as const
type Level = (typeof levels)[number]

function builderFor(kind: Kind, level: Level): LogsBuilder {
  const base =
    kind === "sync"
      ? logs.syncs()
      : kind === "pipeline"
        ? logs.pipelines()
        : kind === "workflow"
          ? logs.workflows()
          : kind === "action"
            ? logs.actions()
            : kind === "webhook"
              ? logs.webhooks()
              : logs.all()
  return level === "all" ? base : base.level(level)
}

/**
 * Observability › Logs: what runs write as they work. The retained history loads first, then new
 * lines stream in at the top, which stays pinned unless the reader scrolls down into history.
 */
export function ObservabilityLogsPage() {
  const messages = useObservabilityMessages().logs
  const [searchParams, setSearchParams] = useSearchParams()
  const kind = kinds.find((candidate) => candidate === searchParams.get("kind")) ?? "all"
  const level = levels.find((candidate) => candidate === searchParams.get("level")) ?? "all"
  const setParam = (name: "kind" | "level", value: string) =>
    setSearchParams(
      (params) => {
        if (value === "all") params.delete(name)
        else params.set(name, value)
        return params
      },
      { replace: true }
    )
  // A new builder each render is fine: `useSixbLogs` keys on the serialized filter.
  const builder = useMemo(() => builderFor(kind, level), [kind, level])
  const access = useLogsAccess()
  const denied = access === "denied"
  const { lines, connected, error } = useSixbLogs(builder, { enabled: access === "allowed" })
  const [query, setQuery] = useState("")
  const search = useDeferredValue(query.trim().toLowerCase())
  // Clearing hides what is here; lines that arrive later still show.
  const [clearedThrough, setClearedThrough] = useState<ReadonlySet<string>>(() => new Set())
  const filterKey = JSON.stringify(builder.ir)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts with nothing hidden
  useEffect(() => setClearedThrough(new Set()), [filterKey])

  const kept = useMemo(
    () => lines.filter((line) => !clearedThrough.has(line.cursor)),
    [lines, clearedThrough]
  )
  // `useSixbLogs` gathers oldest first; the console reads newest first.
  const shown = useMemo(
    () => [...(search ? kept.filter((line) => lineMatches(line, search)) : kept)].reverse(),
    [kept, search]
  )
  const state = denied || error ? "disconnected" : connected ? "live" : "connecting"

  return (
    <SectionWorkspace section="observability" page="logs">
      <WorkspaceHeader
        icon={<IconTile icon={ScrollText} />}
        title={messages.title}
        meta={<span className="truncate">{messages.description}</span>}
        actions={
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title={error ?? undefined}
            aria-label={error ? `${messages[state]}: ${error}` : undefined}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                state === "live" && "bg-emerald-500",
                state === "disconnected" && "bg-red-500",
                state === "connecting" && "animate-pulse bg-amber-500"
              )}
            />
            {messages[state]}
          </span>
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 md:px-4">
        <InputGroup className="h-8 w-full sm:w-64">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={messages.search}
            aria-label={messages.search}
            className="h-8 text-[0.8125rem]"
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={() => setQuery("")}
                aria-label={messages.clearSearch}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <FilterSelect
          label={messages.kindFilter}
          value={kind}
          options={kinds}
          labels={messages.kinds}
          onChange={(value) => setParam("kind", value)}
        />
        <FilterSelect
          label={messages.levelFilter}
          value={level}
          options={levels}
          labels={messages.levels}
          onChange={(value) => setParam("level", value)}
        />
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {search
            ? messages.entriesOf(shown.length, kept.length)
            : shown.length === 0
              ? messages.noEntries
              : messages.entries(shown.length)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={messages.clearHint}
          disabled={lines.length === 0}
          onClick={() => setClearedThrough(new Set(lines.map((line) => line.cursor)))}
          className="text-muted-foreground"
        >
          <Trash2 />
          {messages.clear}
        </Button>
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <PanelEmpty
            icon={search ? SearchX : ListFilter}
            tone={(denied || error) && !search ? "error" : undefined}
            title={
              denied
                ? messages.deniedTitle
                : search
                  ? messages.noMatchTitle
                  : clearedThrough.size > 0 && lines.length > 0
                    ? messages.clearedTitle
                    : error
                      ? messages.disconnectedTitle
                      : messages.waitingTitle
            }
            description={
              denied
                ? messages.denied
                : search
                  ? messages.noMatch(query.trim())
                  : clearedThrough.size > 0 && lines.length > 0
                    ? messages.cleared
                    : (error ?? messages.waiting)
            }
          />
        </div>
      ) : (
        <MessageScrollerProvider defaultScrollPosition="start">
          <MessageScroller className="min-h-0 flex-1">
            <MessageScrollerViewport role="log" aria-label={messages.title} aria-live="off">
              <MessageScrollerContent className="gap-0">
                {shown.map((line, index) => {
                  const previous = shown[index - 1]
                  const newDay = !previous || dayKey(previous.at) !== dayKey(line.at)
                  const newRun = newDay || previous.context.run.id !== line.context.run.id
                  return (
                    <MessageScrollerItem
                      key={line.cursor}
                      messageId={line.cursor}
                      style={{ containIntrinsicSize: "auto 3rem" }}
                    >
                      {newDay ? <DayHeading at={line.at} /> : null}
                      <LogLine line={line} showRun={newRun} />
                    </MessageScrollerItem>
                  )
                })}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <PinToLatest cursors={cursorsOf(shown)} />
          </MessageScroller>
        </MessageScrollerProvider>
      )}
    </SectionWorkspace>
  )
}

/** What one run wrote, oldest first, under the run's other details. */
export function RunLogs({
  kind,
  runId,
}: {
  readonly kind: "workflow" | "action"
  readonly runId: string
}) {
  const messages = useObservabilityMessages().logs
  const builder = useMemo(
    () => (kind === "workflow" ? logs.workflows() : logs.actions()).run(runId),
    [kind, runId]
  )
  const access = useLogsAccess()
  const denied = access === "denied"
  const { lines, error } = useSixbLogs(builder, { enabled: access === "allowed" })
  return (
    <PageSection title={messages.title} description={messages.runDescription}>
      <Panel>
        {lines.length === 0 ? (
          <PanelEmpty
            icon={ScrollText}
            tone={denied || error ? "error" : undefined}
            title={
              denied
                ? messages.deniedTitle
                : error
                  ? messages.disconnectedTitle
                  : messages.runEmptyTitle
            }
            description={denied ? messages.denied : (error ?? messages.runEmpty)}
          />
        ) : (
          <div className="max-h-[28rem] overflow-y-auto">
            {lines.map((line) => (
              <LogLine key={line.cursor} line={line} showRun={false} />
            ))}
          </div>
        )}
      </Panel>
    </PageSection>
  )
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  /** What the select chooses, for assistive technology. */
  readonly label: string
  readonly value: T
  readonly options: readonly T[]
  readonly labels: Readonly<Record<T, string>>
  readonly onChange: (value: T) => void
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate === next)
        if (option) onChange(option)
      }}
    >
      <SelectTrigger size="sm" className="h-8 w-40 text-[0.8125rem]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((option) => (
          <SelectItem key={option} value={option} className="text-[0.8125rem]">
            {labels[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Keeps the newest line in view while the reader is at the top, and offers a way back once they
 * scroll into history. The scroller anchors to its end like a chat, so following the top is done
 * here: whether the reader was at the top is read before a line arrives, and the scroll back to it
 * runs in the next frame, after the scroller has held its own position for the new line.
 */
function PinToLatest({ cursors }: { readonly cursors: readonly string[] }) {
  const latest = cursors[0] ?? null
  const messages = useObservabilityMessages().logs
  const { scrollToStart } = useMessageScroller()
  const atTop = !useMessageScrollerScrollable().start
  const pinned = useRef(true)
  const previous = useRef(latest)
  // The newest line the reader saw at the top; what came after it is unread. Counted by position,
  // not by length, since the buffer stops growing at its cap and a search changes its length.
  const seen = useRef(latest)
  if (latest === previous.current) pinned.current = atTop

  useLayoutEffect(() => {
    if (latest === previous.current) return
    previous.current = latest
    if (!pinned.current) return
    const frame = requestAnimationFrame(() => scrollToStart({ behavior: "auto" }))
    return () => cancelAnimationFrame(frame)
  }, [latest, scrollToStart])
  useEffect(() => {
    if (atTop) seen.current = latest
  }, [atTop, latest])

  if (atTop) return null
  const unread = seen.current === null ? -1 : cursors.indexOf(seen.current)
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => scrollToStart({ behavior: "smooth" })}
        className="pointer-events-auto rounded-full bg-background"
      >
        <ArrowUp />
        {unread > 0 ? messages.newLines(unread) : messages.jumpToLatest}
      </Button>
    </div>
  )
}

const levelStyles: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-sky-700 dark:text-sky-300",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-red-600 dark:text-red-400",
}

// Warnings and errors carry a tinted rail so a quiet run reads calmly and a problem stands out.
const rowAccents: Record<LogLevel, string> = {
  debug: "border-l-transparent",
  info: "border-l-transparent",
  warn: "border-l-amber-500 bg-amber-500/[0.05]",
  error: "border-l-red-500 bg-red-500/[0.06]",
}

function LogLine({ line, showRun }: { readonly line: SixbLogLine; readonly showRun: boolean }) {
  const messages = useObservabilityMessages().logs
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const { errorField, fields } = useMemo(() => splitFields(line.fields), [line.fields])
  const context = [
    line.context.stepId ? messages.step(line.context.stepId) : null,
    line.context.phase ? messages.phase(line.context.phase) : null,
    line.context.attempt !== undefined ? messages.attempt(line.context.attempt) : null,
  ].filter((value): value is string => value !== null)
  const expandable =
    fields.length > 2 || Boolean(errorField?.stack) || fields.some(([, value]) => isLong(value))
  const time = new Date(line.at)

  return (
    <div
      className={cn(
        "border-b border-l-2 border-border/50 px-3 py-2 transition-colors hover:bg-muted/30 md:px-4",
        rowAccents[line.level]
      )}
    >
      <div className="flex items-start gap-3">
        <time
          dateTime={line.at}
          title={Number.isNaN(time.getTime()) ? line.at : time.toLocaleString(locale)}
          className="w-[4.75rem] shrink-0 font-mono text-[0.6875rem] leading-5 text-muted-foreground tabular-nums"
        >
          {Number.isNaN(time.getTime())
            ? line.at
            : time.toLocaleTimeString(locale, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
        </time>
        <span
          className={cn(
            "w-11 shrink-0 font-mono text-[0.625rem] leading-5 font-semibold tracking-wider uppercase",
            levelStyles[line.level]
          )}
        >
          {line.level}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs leading-5 break-words whitespace-pre-wrap">
            {line.message}
          </p>
          {showRun || context.length > 0 ? (
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
              {showRun ? <RunReference run={line.context.run} /> : null}
              {context.map((value) => (
                <span key={value} className="font-mono">
                  {value}
                </span>
              ))}
            </div>
          ) : null}
          {!open && (errorField || fields.length > 0) ? (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.6875rem] leading-4 text-muted-foreground">
              {errorField ? (
                <span className="text-red-600 dark:text-red-400">
                  error={errorField.name ?? "Error"}
                </span>
              ) : null}
              {fields.slice(0, 2).map(([key, value]) => (
                <span key={key} className="max-w-[24rem] truncate">
                  <span className="text-muted-foreground/70">{key}=</span>
                  <span className="text-foreground/80">{fieldText(value)}</span>
                </span>
              ))}
            </div>
          ) : null}
          {open ? (
            <div className="mt-1.5 flex flex-col gap-2 rounded-md border border-border/60 bg-muted/25 p-2.5">
              {fields.length > 0 ? (
                <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[0.6875rem] leading-5">
                  {fields.map(([key, value]) => (
                    <div key={key} className="col-span-2 grid grid-cols-subgrid">
                      <dt className="truncate text-muted-foreground">{key}</dt>
                      <dd className="min-w-0 break-words whitespace-pre-wrap">
                        {fieldText(value, true)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {errorField?.stack ? (
                <pre className="max-h-64 overflow-auto font-mono text-[0.625rem] leading-4 break-words whitespace-pre-wrap text-muted-foreground">
                  {errorField.stack}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? messages.hideDetails : messages.showDetails}
            onClick={() => setOpen((value) => !value)}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** The run a line came from: a link where the run has a page, its id to copy otherwise. */
function RunReference({ run }: { readonly run: SixbLogLine["context"]["run"] }) {
  const messages = useObservabilityMessages().logs
  const href =
    run.kind === "workflow"
      ? workflowRunHref(run.id)
      : run.kind === "action"
        ? actionRunHref(run.id)
        : null
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="font-semibold tracking-wide uppercase">{run.kind}</span>
      {href ? (
        <Link
          to={href}
          title={messages.openRun}
          className="truncate font-mono underline-offset-2 hover:text-foreground hover:underline"
        >
          {run.id}
        </Link>
      ) : (
        <>
          <span className="truncate font-mono">{run.id}</span>
          <CopyButton value={run.id} compact />
        </>
      )}
    </span>
  )
}

function DayHeading({ at }: { readonly at: string }) {
  const messages = useObservabilityMessages().logs
  const locale = useLocale()
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return null
  const label = date.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" })
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  return (
    <div className="flex items-center gap-3 bg-muted/30 px-3 py-1.5 md:px-4">
      <span className="text-[0.6875rem] font-medium text-muted-foreground">
        {dayKey(at) === dayKey(today.toISOString())
          ? messages.today(label)
          : dayKey(at) === dayKey(yesterday.toISOString())
            ? messages.yesterday(label)
            : label}
      </span>
    </div>
  )
}

/**
 * Whether this person may read logs. The live stream reports a refusal only by closing, and then
 * reconnects, so one line of history is read first and the stream opens only once that is allowed.
 */
function useLogsAccess(): "checking" | "denied" | "allowed" {
  const probe = useQuery({
    ...listLogsOptions({ query: { limit: 1 } }),
    retry: false,
    staleTime: 60_000,
  })
  if (probe.isPending) return "checking"
  return isSixbApiError(probe.error) && probe.error.status === 403 ? "denied" : "allowed"
}

function cursorsOf(lines: readonly SixbLogLine[]): string[] {
  return lines.map((line) => line.cursor)
}

function dayKey(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? at
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function lineMatches(line: SixbLogLine, query: string): boolean {
  return [
    line.message,
    line.level,
    line.context.run.kind,
    line.context.run.id,
    line.context.stepId,
    line.context.phase,
    line.context.attempt?.toString(),
    line.fields ? JSON.stringify(line.fields) : undefined,
  ].some((value) => value?.toLowerCase().includes(query))
}

/** A line's fields, with a recorded error taken out so its name and stack read as such. */
function splitFields(fields: SixbLogLine["fields"]): {
  readonly errorField: { readonly name?: string; readonly stack?: string } | null
  readonly fields: readonly (readonly [string, unknown])[]
} {
  const entries = Object.entries(fields ?? {})
  const error = fields?.error
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return { errorField: null, fields: entries }
  }
  const { name, stack } = error as Record<string, unknown>
  return {
    errorField: {
      name: typeof name === "string" ? name : undefined,
      stack: typeof stack === "string" ? stack : undefined,
    },
    fields: entries.filter(([key]) => key !== "error"),
  }
}

function isLong(value: unknown): boolean {
  return typeof value === "string"
    ? value.length > 80 || value.includes("\n")
    : typeof value === "object" && value !== null
}

function fieldText(value: unknown, pretty = false): string {
  if (typeof value === "string") return value
  return (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) ?? String(value)
}
