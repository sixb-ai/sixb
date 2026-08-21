import { describe, expect, test } from "bun:test"
import type { Principal } from "../src/auth"
import { type AuthorizationContext, emptyGrantIndex } from "../src/authorization"
import {
  assertExecutionScopeProject,
  createPrincipalRuntimeAuthorization,
  getAuthorizationRef,
  resolveRuntimeAuthorization,
} from "../src/execution/authorization"
import {
  createAgentScope,
  createDisabledRequestScope,
  createKernelScope,
  createPrincipalRequestScope,
  createTestingScope,
  createTrustedPrimitiveScope,
} from "../src/execution/scopes"
import {
  createRuntimeAuthorizationCapability,
  type ExecutionScope,
  type RuntimeAuthorization,
} from "../src/execution/types"

describe("runtime authorization capabilities", () => {
  test("snapshots principal authority and exposes only a defensive durable reference", () => {
    const context = authorizationContext({ type: "user", id: "user-1" }, "session-1")
    const groups = context.groupIds as string[]
    const agentGrants = context.grants["run:agent"] as Set<string>
    const authorization = createPrincipalRuntimeAuthorization({
      projectId: "project-1",
      context,
      credential: { type: "session", id: "session-1" },
    })

    groups.push("late-group")
    agentGrants.add("late-agent")

    const resolved = resolveRuntimeAuthorization(authorization)
    expect(resolved.type).toBe("principal")
    if (resolved.type !== "principal") throw new Error("expected principal authorization")
    expect(resolved.context.groupIds).toEqual(["group-1"])
    expect(resolved.context.grants["run:agent"].has("late-agent")).toBe(false)

    const firstRef = getAuthorizationRef(authorization)
    expect(firstRef).toEqual({
      type: "principal",
      principal: { type: "user", id: "user-1" },
      credential: { type: "session", id: "session-1" },
    })
    if (firstRef.type !== "principal") throw new Error("expected principal ref")
    const mutablePrincipal = firstRef.principal as { id: string }
    mutablePrincipal.id = "mutated"
    expect(getAuthorizationRef(authorization)).toEqual({
      type: "principal",
      principal: { type: "user", id: "user-1" },
      credential: { type: "session", id: "session-1" },
    })
  })

  test("rejects structurally forged capabilities", () => {
    const forged = {} as RuntimeAuthorization
    const unregistered = createRuntimeAuthorizationCapability()
    expect(resolveRuntimeAuthorization(undefined)).toEqual({ type: "denied" })
    expect(resolveRuntimeAuthorization(forged)).toEqual({ type: "denied" })
    expect(resolveRuntimeAuthorization(unregistered)).toEqual({ type: "denied" })
    expect(() => getAuthorizationRef(forged)).toThrow("not a registered Core capability")

    const legitimate = createTestingScope({ projectId: "project-1" })
    const serialized = JSON.parse(JSON.stringify(legitimate.authorization))
    expect(resolveRuntimeAuthorization(serialized)).toEqual({ type: "denied" })
    const forgedScope: ExecutionScope = { execution: legitimate.execution, authorization: forged }
    expect(() => assertExecutionScopeProject("project-1", forgedScope)).toThrow(
      "unregistered runtime authorization"
    )
  })

  test("keeps execution identity and authority inside one project", () => {
    const projectOne = createTestingScope({ projectId: "project-1" })
    const projectTwo = createTestingScope({ projectId: "project-2" })

    expect(() => assertExecutionScopeProject("project-1", projectOne)).not.toThrow()
    expect(() => assertExecutionScopeProject("project-2", projectOne)).toThrow(
      "Execution scope belongs to project 'project-1', not 'project-2'"
    )
    expect(() =>
      assertExecutionScopeProject("project-1", {
        execution: projectOne.execution,
        authorization: projectTwo.authorization,
      })
    ).toThrow("Execution authorization belongs to project 'project-2', not 'project-1'")
  })

  test("rejects system principals and invalid authority identifiers", () => {
    expect(() =>
      createPrincipalRuntimeAuthorization({
        projectId: "project-1",
        context: authorizationContext({ type: "system", id: "system" }),
      })
    ).toThrow("Principal type 'system' cannot hold runtime authorization")
    expect(() => createTestingScope({ projectId: " " })).toThrow(
      "Execution project id must not be empty"
    )
  })

  test("rejects inconsistent session credential references", () => {
    expect(() =>
      createPrincipalRuntimeAuthorization({
        projectId: "project-1",
        context: authorizationContext({ type: "user", id: "user-1" }, "session-1"),
      })
    ).toThrow("Authorization context session requires a matching session credential")
    expect(() =>
      createPrincipalRuntimeAuthorization({
        projectId: "project-1",
        context: authorizationContext({ type: "user", id: "user-1" }),
        credential: { type: "session", id: "session-1" },
      })
    ).toThrow("Session credential id must match the authorization context session id")
  })
})

describe("execution scope factories", () => {
  test("creates a principal request scope with explicit request provenance", () => {
    const scope = createPrincipalRequestScope({
      projectId: "project-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      context: authorizationContext({ type: "serviceAccount", id: "service-account-1" }),
      credential: { type: "accessToken", id: "access-token-1" },
    })

    expect(scope.execution).toMatchObject({
      projectId: "project-1",
      requestedBy: { type: "serviceAccount", id: "service-account-1" },
      executor: { type: "request", requestId: "request-1" },
      source: { type: "http", requestId: "request-1" },
      correlationId: "correlation-1",
    })
    expect(scope.execution.id).toStartWith("exec_")
    expect(getAuthorizationRef(scope.authorization)).toEqual({
      type: "principal",
      principal: { type: "serviceAccount", id: "service-account-1" },
      credential: { type: "accessToken", id: "access-token-1" },
    })
  })

  test("models disabled auth explicitly instead of omitting authority", () => {
    const scope = createDisabledRequestScope({
      projectId: "project-1",
      requestId: "request-1",
      correlationId: "correlation-1",
    })

    expect(getAuthorizationRef(scope.authorization)).toEqual({ type: "disabled" })
    expect(resolveRuntimeAuthorization(scope.authorization).type).toBe("unrestricted")
  })

  test("creates synthetic principal test scopes without live session identity", () => {
    const scope = createTestingScope({
      projectId: "project-1",
      context: authorizationContext({ type: "user", id: "user-1" }, "session-1"),
    })

    expect(getAuthorizationRef(scope.authorization)).toEqual({
      type: "principal",
      principal: { type: "user", id: "user-1" },
    })
    const resolved = resolveRuntimeAuthorization(scope.authorization)
    expect(resolved.type).toBe("principal")
    if (resolved.type !== "principal") throw new Error("expected principal authorization")
    expect(resolved.context.sessionId).toBeUndefined()
  })

  test("creates an immutable trusted primitive scope", () => {
    const scope = createTrustedPrimitiveScope({
      projectId: "project-1",
      primitive: { kind: "action", id: "send-email", runId: "action-run-1" },
      source: { type: "queue", queue: "actions", jobId: "job-1" },
      requestedBy: { type: "user", id: "user-1" },
      correlationId: "correlation-1",
    })

    expect(scope.execution).toMatchObject({
      executor: {
        type: "primitive",
        kind: "action",
        id: "send-email",
        runId: "action-run-1",
      },
      source: { type: "queue", queue: "actions", jobId: "job-1" },
      requestedBy: { type: "user", id: "user-1" },
      correlationId: "correlation-1",
    })
    expect(getAuthorizationRef(scope.authorization)).toEqual({
      type: "trustedPrimitive",
      primitive: { kind: "action", id: "send-email", runId: "action-run-1" },
    })
    expect(Object.isFrozen(scope)).toBe(true)
    expect(Object.isFrozen(scope.execution)).toBe(true)
    expect(Object.isFrozen(scope.execution.executor)).toBe(true)
    expect(Object.isFrozen(scope.execution.source)).toBe(true)
    expect(Object.isFrozen(scope.execution.requestedBy)).toBe(true)
  })

  test("runs agents with service-account authority", () => {
    const parent = createTestingScope({
      projectId: "project-1",
      context: authorizationContext({ type: "user", id: "user-1" }),
      executionId: "execution-parent",
      requestId: "request-parent",
      correlationId: "correlation-1",
    })
    const scope = createAgentScope({
      projectId: "project-1",
      agentId: "research",
      runId: "agent-run-1",
      context: authorizationContext({
        type: "serviceAccount",
        id: "agent-service-account",
      }),
      source: { type: "execution", executionId: parent.execution.id },
      requestedBy: { type: "user", id: "user-1" },
      correlationId: parent.execution.correlationId,
    })

    expect(scope.execution.executor).toEqual({
      type: "agent",
      agentId: "research",
      runId: "agent-run-1",
    })
    expect(scope.execution.requestedBy).toEqual({ type: "user", id: "user-1" })
    expect(scope.execution.source).toEqual({
      type: "execution",
      executionId: parent.execution.id,
    })
    expect(scope.execution.correlationId).toBe(parent.execution.correlationId)
    expect(getAuthorizationRef(scope.authorization)).toEqual({
      type: "principal",
      principal: { type: "serviceAccount", id: "agent-service-account" },
    })
  })

  test("rejects trusted authority for agents", () => {
    expect(() =>
      createAgentScope({
        projectId: "project-1",
        agentId: "research",
        runId: "agent-run-2",
        context: authorizationContext({ type: "user", id: "user-1" }),
        source: { type: "queue", queue: "agents", jobId: "job-2" },
      })
    ).toThrow("Agent execution authority must belong to a service account")
    expect(() =>
      createTrustedPrimitiveScope({
        projectId: "project-1",
        primitive: { kind: "agent", id: "research", runId: "agent-run-2" } as never,
        source: { type: "queue", queue: "agents", jobId: "job-2" },
      })
    ).toThrow("Unknown trusted primitive kind 'agent'")
  })

  test("creates an explicit kernel recovery scope", () => {
    const scope = createKernelScope({
      projectId: "project-1",
      operation: { type: "ontology.recover", recoveryId: "recovery-1" },
      source: { type: "event", eventId: "event-1" },
    })

    expect(scope.execution.executor).toEqual({
      type: "kernel",
      operation: { type: "ontology.recover", recoveryId: "recovery-1" },
    })
    expect(getAuthorizationRef(scope.authorization)).toEqual({
      type: "kernel",
      operation: { type: "ontology.recover", recoveryId: "recovery-1" },
    })
  })

  test("requires nested scopes to preserve a parent correlation id", () => {
    const primitive = { kind: "workflow", id: "onboarding", runId: "workflow-run-1" } as const

    expect(() =>
      createTrustedPrimitiveScope({
        projectId: "project-1",
        primitive,
        source: { type: "execution", executionId: "execution-parent" },
      })
    ).toThrow("Nested execution must preserve its parent correlation id")
    expect(
      createTrustedPrimitiveScope({
        projectId: "project-1",
        primitive,
        source: { type: "queue", queue: "workflows", jobId: "job-1" },
      })
    ).toMatchObject({ execution: { source: { type: "queue", jobId: "job-1" } } })
  })
})

function authorizationContext(principal: Principal, sessionId?: string): AuthorizationContext {
  return {
    principal,
    ...(sessionId === undefined ? {} : { sessionId }),
    groupIds: ["group-1"],
    roleIds: ["role-1"],
    grants: emptyGrantIndex(),
  }
}
