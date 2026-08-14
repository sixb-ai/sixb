import { describe, expect, test } from "bun:test"
import { AuthorizationError, emptyGrantIndex, type OntologySource, SixbHost } from "../src"
import { bindRequestExecution } from "../src/execution/request"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const principal = { type: "user", id: "user-1" } as const

function createRuntime(): SixbHost<readonly OntologySource[]> {
  return new SixbHost<readonly OntologySource[]>({
    id: "request-boundary-test",
    ontology: [],
    ...createTestRuntimeDeps(),
  })
}

describe("request execution boundary", () => {
  test("binds request provenance and principal authority once", () => {
    const host = createRuntime()
    const sixb = bindRequestExecution(host, {
      request: new Request("http://localhost/api/objects", {
        headers: {
          "x-request-id": "  req-123  ",
          "x-correlation-id": " corr-456 ",
        },
      }),
      authorization: {
        type: "principal",
        context: {
          principal,
          sessionId: "session-1",
          groupIds: [],
          roleIds: [],
          grants: emptyGrantIndex(),
        },
        credential: { type: "session", id: "session-1" },
      },
    })

    expect(sixb.execution).toMatchObject({
      projectId: host.id,
      requestedBy: principal,
      executor: { type: "request", requestId: "req-123" },
      source: { type: "http", requestId: "req-123" },
      correlationId: "corr-456",
    })
    expect(sixb.execution.id).toStartWith("exec_")
    expect("authorization" in sixb).toBe(false)
    expect("storage" in sixb).toBe(false)
    expect(() => sixb.logs.read()).toThrow(AuthorizationError)
  })

  test("models auth-disabled requests explicitly and defaults correlation to request id", () => {
    const host = createRuntime()
    const sixb = bindRequestExecution(host, {
      request: new Request("http://localhost/api/events", {
        headers: { "x-request-id": "req-disabled" },
      }),
      authorization: { type: "disabled" },
    })

    expect(sixb.execution).toMatchObject({
      projectId: host.id,
      executor: { type: "request", requestId: "req-disabled" },
      source: { type: "http", requestId: "req-disabled" },
      correlationId: "req-disabled",
    })
    expect(sixb.execution.id).toStartWith("exec_")
    expect(sixb.objects.listTypes()).toEqual([])
  })

  test("generates a non-empty request id when the ingress does not provide one", () => {
    const sixb = bindRequestExecution(createRuntime(), {
      request: new Request("http://localhost/api/events"),
      authorization: { type: "disabled" },
    })

    expect(sixb.execution.id).toStartWith("exec_")
    expect(sixb.execution.executor).toMatchObject({ type: "request" })
    if (sixb.execution.executor.type !== "request") throw new Error("Expected request executor")
    expect(sixb.execution.executor.requestId).toStartWith("req_")
    expect(sixb.execution.correlationId).toBe(sixb.execution.executor.requestId)
  })
})
