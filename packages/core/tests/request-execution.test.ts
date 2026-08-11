import { describe, expect, test } from "bun:test"
import { AuthorizationError, emptyGrantIndex, type OntologySource, Sixb } from "../src"
import { bindRequestExecution } from "../src/execution/request"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const principal = { type: "user", id: "user-1" } as const

function createRuntime(): Sixb<readonly OntologySource[]> {
  return new Sixb<readonly OntologySource[]>({
    id: "request-boundary-test",
    ontology: [],
    ...createTestRuntimeDeps(),
  })
}

describe("request execution boundary", () => {
  test("binds request provenance and principal authority once", () => {
    const sixb = createRuntime()
    const sdk = bindRequestExecution(sixb, {
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

    expect(sdk.execution).toMatchObject({
      projectId: sixb.id,
      requestedBy: principal,
      executor: { type: "request", requestId: "req-123" },
      source: { type: "http", requestId: "req-123" },
      correlationId: "corr-456",
    })
    expect(sdk.execution.id).toStartWith("exec_")
    expect("authorization" in sdk).toBe(false)
    expect("storage" in sdk).toBe(false)
    expect(() => sdk.logs.read()).toThrow(AuthorizationError)
  })

  test("models auth-disabled requests explicitly and defaults correlation to request id", () => {
    const sixb = createRuntime()
    const sdk = bindRequestExecution(sixb, {
      request: new Request("http://localhost/api/events", {
        headers: { "x-request-id": "req-disabled" },
      }),
      authorization: { type: "disabled" },
    })

    expect(sdk.execution).toMatchObject({
      projectId: sixb.id,
      executor: { type: "request", requestId: "req-disabled" },
      source: { type: "http", requestId: "req-disabled" },
      correlationId: "req-disabled",
    })
    expect(sdk.execution.id).toStartWith("exec_")
    expect(sdk.objects.listTypes()).toEqual([])
  })

  test("generates a non-empty request id when the ingress does not provide one", () => {
    const sdk = bindRequestExecution(createRuntime(), {
      request: new Request("http://localhost/api/events"),
      authorization: { type: "disabled" },
    })

    expect(sdk.execution.id).toStartWith("exec_")
    expect(sdk.execution.executor).toMatchObject({ type: "request" })
    if (sdk.execution.executor.type !== "request") throw new Error("Expected request executor")
    expect(sdk.execution.executor.requestId).toStartWith("req_")
    expect(sdk.execution.correlationId).toBe(sdk.execution.executor.requestId)
  })
})
