import {
  AgentExecutionLostError,
  type AgentRunSession,
  AgentTurnInterruptedError,
} from "@sixb/core/internal/agents"
import type { AgentRunRecord, AppendAgentMessageInput } from "@sixb/core/storage"
import { type AgentRunFailure, toAgentExecutionFailure } from "./failure"

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
    details: agentRunFailureDetails(run),
  })
  try {
    const finalized = await session.finish(
      {
        status,
        error: failure,
        completedAt,
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

/** What a run's failure names: its run, and its thread or its parent. */
export function agentRunFailureDetails(run: AgentRunRecord): Readonly<Record<string, string>> {
  return run.kind === "conversation"
    ? { runId: run.id, threadId: run.threadId }
    : { parentRunId: run.parentRunId, runId: run.id }
}
