import { randomUUID } from "node:crypto"
import type { AuthorizationContext } from "../authorization"
import type { ObjectReadExecutionLimits, SelectedObjectReadScope } from "../storage"
import {
  createDelegatedRuntimeAuthorization,
  createDisabledRuntimeAuthorization,
  createKernelRuntimeAuthorization,
  createPrincipalRuntimeAuthorization,
} from "./authorization"
import type {
  AuthorizablePrincipal,
  AuthorizationRef,
  ExecutionContext,
  ExecutionScope,
  ExecutionSource,
  KernelOperation,
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
      execution,
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
  const execution = createRequestExecution(input)
  return Object.freeze({
    execution,
    authorization: createDisabledRuntimeAuthorization(execution),
  })
}

/** Internal request scope carrying only a finite object-read selection. */
export function createDelegatedRequestScope(input: {
  readonly projectId: string
  readonly requestId: string
  readonly correlationId: string
  readonly objectRead: {
    readonly selection: SelectedObjectReadScope
    readonly limits: ObjectReadExecutionLimits
  }
}): ExecutionScope {
  const execution = createRequestExecution(input)
  return Object.freeze({
    execution,
    authorization: createDelegatedRuntimeAuthorization({
      execution,
      objectRead: input.objectRead,
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
  const execution = createKernelExecution({
    projectId: input.projectId,
    operation,
    source: input.source,
    correlationId: input.correlationId,
  })
  return Object.freeze({
    execution,
    authorization: createKernelRuntimeAuthorization({ execution, operation }),
  })
}

function createKernelExecution(input: {
  readonly projectId: string
  readonly operation: KernelOperation
  readonly source: ExecutionSource
  readonly correlationId?: string
}): ExecutionContext {
  const source = snapshotExecutionSource(input.source)
  assertNestedProvenance(source, input.correlationId)
  return freezeExecution({
    id: `exec_${randomUUID()}`,
    projectId: input.projectId,
    executor: Object.freeze({ type: "kernel", operation: input.operation }),
    source,
    correlationId: input.correlationId ?? `corr_${randomUUID()}`,
  })
}

function assertNestedProvenance(source: ExecutionSource, correlationId: string | undefined): void {
  if (source.type === "execution" && correlationId === undefined) {
    throw new Error("[Sixb] Nested execution must preserve its parent correlation id.")
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
      ? createPrincipalRuntimeAuthorization({ execution, context })
      : createDisabledRuntimeAuthorization(execution),
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
  return Object.freeze(execution)
}

function snapshotExecutionSource(source: ExecutionSource): ExecutionSource {
  const field = sourceIdentifier(source)
  assertNonEmpty(field.value, field.label)
  if (source.type === "datasetVersion") {
    assertNonEmpty(source.datasetId, "Execution source dataset id")
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
    case "datasetVersion":
      return { label: "Execution source dataset version id", value: source.versionId }
    case "execution":
      return { label: "Execution source execution id", value: source.executionId }
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
