import { describe, expect, test } from "bun:test"
import { agentServiceAccountId } from "../src/agents/authority"
import type { Principal } from "../src/auth"
import { type AuthorizationContext, emptyGrantIndex } from "../src/authorization"
import { restoreAgentExecutionScope } from "../src/execution/agent"
import {
  assertExecutionScopeProject,
  createPrincipalRuntimeAuthorization,
  createTrustedPrimitiveRuntimeAuthorization,
  getAuthorizationRef,
  resolveExecutionScopeAuthorization,
  resolveRuntimeAuthorization,
} from "../src/execution/authorization"
import {
  createPrimitiveExecutionRecord,
  restoreTrustedPrimitiveExecutionScope,
} from "../src/execution/durable"
import {
  createDisabledRequestScope,
  createKernelScope,
  createPrincipalRequestScope,
  createTestingScope,
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

describe("execution scopes", () => {
  test("rejects mixing an execution with authority from another scope", () => {
    const principalScope = createTestingScope({
      projectId: "project-1",
      context: authorizationContext({ type: "user", id: "user-1" }),
    })
    const disabledScope = createTestingScope({ projectId: "project-1" })

    expect(() => resolveExecutionScopeAuthorization("project-1", principalScope)).not.toThrow()
    expect(() =>
      resolveExecutionScopeAuthorization("project-1", {
        execution: principalScope.execution,
        authorization: disabledScope.authorization,
      })
    ).toThrow("incompatible with its authority")
  })

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
    const primitive = { kind: "action", id: "send-email", runId: "action-run-1" } as const
    const scope = restoreTrustedPrimitiveExecutionScope({
      execution: {
        id: "execution-action-1",
        projectId: "project-1",
        requestedBy: { type: "user", id: "user-1" },
        executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
        source: { type: "event", eventId: "event-1" },
        correlationId: "correlation-1",
        authorizationRef: { type: "trustedPrimitive", primitive },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      primitive,
    })

    expect(scope.execution).toMatchObject({
      executor: {
        type: "primitive",
        kind: "action",
        id: "send-email",
        runId: "action-run-1",
      },
      source: { type: "event", eventId: "event-1" },
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
    const principal = { type: "serviceAccount", id: agentServiceAccountId("research") } as const
    const scope = restoreAgentExecutionScope({
      agentId: "research",
      runId: "agent-run-1",
      authorization: authorizationContext(principal),
      execution: {
        id: "execution-agent-1",
        projectId: "project-1",
        requestedBy: { type: "user", id: "user-1" },
        executor: { type: "agent", runId: "agent-run-1" },
        source: { type: "execution", executionId: "execution-parent" },
        correlationId: "correlation-1",
        authorizationRef: { type: "principal", principal },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    })

    expect(scope.execution.executor).toEqual({
      type: "agent",
      agentId: "research",
      runId: "agent-run-1",
    })
    expect(scope.execution.requestedBy).toEqual({ type: "user", id: "user-1" })
    expect(scope.execution.source).toEqual({
      type: "execution",
      executionId: "execution-parent",
    })
    expect(scope.execution.correlationId).toBe("correlation-1")
    expect(getAuthorizationRef(scope.authorization)).toEqual({
      type: "principal",
      principal,
    })
    expect(Object.isFrozen(scope.execution.requestedBy)).toBe(true)
  })

  test("rejects trusted authority for agents", () => {
    const principal = { type: "serviceAccount", id: agentServiceAccountId("research") } as const
    expect(() =>
      restoreAgentExecutionScope({
        agentId: "research",
        runId: "agent-run-2",
        authorization: authorizationContext({ type: "user", id: "user-1" }),
        execution: {
          id: "execution-agent-2",
          projectId: "project-1",
          executor: { type: "agent", runId: "agent-run-2" },
          source: { type: "execution", executionId: "execution-parent" },
          correlationId: "correlation-1",
          authorizationRef: { type: "principal", principal },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      })
    ).toThrow("does not authorize Agent run")
    expect(() =>
      createTrustedPrimitiveRuntimeAuthorization({
        projectId: "project-1",
        primitive: { kind: "agent", id: "research", runId: "agent-run-2" } as never,
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

  test("derives nested primitive provenance from its durable parent", () => {
    const primitive = { kind: "workflow", id: "onboarding", runId: "workflow-run-1" } as const
    const execution = createPrimitiveExecutionRecord({
      id: "workflow-execution-1",
      primitive,
      origin: {
        type: "execution",
        parent: {
          id: "execution-parent",
          projectId: "project-1",
          requestedBy: { type: "user", id: "user-1" },
          executor: { type: "request", requestId: "request-1" },
          source: { type: "http", requestId: "request-1" },
          correlationId: "correlation-1",
          authorizationRef: { type: "disabled" },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      },
    })

    expect(execution).toMatchObject({
      source: { type: "execution", executionId: "execution-parent" },
      correlationId: "correlation-1",
      requestedBy: { type: "user", id: "user-1" },
    })
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
