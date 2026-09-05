import { isDeepStrictEqual } from "node:util"
import { agentServiceAccountId } from "../agents/identity"
import type { Principal } from "../auth"
import { GRANT_KIND_KEYS, type GrantKind } from "../authorization/grant-kinds"
import type { AuthorizationContext, GrantIndex } from "../authorization/types"
import { createSixbError } from "../errors/internal"
import {
  type AuthorizablePrincipal,
  type AuthorizationRef,
  createRuntimeAuthorizationCapability,
  type ExecutionContext,
  type ExecutionScope,
  isRuntimeAuthorizationCapability,
  type KernelOperation,
  type RuntimeAuthorization,
  type TrustedPrimitiveKind,
  type TrustedPrimitiveRef,
} from "./types"

export type ResolvedRuntimeAuthorization =
  | {
      readonly type: "principal"
      readonly projectId: string
      readonly context: AuthorizationContext
      readonly ref: Extract<AuthorizationRef, { readonly type: "principal" }>
    }
  | {
      readonly type: "unrestricted"
      readonly projectId: string
      readonly ref: Exclude<AuthorizationRef, { readonly type: "principal" }>
    }
  | { readonly type: "denied" }

type RegisteredRuntimeAuthorization = Exclude<
  ResolvedRuntimeAuthorization,
  { readonly type: "denied" }
>

type PrincipalAuthorizationContext = Omit<AuthorizationContext, "principal"> & {
  readonly principal: AuthorizablePrincipal
}

interface RuntimeAuthorizationRegistration {
  readonly resolved: RegisteredRuntimeAuthorization
  readonly execution: ExecutionContext
}

const registeredAuthorizations = new WeakMap<
  RuntimeAuthorization,
  RuntimeAuthorizationRegistration
>()

export function createPrincipalRuntimeAuthorization(input: {
  readonly execution: ExecutionContext
  readonly context: AuthorizationContext
  readonly credential?: Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
}): RuntimeAuthorization {
  if (input.execution.executor.type !== "request") {
    throw new Error("[Sixb] Principal runtime authorization requires a request execution.")
  }
  return createRegisteredPrincipalAuthorization(input)
}

/** Register service-account authority bound to one exact agent run. */
export function createAgentRuntimeAuthorization(input: {
  readonly execution: ExecutionContext
  readonly context: AuthorizationContext
}): RuntimeAuthorization {
  if (input.context.principal.type !== "serviceAccount") {
    throw new Error("[Sixb] Agent execution authority must belong to a service account.")
  }
  if (input.execution.executor.type !== "agent") {
    throw new Error("[Sixb] Agent runtime authorization requires an Agent execution.")
  }
  const expectedPrincipalId = agentServiceAccountId(input.execution.executor.agentId)
  if (input.context.principal.id !== expectedPrincipalId) {
    throw new Error(
      `[Sixb] Agent '${input.execution.executor.agentId}' execution authority must reference service account '${expectedPrincipalId}'.`
    )
  }
  return createRegisteredPrincipalAuthorization(input)
}

function createRegisteredPrincipalAuthorization(input: {
  readonly execution: ExecutionContext
  readonly context: AuthorizationContext
  readonly credential?: Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
}): RuntimeAuthorization {
  const context = snapshotAuthorizationContext(input.context)
  const credential = input.credential ? snapshotCredential(input.credential) : undefined
  assertCredentialMatchesContext(context, credential)
  const ref: Extract<AuthorizationRef, { readonly type: "principal" }> = Object.freeze({
    type: "principal",
    principal: context.principal,
    ...(credential === undefined ? {} : { credential }),
  })
  return register(input.execution, {
    type: "principal",
    projectId: input.execution.projectId,
    context,
    ref,
  })
}

export function createDisabledRuntimeAuthorization(
  execution: ExecutionContext
): RuntimeAuthorization {
  return register(execution, {
    type: "unrestricted",
    projectId: execution.projectId,
    ref: Object.freeze({ type: "disabled" }),
  })
}

export function createTrustedPrimitiveRuntimeAuthorization(input: {
  readonly execution: ExecutionContext
  readonly primitive: TrustedPrimitiveRef
}): RuntimeAuthorization {
  const primitive = snapshotTrustedPrimitive(input.primitive)
  return register(input.execution, {
    type: "unrestricted",
    projectId: input.execution.projectId,
    ref: Object.freeze({ type: "trustedPrimitive", primitive }),
  })
}

export function createKernelRuntimeAuthorization(input: {
  readonly execution: ExecutionContext
  readonly operation: KernelOperation
}): RuntimeAuthorization {
  const operation = snapshotKernelOperation(input.operation)
  return register(input.execution, {
    type: "unrestricted",
    projectId: input.execution.projectId,
    ref: Object.freeze({ type: "kernel", operation }),
  })
}

export function resolveRuntimeAuthorization(authorization: unknown): ResolvedRuntimeAuthorization {
  if (!isRuntimeAuthorizationCapability(authorization)) {
    return { type: "denied" }
  }
  return registeredAuthorizations.get(authorization)?.resolved ?? { type: "denied" }
}

/**
 * Resolve authority from a runtime already admitted by `SixbHost.withScope`.
 *
 * Bound runtime facades carry no second execution value to recombine. Any lower-level boundary
 * that receives an `ExecutionContext` separately must use `resolveExecutionScopeAuthorization`.
 */
export function resolveRuntimeAuthorizationForProject(input: {
  readonly projectId: unknown
  readonly runtimeAuthorization?: unknown
}): ResolvedRuntimeAuthorization {
  const resolved = resolveRuntimeAuthorization(input.runtimeAuthorization)
  if (
    resolved.type === "denied" ||
    typeof input.projectId !== "string" ||
    resolved.projectId !== input.projectId
  ) {
    return { type: "denied" }
  }
  return resolved
}

export function getAuthorizationRef(authorization: RuntimeAuthorization): AuthorizationRef {
  const resolved = resolveRuntimeAuthorization(authorization)
  if (resolved.type === "denied") {
    throw new Error("[Sixb] Runtime authorization is not a registered Core capability.")
  }
  return cloneAuthorizationRef(resolved.ref)
}

export function assertExecutionScopeProject(projectId: string, scope: ExecutionScope): void {
  assertNonEmpty(projectId, "Project id")
  if (scope.execution.projectId !== projectId) {
    throw createSixbError(
      "internal.unexpected",
      `[Sixb] Execution scope belongs to project '${scope.execution.projectId}', not '${projectId}'.`,
      {
        details: {
          executionId: scope.execution.id,
          expectedProjectId: projectId,
          scopeProjectId: scope.execution.projectId,
        },
      }
    )
  }

  const resolved = resolveRuntimeAuthorization(scope.authorization)
  if (resolved.type === "denied") {
    throw createSixbError(
      "internal.unexpected",
      "[Sixb] Execution scope carries unregistered runtime authorization.",
      { details: { executionId: scope.execution.id, projectId } }
    )
  }
  if (resolved.projectId !== projectId) {
    throw createSixbError(
      "internal.unexpected",
      `[Sixb] Execution authorization belongs to project '${resolved.projectId}', not '${projectId}'.`,
      {
        details: {
          authorizationProjectId: resolved.projectId,
          executionId: scope.execution.id,
          expectedProjectId: projectId,
        },
      }
    )
  }
}

/** Validate that one registered authority belongs to the exact execution it accompanies. */
export function resolveExecutionScopeAuthorization(
  projectId: string,
  scope: ExecutionScope
): RegisteredRuntimeAuthorization {
  assertExecutionScopeProject(projectId, scope)
  const resolved = resolveRuntimeAuthorization(scope.authorization)
  if (resolved.type === "denied") {
    throw createSixbError(
      "internal.unexpected",
      "[Sixb] Execution scope carries unregistered runtime authorization.",
      { details: { executionId: scope.execution.id, projectId } }
    )
  }

  const registration = registeredAuthorizations.get(scope.authorization)
  if (!registration || !executionMatchesBinding(registration.execution, scope.execution)) {
    throw invalidExecutionAuthority(
      scope.execution.id,
      "authority is bound to different execution provenance"
    )
  }

  assertResolvedAuthorizationMatchesExecution(resolved, scope.execution)
  return resolved
}

function assertResolvedAuthorizationMatchesExecution(
  resolved: RegisteredRuntimeAuthorization,
  execution: ExecutionContext
): void {
  switch (execution.executor.type) {
    case "request":
      if (
        execution.source.type !== "http" ||
        execution.source.requestId !== execution.executor.requestId
      ) {
        throw invalidExecutionAuthority(execution.id, "request source does not match its executor")
      }
      if (resolved.ref.type === "principal") {
        if (
          resolved.type !== "principal" ||
          !principalsEqual(execution.requestedBy, resolved.ref.principal)
        ) {
          throw invalidExecutionAuthority(
            execution.id,
            "request authority does not match its requested-by principal"
          )
        }
        return
      }
      if (resolved.ref.type === "disabled" && execution.requestedBy === undefined) return
      throw invalidExecutionAuthority(
        execution.id,
        "request execution requires principal or explicitly disabled authority"
      )

    case "primitive":
      if (
        resolved.ref.type !== "trustedPrimitive" ||
        resolved.ref.primitive.kind !== execution.executor.kind ||
        resolved.ref.primitive.id !== execution.executor.id ||
        resolved.ref.primitive.runId !== execution.executor.runId
      ) {
        throw invalidExecutionAuthority(
          execution.id,
          "trusted primitive authority does not match its executor"
        )
      }
      return

    case "agent":
      if (
        resolved.type !== "principal" ||
        resolved.ref.type !== "principal" ||
        resolved.ref.principal.type !== "serviceAccount" ||
        resolved.ref.credential !== undefined ||
        execution.source.type !== "execution"
      ) {
        throw invalidExecutionAuthority(
          execution.id,
          "agent authority does not match its execution binding"
        )
      }
      return

    case "kernel":
      if (
        resolved.ref.type !== "kernel" ||
        execution.requestedBy !== undefined ||
        resolved.ref.operation.type !== execution.executor.operation.type ||
        resolved.ref.operation.recoveryId !== execution.executor.operation.recoveryId
      ) {
        throw invalidExecutionAuthority(
          execution.id,
          "kernel authority does not match its executor"
        )
      }
      return
  }
}

function principalsEqual(
  left: AuthorizablePrincipal | undefined,
  right: AuthorizablePrincipal | undefined
): boolean {
  return left?.type === right?.type && left?.id === right?.id
}

function invalidExecutionAuthority(executionId: string, reason: string): Error {
  return createSixbError(
    "internal.unexpected",
    `[Sixb] Execution '${executionId}' is incompatible with its authority: ${reason}.`,
    { details: { executionId, reason } }
  )
}

function register(
  execution: ExecutionContext,
  input: RegisteredRuntimeAuthorization
): RuntimeAuthorization {
  assertNonEmpty(input.projectId, "Authorization project id")
  const executionBinding = snapshotExecutionContext(execution)
  if (input.projectId !== executionBinding.projectId) {
    throw new Error(
      `[Sixb] Runtime authorization belongs to project '${input.projectId}', not execution project '${executionBinding.projectId}'.`
    )
  }
  assertResolvedAuthorizationMatchesExecution(input, executionBinding)
  const authorization = createRuntimeAuthorizationCapability()
  registeredAuthorizations.set(
    authorization,
    Object.freeze({ resolved: Object.freeze(input), execution: executionBinding })
  )
  return authorization
}

function executionMatchesBinding(binding: ExecutionContext, execution: ExecutionContext): boolean {
  try {
    return isDeepStrictEqual(binding, snapshotExecutionContext(execution))
  } catch {
    return false
  }
}

function snapshotExecutionContext(execution: ExecutionContext): ExecutionContext {
  assertNonEmpty(execution.id, "Execution id")
  assertNonEmpty(execution.projectId, "Execution project id")
  assertNonEmpty(execution.correlationId, "Execution correlation id")
  return Object.freeze({
    id: execution.id,
    projectId: execution.projectId,
    ...(execution.requestedBy === undefined
      ? {}
      : { requestedBy: snapshotAuthorizablePrincipal(execution.requestedBy) }),
    executor: snapshotExecutionExecutor(execution.executor),
    source: snapshotExecutionSource(execution.source),
    correlationId: execution.correlationId,
  })
}

function snapshotExecutionExecutor(
  executor: ExecutionContext["executor"]
): ExecutionContext["executor"] {
  switch (executor.type) {
    case "request":
      assertNonEmpty(executor.requestId, "Execution request id")
      return Object.freeze({ type: "request", requestId: executor.requestId })
    case "primitive": {
      const primitive = snapshotTrustedPrimitive(executor)
      return Object.freeze({ type: "primitive", ...primitive })
    }
    case "agent":
      assertNonEmpty(executor.agentId, "Execution Agent id")
      assertNonEmpty(executor.runId, "Execution Agent run id")
      return Object.freeze({ type: "agent", agentId: executor.agentId, runId: executor.runId })
    case "kernel":
      return Object.freeze({
        type: "kernel",
        operation: snapshotKernelOperation(executor.operation),
      })
  }
  throw new Error(
    `[Sixb] Unknown execution executor type '${String((executor as { type?: unknown }).type)}'.`
  )
}

function snapshotExecutionSource(source: ExecutionContext["source"]): ExecutionContext["source"] {
  switch (source.type) {
    case "http":
      assertNonEmpty(source.requestId, "Execution source request id")
      return Object.freeze({ type: "http", requestId: source.requestId })
    case "webhook":
      assertNonEmpty(source.deliveryId, "Execution source delivery id")
      return Object.freeze({ type: "webhook", deliveryId: source.deliveryId })
    case "schedule":
    case "event":
      assertNonEmpty(source.eventId, "Execution source event id")
      return Object.freeze({ type: source.type, eventId: source.eventId })
    case "datasetVersion":
      assertNonEmpty(source.datasetId, "Execution source dataset id")
      assertNonEmpty(source.versionId, "Execution source dataset version id")
      return Object.freeze({
        type: "datasetVersion",
        datasetId: source.datasetId,
        versionId: source.versionId,
      })
    case "execution":
      assertNonEmpty(source.executionId, "Execution source execution id")
      return Object.freeze({ type: "execution", executionId: source.executionId })
  }
  throw new Error(
    `[Sixb] Unknown execution source type '${String((source as { type?: unknown }).type)}'.`
  )
}

function snapshotAuthorizationContext(
  context: AuthorizationContext
): PrincipalAuthorizationContext {
  const principal = snapshotAuthorizablePrincipal(context.principal)
  const grants = {} as Record<GrantKind, ReadonlySet<string>>
  for (const kind of GRANT_KIND_KEYS) {
    grants[kind] = new ImmutableGrantSet(context.grants[kind])
  }
  const frozenGrants: GrantIndex = Object.freeze(grants)
  return Object.freeze({
    principal,
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
    groupIds: Object.freeze([...context.groupIds]),
    roleIds: Object.freeze([...context.roleIds]),
    grants: frozenGrants,
  })
}

/** Read-only Set semantics with no mutable handle hidden behind the TypeScript interface. */
class ImmutableGrantSet implements ReadonlySet<string> {
  readonly #values: Set<string>
  readonly [Symbol.toStringTag] = "Set"

  constructor(values: Iterable<string>) {
    this.#values = new Set(values)
    Object.freeze(this)
  }

  get size(): number {
    return this.#values.size
  }

  has(value: string): boolean {
    return this.#values.has(value)
  }

  entries(): ReturnType<Set<string>["entries"]> {
    return this.#values.entries()
  }

  keys(): ReturnType<Set<string>["keys"]> {
    return this.#values.keys()
  }

  values(): ReturnType<Set<string>["values"]> {
    return this.#values.values()
  }

  [Symbol.iterator](): ReturnType<Set<string>[typeof Symbol.iterator]> {
    return this.#values[Symbol.iterator]()
  }

  forEach(
    callback: (value: string, valueAgain: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown
  ): void {
    for (const value of this.#values) {
      callback.call(thisArg, value, value, this)
    }
  }

  add(_value: string): never {
    throw immutableGrantSetMutation()
  }

  delete(_value: string): never {
    throw immutableGrantSetMutation()
  }

  clear(): never {
    throw immutableGrantSetMutation()
  }
}

Object.freeze(ImmutableGrantSet.prototype)

function immutableGrantSetMutation(): Error {
  return new Error("[Sixb] Runtime authorization grants are immutable.")
}

function snapshotAuthorizablePrincipal(principal: Principal): AuthorizablePrincipal {
  if (principal.type !== "user" && principal.type !== "serviceAccount") {
    throw new Error(`[Sixb] Principal type '${principal.type}' cannot hold runtime authorization.`)
  }
  assertNonEmpty(principal.id, "Authorization principal id")
  return Object.freeze({ type: principal.type, id: principal.id })
}

function snapshotCredential(
  credential: NonNullable<Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]>
): NonNullable<Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]> {
  assertNonEmpty(credential.id, "Authorization credential id")
  if (credential.type !== "session" && credential.type !== "accessToken") {
    const credentialType = (credential as { readonly type: string }).type
    throw new Error(`[Sixb] Unknown authorization credential type '${credentialType}'.`)
  }
  return Object.freeze({ type: credential.type, id: credential.id })
}

function assertCredentialMatchesContext(
  context: PrincipalAuthorizationContext,
  credential:
    | NonNullable<Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]>
    | undefined
): void {
  if (credential?.type === "session") {
    if (context.sessionId !== credential.id) {
      throw new Error(
        "[Sixb] Session credential id must match the authorization context session id."
      )
    }
    return
  }
  if (context.sessionId !== undefined) {
    throw new Error("[Sixb] Authorization context session requires a matching session credential.")
  }
}

function snapshotTrustedPrimitive(primitive: TrustedPrimitiveRef): TrustedPrimitiveRef {
  if (!isTrustedPrimitiveKind(primitive.kind)) {
    throw new Error(`[Sixb] Unknown trusted primitive kind '${primitive.kind}'.`)
  }
  assertNonEmpty(primitive.id, "Trusted primitive id")
  assertNonEmpty(primitive.runId, "Trusted primitive run id")
  return Object.freeze({ kind: primitive.kind, id: primitive.id, runId: primitive.runId })
}

function snapshotKernelOperation(operation: KernelOperation): KernelOperation {
  if (operation.type !== "ontology.recover") {
    throw new Error(`[Sixb] Unknown kernel operation '${operation.type}'.`)
  }
  assertNonEmpty(operation.recoveryId, "Kernel recovery id")
  return Object.freeze({ type: operation.type, recoveryId: operation.recoveryId })
}

function cloneAuthorizationRef(ref: AuthorizationRef): AuthorizationRef {
  switch (ref.type) {
    case "principal":
      return {
        type: "principal",
        principal: { ...ref.principal },
        ...(ref.credential === undefined ? {} : { credential: { ...ref.credential } }),
      }
    case "trustedPrimitive":
      return { type: "trustedPrimitive", primitive: { ...ref.primitive } }
    case "kernel":
      return { type: "kernel", operation: { ...ref.operation } }
    case "disabled":
      return { type: "disabled" }
  }
}

function isTrustedPrimitiveKind(value: string): value is TrustedPrimitiveKind {
  return (
    value === "action" ||
    value === "pipeline" ||
    value === "projection" ||
    value === "rule" ||
    value === "sync" ||
    value === "webhook" ||
    value === "workflow"
  )
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`[Sixb] ${label} must not be empty.`)
  }
}
