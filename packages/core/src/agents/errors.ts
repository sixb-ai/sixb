/**
 * Base error for the agents module. Specific subclasses extend this so callers
 * can catch any agent-scoped failure with a single `instanceof AgentDefinitionError` check.
 */
export class AgentDefinitionError extends Error {
  readonly name: string = "AgentDefinitionError"
}

/**
 * An agent-tool failure whose message is intentionally safe to expose to the model and persist in
 * the durable trace. Tool authors must keep the message free of credentials and internal details;
 * unknown errors remain masked by the worker.
 */
export class AgentToolPublicError extends Error {
  readonly name: string = "AgentToolPublicError"
}

/** Raised when an agent tool result cannot cross the durable message boundary. */
export class AgentToolResultValidationError extends Error {
  readonly name = "AgentToolResultValidationError"

  constructor(
    readonly toolName: string,
    readonly reason: string,
    options?: ErrorOptions
  ) {
    super(`[Sixb] Agent tool '${toolName}' returned an invalid result; ${reason}.`, options)
  }
}

export type AgentRequestErrorCode =
  | "agent_selector_removed"
  | "agent_not_found"
  | "model_not_found"
  | "invalid_model_selection"
  | "invalid_locale"
  | "invalid_message"
  | "run_not_found"
  | "run_not_retryable"
  | "thread_not_found"
  | "active_run_exists"
  | "authority_not_inheritable"
  | "invalid_context"
  | "invalid_attachment"
  | "storage_unavailable"
  | "sandbox_not_configured"
  | "invalid_sandbox_params"
  | "sandbox_execution_unavailable"
  | "invalid_participant"
  | "not_thread_owner"
  | "not_run_requester"
  | "run_not_active"
  | "invalid_approval_mode"
  | "approval_not_found"
  | "approval_not_pending"
  | "approval_expired"

/**
 * Raised by {@link requestAgentRun} (the trigger). Callers branch on `code` rather than message text
 * — e.g. the HTTP layer maps `active_run_exists` to 409 and `agent_not_found` to 404.
 */
export class AgentRequestError extends Error {
  readonly name = "AgentRequestError"

  constructor(
    readonly code: AgentRequestErrorCode,
    message: string
  ) {
    super(message)
  }
}

export type AgentMemoryErrorCode =
  | "invalid_repo"
  | "invalid_save"
  | "not_allowed"
  | "storage_unavailable"

/**
 * Raised by `sixb.agent.memory`. Callers branch on `code`; the message says what to change, so the
 * HTTP layer can hand it to the Agent as it is.
 */
export class AgentMemoryError extends Error {
  readonly name = "AgentMemoryError"

  constructor(
    readonly code: AgentMemoryErrorCode,
    message: string
  ) {
    super(message)
  }
}
