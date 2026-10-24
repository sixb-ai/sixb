import { listModelsOptions } from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  Bot,
  Check,
  CircleDashed,
  CirclePause,
  CircleSlash,
  Clock3,
  CornerDownRight,
  LoaderCircle,
  type LucideIcon,
  MessageCircleQuestion,
  Square,
  X,
} from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
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
  type SpawnedChild,
  workedMs,
} from "./interpret"
import type { ChildModel, WaitingOn } from "./model"

// The pieces a sub-agent's card and its group are made of.

const GLYPHS: Readonly<
  Record<
    ChildState,
    { readonly Icon: LucideIcon; readonly className: string; readonly spin?: true }
  >
> = {
  starting: { Icon: CircleDashed, className: "bg-muted text-muted-foreground" },
  working: {
    Icon: LoaderCircle,
    className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    spin: true,
  },
  asking: {
    Icon: MessageCircleQuestion,
    className: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
  },
  approval: { Icon: CirclePause, className: "bg-amber-500/12 text-amber-600 dark:text-amber-400" },
  answer: {
    Icon: MessageCircleQuestion,
    className: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
  },
  resume: { Icon: Clock3, className: "bg-muted text-muted-foreground" },
  done: { Icon: Check, className: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" },
  failed: { Icon: X, className: "bg-muted text-muted-foreground" },
  stopped: { Icon: Square, className: "bg-muted text-muted-foreground/70" },
  ended: { Icon: CircleSlash, className: "bg-muted text-muted-foreground" },
  unknown: { Icon: Bot, className: "bg-muted text-muted-foreground" },
}

/**
 * Where a child stands at a glance: a turning ring while it works, amber while it waits on
 * someone. `calm`: it waits on someone other than the reader, so it does not call for them.
 */
export function StateGlyph({
  state,
  size = "md",
  ringed = false,
  calm = false,
}: {
  readonly state: ChildState
  readonly size?: "sm" | "md"
  /** Overlapping others in a stack. */
  readonly ringed?: boolean
  readonly calm?: boolean
}) {
  const { Icon, className, spin } = GLYPHS[state]
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full",
        size === "md" ? "mt-0.5 size-7" : "size-5",
        ringed && "ring-2 ring-card",
        calm && (state === "approval" || state === "answer")
          ? "bg-muted text-muted-foreground"
          : className
      )}
    >
      <Icon
        className={cn(
          size === "md" ? "size-3.5" : "size-3",
          state === "stopped" && "scale-75 fill-current",
          spin && "motion-safe:animate-spin motion-safe:[animation-duration:1.6s]",
          state === "approval" && !calm && "motion-safe:animate-pulse"
        )}
      />
    </span>
  )
}

/** The status line's colour: amber only when the reader is the one to act. */
export function toneClass(state: ChildState, needsReader: boolean): string {
  if (needsReader || state === "asking") return "text-amber-700 dark:text-amber-400"
  if (state === "done") return "text-emerald-700 dark:text-emerald-400"
  if (state === "working") return "text-foreground"
  return "text-muted-foreground"
}

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
export function stateLabel(
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

/** How long a child worked, its waits left out, ticking while it works. */
export function WorkedFor({ views }: { readonly views: readonly (AgentChild | undefined)[] }) {
  const labels = useAgentMessages().delegation
  const now = useNow(views.some((view) => activeRun(view) !== undefined))
  const worked = views.reduce((total, view) => total + (view ? workedMs(view, now) : 0), 0)
  if (worked <= 0) return null
  return <>{labels.worked(formatWorked(worked, labels))}</>
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
        "inline-flex h-6 max-w-full min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2 text-[11px] font-medium text-foreground",
        className
      )}
      title={`${ref.provider} · ${ref.modelId}`}
    >
      {model ? (
        <ProviderLogo model={model} className="size-3" />
      ) : (
        <Bot className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate">{name}</span>
      {tier ? <span className="shrink-0 text-muted-foreground">· {labels.tiers[tier]}</span> : null}
    </span>
  )
}

/** A band of the card below its header, its content aligned with the title. */
export function Section({
  label,
  children,
}: {
  readonly label?: string
  readonly children: ReactNode
}) {
  return (
    <div className="border-t border-border/60 px-4 py-3 sm:pl-14">
      {label ? (
        <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </p>
      ) : null}
      {children}
    </div>
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
                className={cn(
                  "font-medium",
                  amber ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
                )}
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
