import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, CircleCheck, CircleStop, CircleX, Square } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useNow } from "../delegation/child-parts"
import { formatWorked } from "../delegation/interpret"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import type { NormalizedTool } from "../parts"
import { BackgroundToolRow } from "./background-tool-row"
import { useBackgroundCards } from "./context"
import {
  type BackgroundCardState,
  type BackgroundStart,
  backgroundCardState,
  backgroundStartOf,
} from "./interpret"

/** How many lines of what the agent read the card shows: the newest. */
const OUTPUT_LINES = 60

/**
 * A command the agent started in the background, as its step in the work: the card that says how
 * it stands, which only a reader who opens the steps sees. On its way, or outside a transcript, it
 * is a quiet line like any other step.
 */
export function BackgroundCommandStep({ tool }: { readonly tool: NormalizedTool }) {
  const context = useBackgroundCards()
  const start = backgroundStartOf(tool)
  if (!context || start?.kind !== "started") return <BackgroundToolRow tool={tool} />

  return (
    // The steps scroll past their height: the card keeps its own rather than shrink with them.
    <div className="min-w-0 shrink-0 overflow-hidden rounded-lg border border-border/70 bg-card text-card-foreground">
      <BackgroundCommandCard start={start} />
    </div>
  )
}

/**
 * One background command as it stands now: what runs, for how long or how it ended, the newest of
 * what the agent read of its output, and, for its owner while it runs on their computer, Stop. Its
 * calls, its `sixb`'s reports and its turn make one state (see `backgroundCardState`).
 */
function BackgroundCommandCard({ start }: { readonly start: BackgroundStart }) {
  const context = useBackgroundCards()
  const messages = useAgentMessages()
  const labels = messages.background
  const [stopAsked, setStopAsked] = useState(false)
  const [stopFailed, setStopFailed] = useState(false)
  const [open, setOpen] = useState(false)

  const calls = start.kind === "started" ? context?.thread.commands.get(start.key) : undefined
  const state = context
    ? backgroundCardState({
        start,
        ...(calls ? { calls } : {}),
        source: context.source,
        liveRunId: context.liveRunId,
        stopAsked,
      })
    : null
  const now = useNow(state?.status === "running")
  if (!context || !state) return null

  const stop = context.stop
  const canStop = state.canStop && stop !== undefined && start.kind === "started"
  const askStop = () => {
    if (!canStop || start.kind !== "started") return
    setStopAsked(true)
    setStopFailed(false)
    stop({ id: start.id, startedAt: start.startedAt }).catch(() => {
      setStopAsked(false)
      setStopFailed(true)
    })
  }

  const command = firstLine(state.command)
  const output = tail(state.output)

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      role="region"
      aria-label={labels.card(command)}
      data-background-status={state.status}
      className="min-w-0"
    >
      {/* Said once per change of how it stands, never per tick of its clock. */}
      <span className="sr-only" aria-live="polite">
        {statusWords(state, labels)}
      </span>

      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5 sm:px-3.5">
        <StatusMark state={state} />
        <div className="min-w-0 flex-1">
          <p
            className="truncate font-mono text-[12.5px] leading-5 text-foreground"
            title={state.command}
          >
            {command}
          </p>
          <p className="truncate text-xs leading-5 text-muted-foreground tabular-nums">
            <StatusLine state={state} now={now} messages={messages} />
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {output.lines.length > 0 ? (
            <CollapsibleTrigger
              aria-label={labels.output}
              title={labels.lines(output.count)}
              className="group flex h-6 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:text-foreground"
            >
              {/* A phone keeps the room for the command: the chevron says it opens. */}
              <span className="hidden sm:inline">{labels.output}</span>
              <ChevronRight
                className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </CollapsibleTrigger>
          ) : null}
          {canStop ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={askStop}
              title={labels.stopHint}
              className="rounded-full px-2.5 text-muted-foreground hover:text-foreground"
            >
              <Square className="size-2 fill-current" aria-hidden="true" />
              {labels.stop}
            </Button>
          ) : null}
        </div>
      </div>

      {stopFailed ? (
        <p
          role="alert"
          className="-mt-1 px-3 pb-2.5 pl-10 text-xs text-destructive sm:pl-[2.875rem]"
        >
          {labels.stopFailed}
        </p>
      ) : null}

      {output.lines.length > 0 ? (
        <CollapsibleContent>
          <OutputTail lines={output.lines} />
          {(state.truncated || output.cut) && state.outputPath ? (
            <p className="-mt-1 truncate px-3 pb-2.5 font-mono text-[11px] text-muted-foreground/70 sm:px-3.5">
              {labels.earlierOutput(state.outputPath)}
            </p>
          ) : null}
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  )
}

/** The newest output, scrolled to its end as it opens: a tail reads from the bottom. */
function OutputTail({ lines }: { readonly lines: readonly string[] }) {
  const ref = useRef<HTMLPreElement>(null)
  const text = lines.join("\n")
  // biome-ignore lint/correctness/useExhaustiveDependencies: new output scrolls it again
  useEffect(() => {
    const pre = ref.current
    if (pre) pre.scrollTop = pre.scrollHeight
  }, [text])

  return (
    <pre
      ref={ref}
      className="scrollbar-thin mx-3 mb-3 max-h-56 overflow-auto overscroll-contain rounded-lg bg-muted/50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground/90 sm:mx-3.5"
    >
      {text}
    </pre>
  )
}

/** Running pulses; an end reads at a glance: done, failed, stopped. */
function StatusMark({ state }: { readonly state: BackgroundCardState }) {
  const box = "flex size-4 shrink-0 items-center justify-center"

  if (state.status === "running" || state.status === "starting") {
    const live = state.status === "running" && !state.stopping
    return (
      <span className={box} aria-hidden="true">
        <span className="relative flex size-2">
          {live ? (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/50 motion-reduce:hidden" />
          ) : null}
          <span
            className={cn(
              "relative inline-flex size-2 rounded-full",
              live ? "bg-emerald-500" : "animate-pulse bg-muted-foreground/40"
            )}
          />
        </span>
      </span>
    )
  }
  if (state.status === "exited") {
    return state.exitCode === 0 || state.exitCode === undefined ? (
      <CircleCheck
        className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
    ) : (
      <CircleX className="size-4 shrink-0 text-red-600/85 dark:text-red-400" aria-hidden="true" />
    )
  }
  if (state.status === "stopped") {
    return <CircleStop className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  }
  return (
    <span className={box} aria-hidden="true">
      <span className="size-2 rounded-full bg-muted-foreground/35" />
    </span>
  )
}

/** How it stands, then for how long: `Running · 2m 14s`, `Failed · exit code 1 · 12s`. */
function StatusLine({
  state,
  now,
  messages,
}: {
  readonly state: BackgroundCardState
  readonly now: number
  readonly messages: AgentMessages
}) {
  const labels = messages.background
  const started = state.startedAt ? Date.parse(state.startedAt) : undefined
  const ended = state.endedAt ? Date.parse(state.endedAt) : undefined
  const ran =
    started === undefined
      ? undefined
      : state.status === "running"
        ? now - started
        : ended === undefined
          ? undefined
          : ended - started
  const time = ran === undefined ? null : formatWorked(ran, messages.delegation)

  const clauses: { readonly text: string; readonly tone?: "live" | "quiet" }[] = []
  const words = statusWords(state, labels)
  clauses.push({
    text: words,
    ...(state.stopping || state.status === "starting" ? { tone: "live" as const } : {}),
  })
  if (time && !state.endedWith) clauses.push({ text: time })
  if (state.status === "running" && !state.stopping && state.pending) {
    clauses.push({ text: labels[state.pending], tone: "quiet" })
  }

  return clauses.map((clause, index) => (
    <span key={clause.text}>
      {index > 0 ? <span className="text-muted-foreground/50"> · </span> : null}
      <span
        className={cn(
          clause.tone === "live" && "shimmer motion-reduce:animate-none",
          clause.tone === "quiet" && "text-muted-foreground/70"
        )}
      >
        {clause.text}
      </span>
    </span>
  ))
}

function statusWords(state: BackgroundCardState, labels: AgentMessages["background"]): string {
  if (state.stopping) return labels.stopping
  switch (state.status) {
    case "starting":
      return labels.starting
    case "running":
      return labels.running
    case "exited":
      return labels.exited(state.exitCode ?? 0)
    case "stopped":
      return state.endedWith === "turn"
        ? labels.stoppedWithTurn
        : state.endedWith === "sixb"
          ? labels.stoppedWithSixb
          : labels.stopped
    case "unknown":
      return state.unreachable ? labels.unreachable : labels.unknown
  }
}

/** The output's newest lines, and how many it has in all. */
function tail(output: string): {
  readonly lines: readonly string[]
  readonly count: number
  readonly cut: boolean
} {
  const trimmed = output.replace(/\s+$/, "")
  if (!trimmed) return { lines: [], count: 0, cut: false }
  const all = trimmed.split("\n")
  return { lines: all.slice(-OUTPUT_LINES), count: all.length, cut: all.length > OUTPUT_LINES }
}

function firstLine(command: string): string {
  const lines = command.trim().split("\n")
  return (lines[0] ?? "") + (lines.length > 1 ? " …" : "")
}
