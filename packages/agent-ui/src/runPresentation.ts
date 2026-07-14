import type { LiveRunState } from "./liveRun"
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
