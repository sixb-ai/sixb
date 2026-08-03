import {
  SixbError,
  type SixbErrorCode,
  type SixbErrorOptions,
  sixbFailureReason,
} from "../../errors"

export const AGENT_STORAGE_ERROR_REASONS = [
  "thread_not_found",
  "active_run_exists",
  "run_not_found",
  "invalid_state",
  "execution_lost",
  "duplicate_id",
] as const

export type AgentStorageErrorReason = (typeof AGENT_STORAGE_ERROR_REASONS)[number]

const CODE_BY_REASON: Record<AgentStorageErrorReason, SixbErrorCode> = {
  thread_not_found: "agent.thread_not_found",
  active_run_exists: "agent.run_conflict",
  run_not_found: "agent.run_not_found",
  invalid_state: "storage.conflict",
  execution_lost: "agent.execution_lost",
  duplicate_id: "storage.conflict",
}

/**
 * Error for agent-storage invariants and invalid state transitions (single-flight, execution
 * ownership, run lifecycle, message append).
 *
 * `reason` is the module's own finer discriminant and stays the thing callers inside the repo
 * branch on; `code` is what leaves the process.
 */
export function agentStorageError(
  reason: AgentStorageErrorReason,
  message: string,
  options: SixbErrorOptions = {}
): SixbError {
  return new SixbError(CODE_BY_REASON[reason], message, {
    ...options,
    details: { reason, ...options.details },
  })
}

/**
 * The agent-storage reason this failure carries, or `undefined` when it is not one of them.
 *
 * Six reasons across six codes, so the code alone cannot answer the question the worker actually
 * asks — "is this run still mine?" — which is why the reason travels in `details`.
 */
export function agentStorageErrorReason(error: unknown): AgentStorageErrorReason | undefined {
  return sixbFailureReason(error, AGENT_STORAGE_ERROR_REASONS)
}
