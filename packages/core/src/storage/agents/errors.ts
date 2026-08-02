import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../../errors"

export type AgentStorageErrorReason =
  | "thread_not_found"
  | "active_run_exists"
  | "run_not_found"
  | "invalid_state"
  | "execution_lost"
  | "duplicate_id"

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
export class AgentStorageError extends SixbError {
  override readonly name = "AgentStorageError"

  constructor(
    readonly reason: AgentStorageErrorReason,
    message: string,
    options: SixbErrorOptions = {}
  ) {
    super(CODE_BY_REASON[reason], message, {
      ...options,
      details: { reason, ...options.details },
    })
  }
}
