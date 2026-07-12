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
