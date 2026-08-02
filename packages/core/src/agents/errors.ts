import {
  SixbError,
  type SixbErrorCode,
  type SixbErrorOptions,
  SixbValidationError,
} from "../errors"

/**
 * Base error for the agents module. Specific subclasses extend this so callers
 * can catch any agent-scoped failure with a single `instanceof AgentDefinitionError` check.
 */
export class AgentDefinitionError extends SixbValidationError {
  override readonly name: string = "AgentDefinitionError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}

/**
 * Raised by the message adapters. `fromAiSdk` is **total**: rather than silently dropping a part it
 * cannot model, it throws this — which both prevents data loss and pinpoints exactly when the
 * {@link AgentMessage} part union must be extended. It also fires on transient/streaming parts that
 * must never be persisted, and on out-of-contract (non-JSON) payloads.
 */
export class AgentMessageAdapterError extends SixbValidationError {
  override readonly name = "AgentMessageAdapterError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_input", message, options)
  }
}

export type AgentRequestErrorReason =
  | "agent_not_found"
  | "thread_not_found"
  | "thread_agent_mismatch"
  | "active_run_exists"
  | "invalid_context"
  | "storage_unavailable"

const CODE_BY_REASON: Record<AgentRequestErrorReason, SixbErrorCode> = {
  agent_not_found: "agent.not_found",
  thread_not_found: "agent.thread_not_found",
  thread_agent_mismatch: "runtime.invalid_input",
  active_run_exists: "agent.run_conflict",
  invalid_context: "runtime.invalid_input",
  storage_unavailable: "storage.unavailable",
}

/**
 * Raised by {@link requestAgentRun} (the trigger). Callers branch on `code` rather than message
 * text — e.g. the HTTP layer answers `agent.run_conflict` with 409 and `agent.not_found` with 404.
 */
export class AgentRequestError extends SixbError {
  override readonly name = "AgentRequestError"

  constructor(
    readonly reason: AgentRequestErrorReason,
    message: string,
    options: SixbErrorOptions = {}
  ) {
    super(CODE_BY_REASON[reason], message, {
      ...options,
      details: { reason, ...options.details },
    })
  }
}
