import { describe, expect, test } from "bun:test"
import { agentServiceAccountId } from "../src/agents/authority"
import type { Principal } from "../src/auth"
import { type AuthorizationContext, emptyGrantIndex } from "../src/authorization"
import { isSixbError } from "../src/errors/internal"
import { restoreAgentExecutionScope } from "../src/execution/agent"
import {
  assertExecutionScopeProject,
  createAgentRuntimeAuthorization,
  createDelegatedRuntimeAuthorization,
  createPrincipalRuntimeAuthorization,
  createTrustedPrimitiveRuntimeAuthorization,
  type DelegatedActionApplyTarget,
  getAuthorizationRef,
  resolveExecutionScopeAuthorization,
  resolveRuntimeAuthorization,
} from "../src/execution/authorization"
import {
  createPrimitiveExecutionRecord,
  executionRecordInputFromRuntime,
  restoreTrustedPrimitiveExecutionScope,
} from "../src/execution/durable"
import {
  createDelegatedRequestScope,
  createDisabledRequestScope,
  createKernelScope,
  createPrincipalRequestScope,
  createTestingScope,
} from "../src/execution/scopes"
import {
  createRuntimeAuthorizationCapability,
  type ExecutionContext,
  type ExecutionScope,
  type RuntimeAuthorization,
} from "../src/execution/types"
import type { SelectedObjectReadScope } from "../src/storage"

describe("runtime authorization capabilities", () => {
  test("snapshots principal authority and exposes only a defensive durable reference", () => {
    const context = authorizationContext({ type: "user", id: "user-1" }, "session-1")
    const groups = context.groupIds as string[]
    const agentGrants = context.grants["run:agent"] as Set<string>
    agentGrants.add("original-agent")
    const authorization = createPrincipalRuntimeAuthorization({
      execution: requestExecution("principal-snapshot", { type: "user", id: "user-1" }),
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
    expect(resolved.context.grants["run:agent"].has("original-agent")).toBe(true)

    const runtimeGrants = resolved.context.grants["run:agent"] as Set<string>
    expect(() => runtimeGrants.add("injected-agent")).toThrow(
      "Runtime authorization grants are immutable"
    )
    expect(() => runtimeGrants.delete("original-agent")).toThrow(
      "Runtime authorization grants are immutable"
    )
    expect(() => runtimeGrants.clear()).toThrow("Runtime authorization grants are immutable")
    expect(runtimeGrants.has("injected-agent")).toBe(false)
    expect(runtimeGrants.has("original-agent")).toBe(true)

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
        execution: requestExecution("system-principal"),
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
        execution: requestExecution("missing-session-credential", {
          type: "user",
          id: "user-1",
        }),
        context: authorizationContext({ type: "user", id: "user-1" }, "session-1"),
      })
    ).toThrow("Authorization context session requires a matching session credential")
    expect(() =>
      createPrincipalRuntimeAuthorization({
        execution: requestExecution("mismatched-session-credential", {
          type: "user",
          id: "user-1",
        }),
        context: authorizationContext({ type: "user", id: "user-1" }),
        credential: { type: "session", id: "session-1" },
      })
    ).toThrow("Session credential id must match the authorization context session id")
  })

  test("binds Agent authority to its definition-owned service account", () => {
    const execution: ExecutionContext = {
      id: "execution-agent-identity",
      projectId: "project-1",
      executor: { type: "agent", agentId: "research", runId: "run-1" },
      source: { type: "execution", executionId: "execution-parent" },
      correlationId: "correlation-1",
    }

    expect(() =>
      createAgentRuntimeAuthorization({
        execution,
        context: authorizationContext({ type: "serviceAccount", id: "svc_agent_other" }),
      })
    ).toThrow("must reference service account 'svc_agent_research'")
    expect(() =>
      createAgentRuntimeAuthorization({
        execution: { ...execution, source: { type: "event", eventId: "event-forged" } },
        context: authorizationContext({
          type: "serviceAccount",
          id: agentServiceAccountId("research"),
        }),
      })
    ).toThrow("agent authority does not match its execution binding")
  })
})

describe("execution scopes", () => {
  test("compiles and freezes process-local delegated object-read authority once", () => {
    const propertyIds = ["id"]
    const roots: SelectedObjectReadScope["roots"][number][] = [
      {
        anchor: { objectTypeId: "Proposal", primaryId: "proposal-1" },
        node: {
          objects: [{ objectTypeId: "Proposal", propertyIds }],
          links: [],
        },
      },
    ]
    const scope = createDelegatedRequestScope({
      projectId: "project-1",
      requestId: "delegated-request-1",
      correlationId: "delegated-correlation-1",
      objectRead: {
        selection: { kind: "selected", roots },
        limits: { maxTraversalFacts: 100, maxOutputJsonBytes: 1_024 },
      },
    })

    propertyIds.push("secret")
    roots.push({
      anchor: { objectTypeId: "Proposal", primaryId: "proposal-2" },
      node: {
        objects: [{ objectTypeId: "Proposal", propertyIds: ["id"] }],
        links: [],
      },
    })

    const resolved = resolveRuntimeAuthorization(scope.authorization)
    expect(resolved.type).toBe("delegated")
    if (resolved.type !== "delegated") throw new Error("expected delegated authorization")
    expect(resolved.objectRead.scope.roots).toHaveLength(1)
    expect(resolved.objectRead.scope.objects).toEqual([
      { nodeId: 0, objectTypeId: "Proposal", propertyIds: ["id"] },
    ])
    expect(resolved.objectRead.limits).toEqual({
      maxTraversalFacts: 100,
      maxOutputJsonBytes: 1_024,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.objectRead)).toBe(true)
    expect(Object.isFrozen(resolved.objectRead.scope)).toBe(true)
    expect(Object.isFrozen(resolved.objectRead.scope.roots)).toBe(true)
    expect(Object.isFrozen(resolved.objectRead.scope.objects[0]?.propertyIds)).toBe(true)
    expect(Object.isFrozen(resolved.objectRead.limits)).toBe(true)

    expect(() => getAuthorizationRef(scope.authorization)).toThrow(
      "cannot cross a durable execution boundary"
    )
    expect(() =>
      executionRecordInputFromRuntime({
        execution: scope.execution,
        runtimeAuthorization: scope.authorization,
      })
    ).toThrow("cannot cross a durable execution boundary")
  })

  test("snapshots and bounds exact delegated Action targets once", () => {
    let actionIdReads = 0
    let subjectReads = 0
    let objectTypeIdReads = 0
    let primaryIdReads = 0
    const subject = Object.defineProperties(
      {},
      {
        objectTypeId: {
          enumerable: true,
          get: () => {
            objectTypeIdReads += 1
            return "Proposal"
          },
        },
        primaryId: {
          enumerable: true,
          get: () => {
            primaryIdReads += 1
            return "proposal-1"
          },
        },
      }
    )
    const authoredTarget = Object.defineProperties(
      {},
      {
        actionId: {
          enumerable: true,
          get: () => {
            actionIdReads += 1
            return "approve"
          },
        },
        subject: {
          enumerable: true,
          get: () => {
            subjectReads += 1
            return subject
          },
        },
      }
    ) as DelegatedActionApplyTarget
    const targets: DelegatedActionApplyTarget[] = [authoredTarget]
    const scope = createDelegatedRequestScope({
      projectId: "project-1",
      requestId: "delegated-action-request",
      correlationId: "delegated-action-correlation",
      objectRead: {
        selection: delegatedSelection(),
        limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
      },
      actionApply: targets,
    })

    targets.push({
      actionId: "late-action",
      subject: { objectTypeId: "Proposal", primaryId: "proposal-late" },
    })

    const resolved = resolveRuntimeAuthorization(scope.authorization)
    expect(resolved.type).toBe("delegated")
    if (resolved.type !== "delegated") throw new Error("expected delegated authorization")
    expect(resolved.actionApply).toEqual([
      {
        actionId: "approve",
        subject: { objectTypeId: "Proposal", primaryId: "proposal-1" },
      },
    ])
    expect(actionIdReads).toBe(1)
    expect(subjectReads).toBe(1)
    expect(objectTypeIdReads).toBe(1)
    expect(primaryIdReads).toBe(1)
    expect(Object.isFrozen(resolved.actionApply)).toBe(true)
    expect(Object.isFrozen(resolved.actionApply[0])).toBe(true)
    expect(Object.isFrozen(resolved.actionApply[0]?.subject)).toBe(true)

    expect(() =>
      createDelegatedRequestScope({
        projectId: "project-1",
        requestId: "too-many-action-targets",
        correlationId: "too-many-action-targets",
        objectRead: {
          selection: delegatedSelection(),
          limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
        },
        actionApply: Array.from({ length: 4_097 }, () => ({
          actionId: "approve",
          subject: { objectTypeId: "Proposal", primaryId: "proposal-1" },
        })),
      })
    ).toThrow("maximum of 4096 Action targets")
    expect(() =>
      createDelegatedRequestScope({
        projectId: "project-1",
        requestId: "oversized-action-target",
        correlationId: "oversized-action-target",
        objectRead: {
          selection: delegatedSelection(),
          limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
        },
        actionApply: [
          {
            actionId: "a".repeat(1_000_001),
            subject: { objectTypeId: "Proposal", primaryId: "proposal-1" },
          },
        ],
      })
    ).toThrow("maximum of 1000000 Action identifier characters")
  })

  test("binds delegated authority only to its exact principal-free request", () => {
    const scope = createDelegatedRequestScope({
      projectId: "project-1",
      requestId: "delegated-request-bound",
      correlationId: "delegated-correlation-bound",
      objectRead: {
        selection: delegatedSelection(),
        limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
      },
    })
    const other = createDisabledRequestScope({
      projectId: "project-1",
      requestId: "delegated-request-other",
      correlationId: "delegated-correlation-other",
    })

    expect(() => resolveExecutionScopeAuthorization("project-1", scope)).not.toThrow()
    expect(() =>
      resolveExecutionScopeAuthorization("project-1", {
        execution: other.execution,
        authorization: scope.authorization,
      })
    ).toThrow("authority is bound to different execution provenance")
    expect(() =>
      createDelegatedRuntimeAuthorization({
        execution: requestExecution("delegated-principal", { type: "user", id: "user-1" }),
        objectRead: {
          selection: delegatedSelection(),
          limits: { maxTraversalFacts: 10, maxOutputJsonBytes: 1_024 },
        },
      })
    ).toThrow("requires a request execution without a principal")
  })

  test("durable serialization rejects a mismatched execution and authority pair", () => {
    const projectOne = createTestingScope({ projectId: "project-1" })
    const projectTwo = createTestingScope({ projectId: "project-2" })
    const principalOne = createTestingScope({
      projectId: "project-1",
      context: authorizationContext({ type: "user", id: "user-1" }),
    })
    const principalTwo = createTestingScope({
      projectId: "project-1",
      context: authorizationContext({ type: "user", id: "user-2" }),
    })

    expect(() =>
      executionRecordInputFromRuntime({
        execution: projectTwo.execution,
        runtimeAuthorization: projectOne.authorization,
      })
    ).toThrow("belongs to project 'project-1', not 'project-2'")
    expect(() =>
      executionRecordInputFromRuntime({
        execution: principalTwo.execution,
        runtimeAuthorization: principalOne.authorization,
      })
    ).toThrow("authority is bound to different execution provenance")
    expect(
      executionRecordInputFromRuntime({
        execution: projectOne.execution,
        runtimeAuthorization: projectOne.authorization,
      })
    ).toMatchObject({ projectId: "project-1", authorizationRef: { type: "disabled" } })
  })

  test("rejects mixing an execution with authority from another scope", () => {
    const principalScope = createTestingScope({
      projectId: "project-1",
      context: authorizationContext({ type: "user", id: "user-1" }),
    })
    const disabledScope = createTestingScope({ projectId: "project-1" })

    expect(() => resolveExecutionScopeAuthorization("project-1", principalScope)).not.toThrow()
    let error: unknown
    try {
      resolveExecutionScopeAuthorization("project-1", {
        execution: principalScope.execution,
        authorization: disabledScope.authorization,
      })
    } catch (cause) {
      error = cause
    }
    expect(isSixbError(error)).toBe(true)
    expect(error).toMatchObject({ code: "internal.unexpected" })
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("incompatible with its authority")
    )
  })

  test("binds request authority to exact id, source, and correlation provenance", () => {
    const context = authorizationContext({ type: "user", id: "user-1" })
    const scope = createTestingScope({
      projectId: "project-1",
      executionId: "execution-request-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      context,
    })
    const anotherExecution = createTestingScope({
      projectId: "project-1",
      executionId: "execution-request-2",
      requestId: "request-1",
      correlationId: "correlation-1",
      context,
    }).execution
    const forgedCorrelation: ExecutionContext = {
      ...scope.execution,
      correlationId: "correlation-forged",
    }
    const forgedSourceAndExecutor: ExecutionContext = {
      ...scope.execution,
      executor: { type: "request", requestId: "request-forged" },
      source: { type: "http", requestId: "request-forged" },
    }
    const forgedRequestedBy: ExecutionContext = {
      ...scope.execution,
      requestedBy: { type: "user", id: "user-forged" },
    }

    for (const execution of [
      anotherExecution,
      forgedCorrelation,
      forgedSourceAndExecutor,
      forgedRequestedBy,
    ]) {
      expect(() =>
        resolveExecutionScopeAuthorization("project-1", {
          execution,
          authorization: scope.authorization,
        })
      ).toThrow("authority is bound to different execution provenance")
    }

    expect(() =>
      executionRecordInputFromRuntime({
        execution: forgedCorrelation,
        runtimeAuthorization: scope.authorization,
      })
    ).toThrow("authority is bound to different execution provenance")
  })

  test("binds primitive and kernel authority to their complete execution provenance", () => {
    const primitive = { kind: "action", id: "send-email", runId: "action-run-1" } as const
    const primitiveScope = restoreTrustedPrimitiveExecutionScope({
      execution: {
        id: "execution-action-binding",
        projectId: "project-1",
        executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
        source: { type: "event", eventId: "event-1" },
        correlationId: "correlation-1",
        authorizationRef: { type: "trustedPrimitive", primitive },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      primitive,
    })
    const kernelScope = createKernelScope({
      projectId: "project-1",
      operation: { type: "ontology.recover", recoveryId: "recovery-1" },
      source: { type: "event", eventId: "event-1" },
      correlationId: "correlation-1",
    })

    for (const scope of [primitiveScope, kernelScope]) {
      expect(() =>
        resolveExecutionScopeAuthorization("project-1", {
          execution: { ...scope.execution, correlationId: "correlation-forged" },
          authorization: scope.authorization,
        })
      ).toThrow("authority is bound to different execution provenance")
    }
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
        execution: requestExecution("invalid-trusted-primitive"),
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

function requestExecution(
  id: string,
  requestedBy?: ExecutionContext["requestedBy"]
): ExecutionContext {
  return {
    id,
    projectId: "project-1",
    ...(requestedBy === undefined ? {} : { requestedBy }),
    executor: { type: "request", requestId: `request-${id}` },
    source: { type: "http", requestId: `request-${id}` },
    correlationId: `correlation-${id}`,
  }
}

function delegatedSelection(): SelectedObjectReadScope {
  return {
    kind: "selected",
    roots: [
      {
        anchor: { objectTypeId: "Proposal", primaryId: "proposal-1" },
        node: {
          objects: [{ objectTypeId: "Proposal", propertyIds: ["id"] }],
          links: [],
        },
      },
    ],
  }
}
