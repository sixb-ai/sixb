import type { Principal } from "../auth"
import { emptyGrantSets, GRANT_KIND_KEYS } from "../authorization/grant-kinds"
import type { AuthorizationContext, GrantIndex } from "../authorization/types"
import {
  type AuthorizablePrincipal,
  type AuthorizationRef,
  createRuntimeAuthorizationCapability,
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
      /** Process-local binding used by provider façades that explicitly support agent runs. */
      readonly executionBinding?: AgentExecutionBinding
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

interface AgentExecutionBinding {
  readonly type: "agent"
  readonly executionId: string
  readonly agentId: string
  readonly runId: string
}

const registeredAuthorizations = new WeakMap<RuntimeAuthorization, RegisteredRuntimeAuthorization>()

export function createPrincipalRuntimeAuthorization(input: {
  readonly projectId: string
  readonly context: AuthorizationContext
  readonly credential?: Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
}): RuntimeAuthorization {
  return createRegisteredPrincipalAuthorization(input)
}

/** Register service-account authority bound to one exact agent run. */
export function createAgentRuntimeAuthorization(input: {
  readonly projectId: string
  readonly context: AuthorizationContext
  readonly executionId: string
  readonly agentId: string
  readonly runId: string
}): RuntimeAuthorization {
  if (input.context.principal.type !== "serviceAccount") {
    throw new Error("[Sixb] Agent execution authority must belong to a service account.")
  }
  assertNonEmpty(input.executionId, "Execution id")
  assertNonEmpty(input.agentId, "Agent id")
  assertNonEmpty(input.runId, "Agent run id")
  return createRegisteredPrincipalAuthorization(input, {
    type: "agent",
    executionId: input.executionId,
    agentId: input.agentId,
    runId: input.runId,
  })
}

function createRegisteredPrincipalAuthorization(
  input: {
    readonly projectId: string
    readonly context: AuthorizationContext
    readonly credential?: Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
  },
  executionBinding?: AgentExecutionBinding
): RuntimeAuthorization {
  const context = snapshotAuthorizationContext(input.context)
  const credential = input.credential ? snapshotCredential(input.credential) : undefined
  assertCredentialMatchesContext(context, credential)
  const ref: Extract<AuthorizationRef, { readonly type: "principal" }> = Object.freeze({
    type: "principal",
    principal: context.principal,
    ...(credential === undefined ? {} : { credential }),
  })
  return register({
    type: "principal",
    projectId: input.projectId,
    context,
    ref,
    ...(executionBinding === undefined
      ? {}
      : { executionBinding: Object.freeze({ ...executionBinding }) }),
  })
}

export function createDisabledRuntimeAuthorization(projectId: string): RuntimeAuthorization {
  return register({ type: "unrestricted", projectId, ref: Object.freeze({ type: "disabled" }) })
}

export function createTrustedPrimitiveRuntimeAuthorization(input: {
  readonly projectId: string
  readonly primitive: TrustedPrimitiveRef
}): RuntimeAuthorization {
  const primitive = snapshotTrustedPrimitive(input.primitive)
  return register({
    type: "unrestricted",
    projectId: input.projectId,
    ref: Object.freeze({ type: "trustedPrimitive", primitive }),
  })
}

export function createKernelRuntimeAuthorization(input: {
  readonly projectId: string
  readonly operation: KernelOperation
}): RuntimeAuthorization {
  const operation = snapshotKernelOperation(input.operation)
  return register({
    type: "unrestricted",
    projectId: input.projectId,
    ref: Object.freeze({ type: "kernel", operation }),
  })
}

export function resolveRuntimeAuthorization(authorization: unknown): ResolvedRuntimeAuthorization {
  if (!isRuntimeAuthorizationCapability(authorization)) {
    return { type: "denied" }
  }
  return registeredAuthorizations.get(authorization) ?? { type: "denied" }
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
    throw new Error(
      `[Sixb] Execution scope belongs to project '${scope.execution.projectId}', not '${projectId}'.`
    )
  }

  const resolved = resolveRuntimeAuthorization(scope.authorization)
  if (resolved.type === "denied") {
    throw new Error("[Sixb] Execution scope carries unregistered runtime authorization.")
  }
  if (resolved.projectId !== projectId) {
    throw new Error(
      `[Sixb] Execution authorization belongs to project '${resolved.projectId}', not '${projectId}'.`
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
    throw new Error("[Sixb] Execution scope carries unregistered runtime authorization.")
  }

  const { execution } = scope
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
          resolved.executionBinding !== undefined ||
          !principalsEqual(execution.requestedBy, resolved.ref.principal)
        ) {
          throw invalidExecutionAuthority(
            execution.id,
            "request authority does not match its requested-by principal"
          )
        }
        return resolved
      }
      if (resolved.ref.type === "disabled" && execution.requestedBy === undefined) return resolved
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
      return resolved

    case "agent":
      if (
        resolved.type !== "principal" ||
        resolved.ref.type !== "principal" ||
        resolved.ref.principal.type !== "serviceAccount" ||
        resolved.ref.credential !== undefined ||
        resolved.executionBinding?.type !== "agent" ||
        resolved.executionBinding.executionId !== execution.id ||
        resolved.executionBinding.agentId !== execution.executor.agentId ||
        resolved.executionBinding.runId !== execution.executor.runId
      ) {
        throw invalidExecutionAuthority(
          execution.id,
          "agent authority does not match its execution binding"
        )
      }
      return resolved

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
      return resolved
  }
}

function principalsEqual(
  left: AuthorizablePrincipal | undefined,
  right: AuthorizablePrincipal | undefined
): boolean {
  return left?.type === right?.type && left?.id === right?.id
}

function invalidExecutionAuthority(executionId: string, reason: string): Error {
  return new Error(
    `[Sixb] Execution '${executionId}' is incompatible with its authority: ${reason}.`
  )
}

function register(input: RegisteredRuntimeAuthorization): RuntimeAuthorization {
  assertNonEmpty(input.projectId, "Authorization project id")
  const authorization = createRuntimeAuthorizationCapability()
  registeredAuthorizations.set(authorization, Object.freeze(input))
  return authorization
}

function snapshotAuthorizationContext(
  context: AuthorizationContext
): PrincipalAuthorizationContext {
  const principal = snapshotAuthorizablePrincipal(context.principal)
  const grants = emptyGrantSets()
  for (const kind of GRANT_KIND_KEYS) {
    grants[kind] = new Set(context.grants[kind])
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
