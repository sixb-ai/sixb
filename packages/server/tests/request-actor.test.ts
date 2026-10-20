import { describe, expect, test } from "bun:test"
import { SYSTEM_PRINCIPAL } from "@sixb/core"
import type { ExecutionContext } from "@sixb/core/internal/request-execution"
import { requestActor } from "../src/auth/scope"

const requester = { type: "user", id: "usr_requester" } as const

describe("requestActor", () => {
  // Removal proof: return `requestedBy ?? SYSTEM_PRINCIPAL` for every executor and the first test
  // fails — a workflow AI task's cancellations and upload sessions would name the workflow's
  // requester instead of the task's own service account.
  test("names a managed Agent run's service account, not the requester", () => {
    const actor = requestActor({
      execution: execution({ type: "agent", actorId: "assistant", runId: "node-1" }),
    })

    expect(actor).toEqual({ type: "serviceAccount", id: "svc_agent_assistant" })
  })

  test("names the requester for a conversation Agent and a direct request", () => {
    expect(requestActor({ execution: execution({ type: "agent", runId: "run-1" }) })).toEqual(
      requester
    )
    expect(
      requestActor({ execution: execution({ type: "request", requestId: "request-1" }) })
    ).toEqual(requester)
  })

  test("names the system when nobody requested the work", () => {
    const { requestedBy: _requestedBy, ...unrequested } = execution({
      type: "request",
      requestId: "request-1",
    })

    expect(requestActor({ execution: unrequested })).toEqual(SYSTEM_PRINCIPAL)
  })
})

function execution(executor: ExecutionContext["executor"]): ExecutionContext {
  return {
    id: "execution-1",
    projectId: "project-1",
    requestedBy: requester,
    executor,
    source: { type: "execution", executionId: "execution-parent" },
    correlationId: "correlation-1",
  }
}
