import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../errors"

const AGENT_REQUEST_ERROR_REASONS = [
  "agent_not_found",
  "thread_not_found",
  "thread_agent_mismatch",
  "active_run_exists",
  "invalid_context",
  "storage_not_configured",
] as const

export type AgentRequestErrorReason = (typeof AGENT_REQUEST_ERROR_REASONS)[number]

const CODE_BY_REASON: Record<AgentRequestErrorReason, SixbErrorCode> = {
  agent_not_found: "agent.not_found",
  thread_not_found: "agent.thread_not_found",
  thread_agent_mismatch: "runtime.invalid_input",
  active_run_exists: "agent.run_conflict",
  invalid_context: "runtime.invalid_input",
  storage_not_configured: "runtime.not_configured",
}

/**
 * Raised by {@link requestAgentRun} (the trigger). Callers branch on `code` rather than message
 * text — e.g. the HTTP layer answers `agent.run_conflict` with 409 and `agent.not_found` with 404.
 */
export function agentRequestError(
  reason: AgentRequestErrorReason,
  message: string,
  options: SixbErrorOptions = {}
): SixbError {
  return new SixbError(CODE_BY_REASON[reason], message, {
    ...options,
    details: { reason, ...options.details },
  })
}
