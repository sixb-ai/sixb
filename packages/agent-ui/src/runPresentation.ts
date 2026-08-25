import type { LiveRunState } from "./liveRun"
import type { NormalizedPart } from "./parts"
import type { AgentMessage, AgentRun, AgentRunStatus } from "./types"

export const DELAYED_WAITING_COPY_MS = 20_000

export function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return status === "queued" || status === "running"
}

/** The delayed copy belongs only to queue startup; running-before-content keeps the plain shimmer. */
export function shouldShowDelayedWaitingCopy(
  run: Pick<AgentRun, "status" | "createdAt"> | null,
  now = Date.now()
): boolean {
  return run?.status === "queued" && now - Date.parse(run.createdAt) >= DELAYED_WAITING_COPY_MS
}

/**
 * Return the newest pre-stream failure, if the newest run is failed and produced no durable
 * assistant message. Looking only at the newest run prevents an old failed attempt from resurfacing
 * after a successful retry.
 */
export function findPreStreamFailedRun(
  runs: readonly AgentRun[],
  messages: readonly AgentMessage[]
): AgentRun | null {
  const latest = runs[0]
  if (!latest || latest.status !== "failed") return null
  return messages.some((message) => message.role === "assistant" && message.runId === latest.id)
    ? null
    : latest
}

// ── Active turn presentation ─────────────────────────────────────────────────────────────────────

/** Pick the run the conversation should follow: pending send, thread claim, then durable history. */
export function selectActiveRunId(sources: {
  readonly pendingRun: AgentRun | null
  readonly threadActiveRunId: string | null
  readonly latestRun: AgentRun | null
}): string | null {
  return (
    sources.pendingRun?.id ??
    sources.threadActiveRunId ??
    (sources.latestRun && isActiveAgentRunStatus(sources.latestRun.status)
      ? sources.latestRun.id
      : null)
  )
}

export interface ActiveTurnSources {
  readonly activeRunId: string | null
  /** The canonical run from an in-flight send, when it belongs to the current thread. */
  readonly pendingRun: AgentRun | null
  /** Latest durable snapshot received on the run's stream subscription. */
  readonly streamRun: AgentRun | null
  readonly live: LiveRunState
  /** Durable run history, newest first. */
  readonly runs: readonly AgentRun[]
  readonly messages: readonly AgentMessage[]
  /** While the transcript is loading, terminal markers are suppressed to avoid a flash. */
  readonly messagesLoading: boolean
}

export type ActiveTurnPresentation =
  /** Waiting or streaming. `queuedRun` is set only while the wait is queue-side, before the run
   * announces itself on the stream — it feeds the delayed waiting copy. */
  | { readonly kind: "responding"; readonly queuedRun: AgentRun | null }
  /** The newest run failed before any durable assistant message; `run` feeds the retry endpoint. */
  | { readonly kind: "failed"; readonly run: AgentRun }
  /** The turn hit its wall-clock budget; coherent progress determines Continue versus Retry. */
  | {
      readonly kind: "timeout"
      readonly run: AgentRun
      readonly hasProgress: boolean
      readonly timeoutMs?: number
    }
  /** The turn was stopped before it produced any content. */
  | { readonly kind: "cancelled" }
  | { readonly kind: "idle" }

/**
 * Reduce every run source (pending send, stream snapshot, live events, durable history and
 * transcript) into the one state the conversation presents. The variants are mutually exclusive and
 * ordered: an in-flight turn wins over terminal markers, and a failure wins over a cancellation —
 * matching the transcript's render precedence.
 */
export function presentActiveTurn(sources: ActiveTurnSources): ActiveTurnPresentation {
  const { activeRunId, pendingRun, streamRun, live, runs, messages, messagesLoading } = sources
  const latestRun = runs[0] ?? null
  const activeRun =
    (streamRun?.id === activeRunId ? streamRun : null) ??
    (pendingRun?.id === activeRunId ? pendingRun : null) ??
    runs.find((run) => run.id === activeRunId) ??
    null
  const presentationRun = activeRun ?? latestRun

  const finished =
    (streamRun?.id === activeRunId && !isActiveAgentRunStatus(streamRun.status)) ||
    (live.runId === activeRunId && live.finishStatus !== null)
  if (activeRunId !== null && !finished) {
    return {
      kind: "responding",
      queuedRun: !live.active && presentationRun?.status === "queued" ? presentationRun : null,
    }
  }

  // Wait for the transcript before classifying a durable timeout: until messages load, we cannot
  // safely decide between Continue and Retry. A live terminal event may still render immediately
  // because its streamed parts are already available here.
  const timeoutFromRun =
    !messagesLoading && presentationRun?.finishReason === "timeout" ? presentationRun : null
  const timeoutFromEvent =
    live.runId === activeRunId && live.finishReason === "timeout" ? activeRun : null
  const timeoutRun = timeoutFromRun ?? timeoutFromEvent
  if (timeoutRun) {
    const hasProgress =
      (live.runId === timeoutRun.id && hasCoherentLiveProgress(live.parts)) ||
      messages.some((message) => message.role === "assistant" && message.runId === timeoutRun.id)
    const timeoutMs = timeoutMsFromFailure(
      timeoutRun.error ?? (live.runId === timeoutRun.id ? live.finishError : null)
    )
    return {
      kind: "timeout",
      run: timeoutRun,
      hasProgress,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  }

  const failedFromHistory =
    !messagesLoading && presentationRun?.status === "failed"
      ? findPreStreamFailedRun(
          presentationRun === latestRun ? runs : [presentationRun, ...runs],
          messages
        )
      : null
  const failedFromEvent =
    live.runId === activeRunId && live.finishStatus === "failed" && live.parts.length === 0
      ? activeRun
      : null
  const failedRun = failedFromHistory ?? failedFromEvent
  if (failedRun) {
    return { kind: "failed", run: failedRun }
  }

  const cancelled =
    live.parts.length === 0 &&
    ((presentationRun?.status === "cancelled" &&
      !messagesLoading &&
      !messages.some(
        (message) => message.role === "assistant" && message.runId === presentationRun.id
      )) ||
      (live.runId === activeRunId && live.finishStatus === "cancelled"))
  if (cancelled) {
    return { kind: "cancelled" }
  }

  return { kind: "idle" }
}

function timeoutMsFromFailure(error: unknown): number | undefined {
  if (!isRecord(error) || !isRecord(error.details)) return undefined
  const value = Number(error.details.timeoutMs)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Mirror the worker's interrupted-message coercion closely enough to choose a safe action live. */
function hasCoherentLiveProgress(parts: readonly NormalizedPart[]): boolean {
  return parts.some((part) => {
    switch (part.kind) {
      case "text":
        return part.text.length > 0
      case "reasoning":
        return !part.streaming && part.text.length > 0
      case "tool":
        return part.tool.state !== "input-streaming"
      case "file":
        return true
      case "step-start":
        return false
      default:
        part satisfies never
        return false
    }
  })
}
