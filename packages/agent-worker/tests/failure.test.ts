import { describe, expect, test } from "bun:test"
import { createSixbError } from "@sixb/core/internal/errors"
import { AgentRuntimeProfileError } from "../src/agent-runtime/errors"
import { AGENT_RUNTIME_PROFILE } from "../src/agent-runtime/profile"
import { toAgentExecutionFailure } from "../src/failure"

const at = new Date("2026-08-14T12:00:00.000Z")
const details = {
  actorId: "assistant",
  runId: "agt_run_1",
  threadId: "agt_thr_1",
}

describe("Agent execution failure", () => {
  test("classifies native active-execution errors without exposing their message", () => {
    const error = new Error("provider unavailable")

    expect(toAgentExecutionFailure(error, { status: "failed", at, details })).toEqual({
      code: "agent.execution_failed",
      message: "Agent execution failed.",
      retryable: false,
      at: at.toISOString(),
      details,
    })
  })

  test("preserves coded internal invariants without exposing their message", () => {
    const error = createSixbError("internal.unexpected", "Execution state is inconsistent.", {
      details: { actorId: details.actorId, runId: details.runId },
    })

    expect(toAgentExecutionFailure(error, { status: "failed", at, details })).toEqual({
      code: "internal.unexpected",
      message: "An unexpected internal error occurred.",
      retryable: false,
      at: at.toISOString(),
      details: { actorId: details.actorId, runId: details.runId },
    })
  })

  test("keeps cancellation in the runtime vocabulary", () => {
    expect(
      toAgentExecutionFailure(new Error("Run cancelled."), {
        status: "cancelled",
        at,
        details,
      })
    ).toEqual({
      code: "runtime.cancelled",
      message: "Execution was cancelled.",
      retryable: false,
      at: at.toISOString(),
      details,
    })
  })

  test("records actionable runtime-profile context without exposing a gateway URL", () => {
    const error = new AgentRuntimeProfileError(
      "smolvm",
      "javascript-runtime",
      "unsupported-version"
    )
    const failure = toAgentExecutionFailure(error, { status: "failed", at, details })

    expect(failure).toEqual({
      code: "agent.execution_failed",
      message: "Agent execution failed.",
      retryable: false,
      at: at.toISOString(),
      details: {
        ...details,
        provider: "smolvm",
        runtimeProfile: AGENT_RUNTIME_PROFILE,
        runtimeCheck: "javascript-runtime",
        runtimeFailure: "unsupported-version",
        remediation: "Provide Bun 1.3+ or Node 22+ in the configured sandbox host or image.",
      },
    })
    expect(JSON.stringify(failure)).not.toContain("http")
  })
})
