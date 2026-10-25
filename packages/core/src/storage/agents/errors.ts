export type AgentStorageErrorCode =
  | "thread_not_found"
  /** A conversation's operation on a sub-agent's thread: a turn, a fork, a participant. */
  | "thread_not_conversation"
  | "active_run_exists"
  | "active_child_limit"
  | "run_not_found"
  | "invalid_input"
  | "invalid_state"
  | "execution_lost"
  | "duplicate_id"
  | "participant_limit"

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
