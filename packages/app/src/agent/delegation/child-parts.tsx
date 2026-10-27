import { listModelsOptions } from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { Bot, Check, CornerDownRight, MessageCircleQuestion } from "lucide-react"
import { useEffect, useState } from "react"
import { latestWorkLabel } from "../activity-label"
import { ProviderLogo } from "../components/provider-logo"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import {
  type AgentChild,
  activeRun,
  type ChildExchange,
  type ChildState,
  formatWorked,
  isActive,
  type SpawnedChild,
  workedMs,
} from "./interpret"
import type { ChildModel, WaitingOn } from "./model"

// The pieces a sub-agent's card and its group are made of.

/**
 * Soft, opaque tints, given in the order a reply started its agents: two of one reply never share
 * one, and each keeps its own in the line and the list.
 */
const TINTS = [
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300",
] as const

/**
 * A sub-agent at a glance: its initial on a tinted disc. It breathes while it works,
 * an amber dot says it waits on the reader, and one that failed or was stopped turns grey. Several
 * overlap in a stack.
 */
export function AgentAvatar({
  name,
  state,
  needsReader,
  size = "sm",
  stacked = false,
  tint,
}: {
  readonly name: string
  /** Its place among its reply's agents, which picks its tint. */
  readonly tint: number
  readonly state: ChildState
  readonly needsReader: boolean
  readonly size?: "sm" | "md"
  /** Overlapping the one before it in a stack. */
  readonly stacked?: boolean
}) {
  const quiet = state === "failed" || state === "stopped" || state === "ended"
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full font-semibold ring-2 ring-background select-none",
        size === "sm" ? "size-5 text-[10px]" : "size-7 text-[12px]",
        stacked && (size === "sm" ? "-ml-1" : "-ml-2"),
        quiet ? "bg-muted text-muted-foreground" : (TINTS[tint % TINTS.length] ?? TINTS[0]),
        isActive(state) && "motion-safe:animate-pulse"
      )}
    >
      {initial(name)}
      {needsReader ? (
        <span
          className={cn(
            "absolute -right-0.5 -bottom-0.5 rounded-full bg-amber-500 ring-2 ring-background",
            size === "sm" ? "size-[7px]" : "size-2.5"
          )}
        />
      ) : null}
    </span>
  )
}

function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "·"
}

/** The text of what waits on the reader: the amber their attention goes to. */
export const NEEDS_READER_TEXT = "text-amber-700 dark:text-amber-400"

/** The status line: what it does right now while it works, else where it stands. */
export function statusLabel(
  model: ChildModel,
  input: {
    readonly stopping: boolean
    readonly observed: boolean
    readonly messages: AgentMessages
  }
): string {
  const { state, view, live } = model
  const labels = input.messages.delegation
  if (input.stopping) return labels.states.stopping
  if (state === "working") {
    return live && live.parts.length > 0
      ? latestWorkLabel(live.parts, input.messages)
      : labels.states.working
  }
  if (state === "ended" && view?.ended) return labels.states.ended[view.ended.reason]
  if (state === "failed" && view?.finishReason === "timeout") return labels.states.timeout
  if (state === "failed" && view?.error?.message) {
    return `${labels.states.failed} · ${view.error.message}`
  }
  return stateLabel(state, model.waitingOn, input.observed, input.messages)
}

/** Where a child stands, in words: also what a screen reader hears when it changes. */
function stateLabel(
  state: ChildState,
  waitingOn: WaitingOn,
  observed: boolean,
  messages: AgentMessages
): string {
  const states = messages.delegation.states
  switch (state) {
    case "approval":
      if (waitingOn.kind === "you") return states.approval
      return waitingOn.kind === "person"
        ? states.approvalOther(waitingOn.name)
        : states.approvalAnyone
    case "answer":
      return observed ? states.answerAnyone : states.answer
    case "ended":
      return states.stopped
    default:
      return states[state]
  }
}

/**
 * How long a child worked, its waits left out, ticking while it works. Children work side by side,
 * so a group says how long its longest took, not their sum.
 */
export function WorkedFor({ views }: { readonly views: readonly (AgentChild | undefined)[] }) {
  const labels = useAgentMessages().delegation
  const now = useNow(views.some((view) => activeRun(view) !== undefined))
  const worked = Math.max(0, ...views.map((view) => (view ? workedMs(view, now) : 0)))
  if (worked <= 0) return null
  return <>{formatWorked(worked, labels)}</>
}

/** The model a child runs on: its provider's logo, its name, and the tier it came from. */
export function ModelChip({
  child,
  view,
  className,
}: {
  readonly child: SpawnedChild
  readonly view?: AgentChild
  readonly className?: string
}) {
  const labels = useAgentMessages().delegation
  const models = useQuery({ ...listModelsOptions(), staleTime: 5 * 60_000 }).data?.language
  const ref = view?.model ?? child.model
  if (!ref) return null

  const model = models?.find(
    (candidate) => candidate.provider === ref.provider && candidate.modelId === ref.modelId
  )
  const tier = view?.tier ?? model?.tier ?? tierOf(child.tier)
  const name = model?.name ?? ref.modelId

  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1.5 text-muted-foreground",
        className
      )}
      title={`${ref.provider} · ${ref.modelId}`}
    >
      {model ? (
        <ProviderLogo model={model} className="size-3 opacity-80" />
      ) : (
        <Bot className="size-3 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate" title={tier ? labels.tiers[tier] : undefined}>
        {name}
      </span>
    </span>
  )
}

/**
 * What the Agent told the child, what the child asked, and what the Agent answered. The question
 * it waits on reads in full, in amber when the reader is the one to answer.
 */
export function Exchanges({
  exchanges,
  openQuestion,
  urgent,
}: {
  readonly exchanges: readonly ChildExchange[]
  readonly openQuestion: string | null
  readonly urgent: boolean
}) {
  const labels = useAgentMessages().delegation
  const shown = [...exchanges]
  if (openQuestion && !shown.some((each) => each.kind === "asked" && each.text === openQuestion)) {
    shown.push({ kind: "asked", text: openQuestion })
  }

  let lastAsked = -1
  shown.forEach((each, index) => {
    if (each.kind === "asked" && each.text === openQuestion) lastAsked = index
  })

  return (
    <ul className="flex flex-col gap-1.5">
      {shown.map((exchange, index) => {
        const open = index === lastAsked
        const amber = open && urgent
        // The question waiting on the reader: its card says so already, so it reads as itself.
        if (amber) {
          return (
            <li key={`${exchange.kind}:${index}`} className="text-sm leading-5 text-foreground">
              <span className="sr-only">{labels.asks} · </span>
              {exchange.text}
            </li>
          )
        }
        const Icon =
          exchange.kind === "asked"
            ? MessageCircleQuestion
            : exchange.kind === "answered"
              ? Check
              : CornerDownRight
        const label =
          exchange.kind === "asked"
            ? labels.asks
            : exchange.kind === "answered"
              ? labels.answer
              : labels.fromAgent

        return (
          <li
            key={`${exchange.kind}:${index}`}
            className={cn(
              "flex min-w-0 items-start gap-2 text-[13px] leading-5",
              exchange.kind === "answered" && "pl-5"
            )}
          >
            <Icon
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                amber ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
              )}
              aria-hidden="true"
            />
            <p className={cn("min-w-0 break-words", !open && "line-clamp-3")} title={exchange.text}>
              <span
                className={cn("font-medium", amber ? NEEDS_READER_TEXT : "text-muted-foreground")}
              >
                {label}
              </span>
              <span className="text-muted-foreground"> · </span>
              <span className="text-foreground">{exchange.text}</span>
            </p>
          </li>
        )
      })}
    </ul>
  )
}

function tierOf(value: string | undefined): "light" | "standard" | "heavy" | undefined {
  return value === "light" || value === "standard" || value === "heavy" ? value : undefined
}

/** Now, every second while `ticking`: an elapsed time that moves. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [ticking])
  return now
}
