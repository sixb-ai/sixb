import { describe, expect, test } from "bun:test"
import { AGENT_RUNTIME_PROFILE } from "@sixb/cli-core"
import { aiUsageLimitExceededError } from "@sixb/core/internal/ai-limit-enforcement"
import { createSixbError } from "@sixb/core/internal/errors"
import { AgentRuntimeProfileError } from "../src/agent-runtime/errors"
import { type AgentRunFailure, toAgentExecutionFailure } from "../src/failure"

const at = new Date("2026-08-14T12:00:00.000Z")
const details = {
  actorId: "assistant",
  runId: "agt_run_1",
  threadId: "agt_thr_1",
}

describe("Agent execution failure", () => {
  test.each<{
    readonly error: string
    readonly cause: unknown
    readonly failure: Omit<AgentRunFailure, "retryable" | "at">
  }>([
    {
      error: "a native active-execution error",
      cause: new Error("provider unavailable"),
      failure: { code: "agent.execution_failed", message: "Agent execution failed.", details },
    },
    {
      error: "a coded internal invariant",
      cause: createSixbError("internal.unexpected", "Execution state is inconsistent.", {
        details: { actorId: details.actorId, runId: details.runId },
      }),
      failure: {
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        details: { actorId: details.actorId, runId: details.runId },
      },
    },
    {
      error: "an AI usage-limit failure",
      cause: aiUsageLimitExceededError(new Date("2026-09-01T00:00:00.000Z")),
      failure: {
        code: "ai.usage_limit_exceeded",
        message: "AI usage limit exceeded.",
        details: { resetAt: "2026-09-01T00:00:00.000Z" },
      },
    },
    {
      error: "a runtime-profile failure",
      cause: new AgentRuntimeProfileError("smolvm", "javascript-runtime", "unsupported-version"),
      failure: {
        code: "agent.execution_failed",
        message: "Agent execution failed.",
        details: {
          ...details,
          provider: "smolvm",
          runtimeProfile: AGENT_RUNTIME_PROFILE,
          runtimeCheck: "javascript-runtime",
          runtimeFailure: "unsupported-version",
          remediation: "Provide Bun 1.3+ or Node 22+ in the configured sandbox host or image.",
        },
      },
    },
  ])("records $error without exposing its message", ({ cause, failure }) => {
    const recorded = toAgentExecutionFailure(cause, { status: "failed", at, details })
    expect(recorded).toEqual({ ...failure, retryable: false, at: at.toISOString() })
    expect(JSON.stringify(recorded)).not.toContain("http")
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
})
