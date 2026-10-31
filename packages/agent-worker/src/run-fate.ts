import { type AgentRunFailure, AgentTurnTimeoutError, toAgentExecutionFailure } from "@sixb/agent"
import {
  AgentExecutionLostError,
  type AgentRunSession,
  AgentTurnInterruptedError,
} from "@sixb/core/internal/agents"
import type { AgentRunRecord, AppendAgentMessageInput } from "@sixb/core/storage"
import { shouldRetryAgentPreparation } from "./delivery-policy"

// What every run the worker runs shares, a turn's and a child's: its lease, its fate, and how its
// preparation retries.

/** How long a run whose preparation keeps failing waits before its delivery comes back. */
export const PRESTART_RETRY_BACKOFF_MS = 5_000
/** A run's own preparation retries quickly first, so a storage blip does not delay the answer. */
export const PREPARATION_RETRY_BACKOFF_MS = [250, 1_000, PRESTART_RETRY_BACKOFF_MS] as const

/**
 * Record the queue's renewals on the run: a run token fails closed once the lease last recorded
 * lapses, so it needs no heartbeat of its own. Returns the stop.
 */
export function projectLease(
  delivery: { onLeaseRenewed(listener: (renewed: { leaseExpiresAt: string }) => void): () => void },
  session: AgentRunSession,
  kind: "agent" | "subagent"
): () => void {
  return delivery.onLeaseRenewed((renewed) => {
    void session.renewLease(renewed.leaseExpiresAt).catch((error: unknown) => {
      if (!(error instanceof AgentExecutionLostError)) {
        console.error(
          `[SixbAgentWorker] Could not project queue ownership for ${kind} run '${session.run.id}'.`,
          error
        )
      }
    })
  })
}

/**
 * End a run that failed or stopped, with what it did kept in the same transaction. Returns
 * nothing when the run is no longer this session's; throws {@link AgentFinalizationError} when
 * storage stays unavailable, so the job is redelivered rather than acknowledged.
 */
export async function recordFate(
  session: AgentRunSession,
  status: "failed" | "cancelled",
  error: unknown,
  messages?: readonly AppendAgentMessageInput[]
): Promise<{ readonly run: AgentRunRecord; readonly failure: AgentRunFailure } | undefined> {
  const { run } = session
  const completedAt = new Date()
  const failure = toAgentExecutionFailure(error, {
    status,
    at: completedAt,
    details: {
      ...agentRunFailureDetails(run),
      ...(error instanceof AgentTurnTimeoutError ? { timeoutMs: String(error.timeoutMs) } : {}),
    },
  })
  try {
    const finalized = await session.finish(
      {
        status,
        error: failure,
        completedAt,
        ...(error instanceof AgentTurnTimeoutError ? { finishReason: "timeout" as const } : {}),
        ...(error instanceof AgentTurnInterruptedError
          ? { finishReason: "interrupted" as const }
          : {}),
      },
      messages
    )
    return { run: finalized, failure }
  } catch (finishError) {
    if (finishError instanceof AgentExecutionLostError) return undefined
    throw finishError
  }
}

export function agentRunFailureDetails(run: AgentRunRecord): Readonly<Record<string, string>> {
  return run.kind === "conversation"
    ? { runId: run.id, threadId: run.threadId }
    : { parentRunId: run.parentRunId, runId: run.id }
}

export function isTerminalRun(run: AgentRunRecord): boolean {
  return run.status !== "queued" && run.status !== "running"
}

export async function waitForAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}

/**
 * Preparation calls no model and no tool, so a dependency failure is retried here, within the
 * delivery that owns the run. A redelivery would find the run running and end it as interrupted.
 */
export async function retryPreparationInPlace<T>(
  attempt: number,
  signal: AbortSignal,
  prepare: () => Promise<T>
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await prepare()
    } catch (error) {
      if (
        signal.aborted ||
        error instanceof AgentExecutionLostError ||
        !shouldRetryAgentPreparation(error, attempt + retry)
      ) {
        throw error
      }
    }
    const backoffMs = PREPARATION_RETRY_BACKOFF_MS[retry] ?? PRESTART_RETRY_BACKOFF_MS
    await waitForAbort(backoffMs, signal)
    signal.throwIfAborted()
  }
}
