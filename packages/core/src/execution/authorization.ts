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

const registeredAuthorizations = new WeakMap<RuntimeAuthorization, RegisteredRuntimeAuthorization>()

export function createPrincipalRuntimeAuthorization(input: {
  readonly projectId: string
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
  return register({ type: "principal", projectId: input.projectId, context, ref })
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
