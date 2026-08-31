import type { SixbFailure } from "@sixb/core"
import {
  captureSixbFailure,
  createSixbError,
  isSixbError,
  summarizeErrorMessage,
} from "@sixb/core/internal/errors"
import { AGENT_RUN_FAILURE_CODES, type AgentRunFailureCode } from "@sixb/core/storage"
import { AgentRuntimeProfileError } from "./agent-runtime/errors"

export type AgentRunFailure = SixbFailure<AgentRunFailureCode>

interface AgentFailureInput {
  readonly status: "failed" | "cancelled"
  readonly at: Date
  readonly details: Readonly<Record<string, string>>
}

/** Normalize a failure without changing its classification. Used outside active execution. */
export function toAgentRunFailure(error: unknown, input: AgentFailureInput): AgentRunFailure {
  const failureCode = input.status === "cancelled" ? "runtime.cancelled" : "internal.unexpected"
  return captureSixbFailure(error, {
    allowedCodes: AGENT_RUN_FAILURE_CODES,
    defaultCode: failureCode,
    details: input.details,
    at: input.at,
  })
}

/** Classify only work performed by an active Agent execution. */
export function toAgentExecutionFailure(error: unknown, input: AgentFailureInput): AgentRunFailure {
  const failureError =
    input.status === "failed" ? translateAgentExecutionError(error, input.details) : error
  return toAgentRunFailure(failureError, input)
}

function translateAgentExecutionError(
  error: unknown,
  details: Readonly<Record<string, string>>
): unknown {
  if (error instanceof AgentRuntimeProfileError) {
    return createSixbError("agent.execution_failed", error.message, {
      cause: error,
      details: {
        ...details,
        provider: error.provider,
        runtimeProfile: error.profile,
        runtimeCheck: error.check,
        runtimeFailure: error.reason,
        ...(error.exitCode === undefined ? {} : { runtimeExitCode: String(error.exitCode) }),
        remediation: error.remediation,
      },
    })
  }

  if (
    isSixbError(error) &&
    (error.code === "internal.unexpected" || error.code === "agent.execution_failed")
  ) {
    return error
  }

  return createSixbError(
    "agent.execution_failed",
    summarizeErrorMessage(error, "Agent execution failed."),
    { cause: error, details }
  )
}
