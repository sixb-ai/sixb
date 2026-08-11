import { randomUUID } from "node:crypto"
import type { AuthorizationContext } from "../authorization"
import {
  createDisabledRuntimeAuthorization,
  createKernelRuntimeAuthorization,
  createPrincipalRuntimeAuthorization,
  createTrustedPrimitiveRuntimeAuthorization,
} from "./authorization"
import type {
  AuthorizablePrincipal,
  AuthorizationRef,
  ExecutionContext,
  ExecutionScope,
  ExecutionSource,
  KernelOperation,
  TrustedPrimitiveRef,
} from "./types"

export function createPrincipalRequestScope(input: {
  readonly projectId: string
  readonly requestId: string
  readonly correlationId: string
  readonly context: AuthorizationContext
  readonly credential?: Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
}): ExecutionScope {
  const execution = createRequestExecution({
    projectId: input.projectId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    requestedBy: asAuthorizablePrincipal(input.context.principal),
  })

  return Object.freeze({
    execution,
    authorization: createPrincipalRuntimeAuthorization({
      projectId: input.projectId,
      context: input.context,
      ...(input.credential === undefined ? {} : { credential: input.credential }),
    }),
  })
}

export function createDisabledRequestScope(input: {
  readonly projectId: string
  readonly requestId: string
  readonly correlationId: string
}): ExecutionScope {
  return Object.freeze({
    execution: createRequestExecution(input),
    authorization: createDisabledRuntimeAuthorization(input.projectId),
  })
}

export function createTrustedPrimitiveScope(input: {
  readonly projectId: string
  readonly primitive: TrustedPrimitiveRef
  readonly source: ExecutionSource
  readonly requestedBy?: AuthorizablePrincipal
  readonly correlationId?: string
  readonly parentExecutionId?: string
}): ExecutionScope {
  const execution = createInternalExecution({
    projectId: input.projectId,
    requestedBy: input.requestedBy,
    executor: Object.freeze({
      type: "primitive",
      kind: input.primitive.kind,
      id: input.primitive.id,
      runId: input.primitive.runId,
    }),
    source: input.source,
    correlationId: input.correlationId,
    parentExecutionId: input.parentExecutionId,
  })
  return Object.freeze({
    execution,
    authorization: createTrustedPrimitiveRuntimeAuthorization({
      projectId: input.projectId,
      primitive: input.primitive,
    }),
  })
}

export function createAgentScope(input: {
  readonly projectId: string
  readonly agentId: string
  readonly runId: string
  readonly context: AuthorizationContext
  readonly source: ExecutionSource
  readonly requestedBy?: AuthorizablePrincipal
  readonly correlationId?: string
  readonly parentExecutionId?: string
}): ExecutionScope {
  if (input.context.principal.type !== "serviceAccount") {
    throw new Error("[Sixb] Agent execution authority must belong to a service account.")
  }
  assertNonEmpty(input.agentId, "Agent id")
  assertNonEmpty(input.runId, "Agent run id")
  const execution = createInternalExecution({
    projectId: input.projectId,
    requestedBy: input.requestedBy,
    executor: Object.freeze({ type: "agent", agentId: input.agentId, runId: input.runId }),
    source: input.source,
    correlationId: input.correlationId,
    parentExecutionId: input.parentExecutionId,
  })
  return Object.freeze({
    execution,
    authorization: createPrincipalRuntimeAuthorization({
      projectId: input.projectId,
      context: input.context,
    }),
  })
}

export function createKernelScope(input: {
  readonly projectId: string
  readonly operation: KernelOperation
  readonly source: ExecutionSource
  readonly correlationId?: string
}): ExecutionScope {
  const operation = Object.freeze({ ...input.operation })
  const execution = createInternalExecution({
    projectId: input.projectId,
    executor: Object.freeze({ type: "kernel", operation }),
    source: input.source,
    correlationId: input.correlationId,
  })
  return Object.freeze({
    execution,
    authorization: createKernelRuntimeAuthorization({ projectId: input.projectId, operation }),
  })
}

function createInternalExecution(input: {
  readonly projectId: string
  readonly requestedBy?: AuthorizablePrincipal
  readonly executor: Exclude<ExecutionContext["executor"], { readonly type: "request" }>
  readonly source: ExecutionSource
  readonly correlationId?: string
  readonly parentExecutionId?: string
}): ExecutionContext {
  const source = snapshotExecutionSource(input.source)
  assertNestedProvenance(source, input.parentExecutionId, input.correlationId)
  return freezeExecution({
    id: `exec_${randomUUID()}`,
    projectId: input.projectId,
    ...(input.requestedBy === undefined
      ? {}
      : { requestedBy: asAuthorizablePrincipal(input.requestedBy) }),
    executor: input.executor,
    source,
    correlationId: input.correlationId ?? `corr_${randomUUID()}`,
    ...(input.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: input.parentExecutionId }),
  })
}

function assertNestedProvenance(
  source: ExecutionSource,
  parentExecutionId: string | undefined,
  correlationId: string | undefined
): void {
  if (parentExecutionId !== undefined) {
    assertNonEmpty(parentExecutionId, "Parent execution id")
    if (correlationId === undefined) {
      throw new Error("[Sixb] Nested execution must preserve its parent correlation id.")
    }
  }
  if (source.type === "execution" && source.executionId !== parentExecutionId) {
    throw new Error("[Sixb] Execution source must match the direct parent execution id.")
  }
}

export function createTestingScope(input: {
  readonly projectId: string
  readonly context?: AuthorizationContext
  readonly executionId?: string
  readonly requestId?: string
  readonly correlationId?: string
}): ExecutionScope {
  const context = input.context ? withoutSession(input.context) : undefined
  const requestId = input.requestId ?? `test_request_${randomUUID()}`
  const execution = createRequestExecution({
    projectId: input.projectId,
    requestId,
    correlationId: input.correlationId ?? `test_correlation_${randomUUID()}`,
    ...(context === undefined ? {} : { requestedBy: asAuthorizablePrincipal(context.principal) }),
    executionId: input.executionId,
  })
  return Object.freeze({
    execution,
    authorization: context
      ? createPrincipalRuntimeAuthorization({ projectId: input.projectId, context })
      : createDisabledRuntimeAuthorization(input.projectId),
  })
}

function withoutSession(context: AuthorizationContext): AuthorizationContext {
  return {
    principal: context.principal,
    groupIds: context.groupIds,
    roleIds: context.roleIds,
    grants: context.grants,
  }
}

function createRequestExecution(input: {
  readonly projectId: string
  readonly requestId: string
  readonly correlationId: string
  readonly requestedBy?: AuthorizablePrincipal
  readonly executionId?: string
}): ExecutionContext {
  assertNonEmpty(input.projectId, "Execution project id")
  assertNonEmpty(input.requestId, "Execution request id")
  assertNonEmpty(input.correlationId, "Execution correlation id")
  const id = input.executionId ?? `exec_${randomUUID()}`
  assertNonEmpty(id, "Execution id")
  return freezeExecution({
    id,
    projectId: input.projectId,
    ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
    executor: Object.freeze({ type: "request", requestId: input.requestId }),
    source: Object.freeze({ type: "http", requestId: input.requestId }),
    correlationId: input.correlationId,
  })
}

function freezeExecution(execution: ExecutionContext): ExecutionContext {
  assertNonEmpty(execution.id, "Execution id")
  assertNonEmpty(execution.projectId, "Execution project id")
  assertNonEmpty(execution.correlationId, "Execution correlation id")
  if (execution.parentExecutionId !== undefined) {
    assertNonEmpty(execution.parentExecutionId, "Parent execution id")
  }
  return Object.freeze(execution)
}

function snapshotExecutionSource(source: ExecutionSource): ExecutionSource {
  const field = sourceIdentifier(source)
  assertNonEmpty(field.value, field.label)
  if (source.type === "queue") {
    assertNonEmpty(source.queue, "Execution source queue")
  }
  return Object.freeze({ ...source })
}

function sourceIdentifier(source: ExecutionSource): {
  readonly label: string
  readonly value: string
} {
  switch (source.type) {
    case "http":
      return { label: "Execution source request id", value: source.requestId }
    case "webhook":
      return { label: "Execution source delivery id", value: source.deliveryId }
    case "schedule":
    case "event":
      return { label: "Execution source event id", value: source.eventId }
    case "execution":
      return { label: "Execution source execution id", value: source.executionId }
    case "queue":
      return { label: "Execution source job id", value: source.jobId }
  }
}

function asAuthorizablePrincipal(
  principal: AuthorizationContext["principal"]
): AuthorizablePrincipal {
  if (principal.type !== "user" && principal.type !== "serviceAccount") {
    throw new Error(`[Sixb] Principal type '${principal.type}' cannot hold runtime authorization.`)
  }
  assertNonEmpty(principal.id, "Execution principal id")
  return Object.freeze({ type: principal.type, id: principal.id })
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`[Sixb] ${label} must not be empty.`)
  }
}
