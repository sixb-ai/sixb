export type AgentStorageErrorCode =
  | "thread_not_found"
  | "active_run_exists"
  | "run_not_found"
  | "invalid_input"
  | "invalid_state"
  | "execution_lost"
  | "duplicate_id"

/**
 * Error for agent-storage invariants and invalid state transitions (single-flight, execution
 * ownership, run lifecycle, message append). Callers branch on `code` rather than message text.
 */
export class AgentStorageError extends Error {
  readonly name = "AgentStorageError"

  constructor(
    readonly code: AgentStorageErrorCode,
    message: string
  ) {
    super(message)
  }
}
