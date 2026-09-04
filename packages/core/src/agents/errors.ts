/**
 * Base error for the agents module. Specific subclasses extend this so callers
 * can catch any agent-scoped failure with a single `instanceof AgentDefinitionError` check.
 */
export class AgentDefinitionError extends Error {
  readonly name: string = "AgentDefinitionError"
}

/**
 * Raised by the message adapters. `fromAiSdk` is **total**: rather than silently dropping a part it
 * cannot model, it throws this — which both prevents data loss and pinpoints exactly when the
 * {@link AgentMessage} part union must be extended. It also fires on transient/streaming parts that
 * must never be persisted, and on out-of-contract (non-JSON) payloads.
 */
export class AgentMessageAdapterError extends Error {
  readonly name = "AgentMessageAdapterError"
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
  | "agent_not_found"
  | "run_not_found"
  | "run_not_retryable"
  | "thread_not_found"
  | "thread_agent_mismatch"
  | "active_run_exists"
  | "authority_not_inheritable"
  | "invalid_context"
  | "storage_unavailable"

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
