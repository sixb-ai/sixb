/**
 * Authorization decisions for the core data path.
 *
 * `evaluate` is the single place that maps a request to the resolved grant
 * index. `can` (boolean) and `assertAuthorized` (throw) are the two ways to
 * consume a decision; every enforcement site goes through one of them.
 *
 * Every protected leaf first resolves the opaque runtime capability. Missing, forged, or
 * unregistered authority is denied; only an explicitly registered trusted or disabled execution
 * is unrestricted.
 */

import type { AuthSessionAudience } from "../auth/audience"
import {
  type ResolvedRuntimeAuthorization,
  resolveExecutionScopeAuthorization,
  resolveRuntimeAuthorizationForProject,
} from "../execution/authorization"
import type { ExecutionContext, RuntimeAuthorization } from "../execution/types"
import type { ObjectRef } from "../ontology"
import {
  accessPlanCanApplyAction,
  accessPlanCanApplyActionOn,
  accessPlanSelectsObjectPropertyAnywhere,
  accessPlanSelectsObjectTypeAnywhere,
} from "./access-plan"
import { AuthorizationError } from "./errors"
import type { GrantKind } from "./grant-kinds"
import type { AuthorizationContext, GrantIndex } from "./types"

/** Something a principal may attempt, paired with the resource it targets. */
export type AuthzRequest =
  | { readonly kind: "application.access"; readonly audience: AuthSessionAudience }
  | { readonly kind: "object.view"; readonly objectTypeId: string }
  | { readonly kind: "dataset.view"; readonly datasetId: string }
  | { readonly kind: "object.edit"; readonly objectTypeId: string }
  | { readonly kind: "telemetry.append"; readonly objectTypeId: string }
  | { readonly kind: "action.apply"; readonly actionId: string }
  | { readonly kind: "workflow.run"; readonly workflowId: string }
  | { readonly kind: "sync.run"; readonly syncId: string }
  | { readonly kind: "pipeline.run"; readonly pipelineId: string }
  | { readonly kind: "agent.run"; readonly agentId: string }
  | { readonly kind: "logs.observe" }
  | { readonly kind: "connector.manage"; readonly connectorId: string }
  | { readonly kind: "object.query"; readonly touchedObjectTypeIds: readonly string[] }

export interface AuthzDecision {
  readonly allowed: boolean
  /** Grant keys the request needs, e.g. `view:object:quote`. */
  readonly requirements: readonly string[]
  /** Required keys the principal lacks; empty when allowed. */
  readonly missing: readonly string[]
}

interface AuthorizedRuntime {
  readonly projectId: string
  readonly runtimeAuthorization?: RuntimeAuthorization
  readonly authorization?: AuthorizationContext
}

// A request expands to one or more atomic (grant kind, id) checks. The atom is
// the single unit that both names a requirement and tests the grant index, so
// the two can never drift. `kind` is the resolved-index key, so enforcement is
// a direct lookup with no per-target dispatch.
interface Atom {
  readonly kind: GrantKind
  readonly id: string
}

function atomsFor(request: AuthzRequest): readonly Atom[] {
  switch (request.kind) {
    case "application.access":
      return [{ kind: "access:application", id: request.audience }]
    case "object.view":
      return [{ kind: "view:object", id: request.objectTypeId }]
    case "dataset.view":
      return [{ kind: "view:dataset", id: request.datasetId }]
    case "object.edit":
      return [{ kind: "edit:object", id: request.objectTypeId }]
    case "telemetry.append":
      return [{ kind: "append:telemetry", id: request.objectTypeId }]
    case "action.apply":
      return [{ kind: "apply:action", id: request.actionId }]
    case "workflow.run":
      return [{ kind: "run:workflow", id: request.workflowId }]
    case "sync.run":
      return [{ kind: "run:sync", id: request.syncId }]
    case "pipeline.run":
      return [{ kind: "run:pipeline", id: request.pipelineId }]
    case "agent.run":
      return [{ kind: "run:agent", id: request.agentId }]
    case "logs.observe":
      return [{ kind: "observe:logs", id: "logs" }]
    case "connector.manage":
      return [{ kind: "manage:connector", id: request.connectorId }]
    case "object.query":
      return request.touchedObjectTypeIds.map((id) => ({ kind: "view:object", id }))
  }
}

function atomKey(atom: Atom): string {
  if (atom.kind === "observe:logs") return atom.kind
  return `${atom.kind}:${atom.id}`
}

function holds(grants: GrantIndex, atom: Atom): boolean {
  return grants[atom.kind].has(atom.id)
}

/** Resolve a request against a principal's grants. Never throws. */
export function evaluate(
  authorization: AuthorizationContext | null | undefined,
  request: AuthzRequest
): AuthzDecision {
  const atoms = atomsFor(request)
  const requirements = atoms.map(atomKey)
  const missing = authorization
    ? atoms.filter((atom) => !holds(authorization.grants, atom)).map(atomKey)
    : []
  return { allowed: missing.length === 0, requirements, missing }
}

export function isAllowed(
  authorization: AuthorizationContext | null | undefined,
  request: AuthzRequest
): boolean {
  return evaluate(authorization, request).allowed
}

export function assertAuthorized(runtime: AuthorizedRuntime, request: AuthzRequest): void {
  const resolved = assertRuntimeAuthorizationBound(runtime)
  const authorization = resolved.type === "principal" ? resolved.context : undefined
  const decision =
    resolved.type === "unrestricted"
      ? allowedDecision(request)
      : resolved.type === "delegated"
        ? evaluateDelegated(resolved.access, request)
        : evaluate(resolved.context, request)
  if (decision.allowed) {
    return
  }

  throw new AuthorizationError(
    decision.missing[0] ?? request.kind,
    resolved.type === "delegated"
      ? delegatedDeniedMessage(decision.missing[0] ?? request.kind)
      : deniedMessage(authorization, request)
  )
}

/** Boolean counterpart to {@link assertAuthorized} for runtime catalogs and optional resources. */
export function isRuntimeAllowed(runtime: AuthorizedRuntime, request: AuthzRequest): boolean {
  const resolved = resolveRuntimeAuthorizationForProject(runtime)
  if (resolved.type === "denied") return false
  if (resolved.type === "unrestricted") return true
  if (resolved.type === "delegated") return evaluateDelegated(resolved.access, request).allowed
  return evaluate(resolved.context, request).allowed
}

export function hasDelegatedRuntimeAuthority(runtime: AuthorizedRuntime): boolean {
  return resolveRuntimeAuthorizationForProject(runtime).type === "delegated"
}

/** Preserve the `(action, exact subject)` pair carried by one scoped grant. */
export function assertCanApplyActionOn(
  runtime: AuthorizedRuntime,
  actionId: string,
  subject: ObjectRef
): void {
  const resolved = assertRuntimeAuthorizationBound(runtime)
  if (resolved.type === "unrestricted") return
  if (resolved.type === "principal") {
    assertAuthorized(runtime, { kind: "action.apply", actionId })
    assertAuthorized(runtime, { kind: "object.view", objectTypeId: subject.objectTypeId })
    return
  }
  if (
    accessPlanCanApplyActionOn(resolved.access, actionId, subject) &&
    accessPlanSelectsObjectTypeAnywhere(resolved.access, subject.objectTypeId)
  ) {
    return
  }
  throw new AuthorizationError(
    `apply:action:${actionId}:${subject.objectTypeId}:${subject.primaryId}`,
    `[Sixb] Delegated authority cannot apply action '${actionId}' to '${subject.objectTypeId}:${subject.primaryId}'.`
  )
}

export function assertCanReadObjectProperty(
  runtime: AuthorizedRuntime,
  objectTypeId: string,
  propertyId: string
): void {
  const resolved = assertRuntimeAuthorizationBound(runtime)
  if (resolved.type === "unrestricted") return
  if (resolved.type === "principal") {
    assertAuthorized(runtime, { kind: "object.view", objectTypeId })
    return
  }
  if (accessPlanSelectsObjectPropertyAnywhere(resolved.access, objectTypeId, propertyId)) return
  throw new AuthorizationError(
    `view:object:${objectTypeId}:property:${propertyId}`,
    `[Sixb] Delegated authority cannot read property '${objectTypeId}.${propertyId}'.`
  )
}

function allowedDecision(request: AuthzRequest): AuthzDecision {
  const requirements = atomsFor(request).map(atomKey)
  return { allowed: true, requirements, missing: [] }
}

function evaluateDelegated(
  access: Extract<ResolvedRuntimeAuthorization, { readonly type: "delegated" }>["access"],
  request: AuthzRequest
): AuthzDecision {
  const requirements = atomsFor(request).map(atomKey)
  const allowed = (() => {
    switch (request.kind) {
      case "object.view":
        return accessPlanSelectsObjectTypeAnywhere(access, request.objectTypeId)
      case "object.query":
        return request.touchedObjectTypeIds.every((objectTypeId) =>
          accessPlanSelectsObjectTypeAnywhere(access, objectTypeId)
        )
      case "action.apply":
        return accessPlanCanApplyAction(access, request.actionId)
      case "application.access":
      case "dataset.view":
      case "object.edit":
      case "telemetry.append":
      case "workflow.run":
      case "sync.run":
      case "pipeline.run":
      case "agent.run":
      case "logs.observe":
      case "connector.manage":
        return false
    }
  })()
  return { allowed, requirements, missing: allowed ? [] : requirements }
}

/** Resolve registered process-local authority before a protected leaf makes a decision. */
export function assertRuntimeAuthorizationBound(
  runtime: AuthorizedRuntime
): Exclude<ResolvedRuntimeAuthorization, { readonly type: "denied" }> {
  const resolved = resolveRuntimeAuthorizationForProject(runtime)
  if (resolved.type === "denied") {
    throw new AuthorizationError(
      "runtime:unbound",
      "[Sixb] Protected operations require a registered execution scope."
    )
  }
  return resolved
}

/**
 * Assert a principal may write objects of this type.
 *
 * Requires `view:object` as well as `edit:object`, and that is not belt-and-braces: an upsert
 * returns the *merged* row, which the Materializer reconciles against source authority, so the
 * response can carry properties the caller never sent. Granting the write without the read would
 * leak them.
 *
 * The pairing is asserted here rather than implied during resolution: `resolveRoleGrants` has no
 * notion of one grant entailing another, and giving it one would put ids in the resolved index that
 * no role granted — an index that no longer answers "what was actually granted".
 *
 * Telemetry append is deliberately *not* paired this way; see {@link assertCanAppendTelemetry}.
 */
export function assertCanEdit(runtime: AuthorizedRuntime, objectTypeId: string): void {
  assertAuthorized(runtime, { kind: "object.view", objectTypeId })
  assertAuthorized(runtime, { kind: "object.edit", objectTypeId })
}

/**
 * Assert a principal may append telemetry points to objects of this type.
 *
 * No `view:object` requirement, unlike {@link assertCanEdit}: an append answers with no object
 * state, so there is nothing to leak. That is what makes a write-only principal — a device, an
 * ingestion service — expressible at all, and it is the reason telemetry has its own grant.
 */
export function assertCanAppendTelemetry(runtime: AuthorizedRuntime, objectTypeId: string): void {
  assertAuthorized(runtime, { kind: "telemetry.append", objectTypeId })
}

/** Assert a principal may manage lifecycle state for this connector definition. */
export function assertCanManageConnector(runtime: AuthorizedRuntime, connectorId: string): void {
  assertAuthorized(runtime, { kind: "connector.manage", connectorId })
}

/**
 * Fail closed for operations that have no grant semantics yet.
 *
 * This covers direct edge reads on the typed object handle, domain-event authoring, and global
 * Actions under delegated authority. Object, link, and telemetry writes use their dedicated grant
 * assertions instead. Keeping this guard explicit prevents unsupported surfaces from inheriting
 * access merely because they are reachable from the shared execution SDK.
 */
export function assertPrivileged(runtime: AuthorizedRuntime, operation: string): void {
  const resolved = assertRuntimeAuthorizationBound(runtime)
  if (resolved.type === "unrestricted") {
    return
  }

  if (resolved.type === "delegated") {
    throw new AuthorizationError(
      `privileged:${operation}`,
      `[Sixb] Operation '${operation}' is not covered by delegated authority.`
    )
  }

  throw new AuthorizationError(
    `privileged:${operation}`,
    `[Sixb] Operation '${operation}' is not covered by scoped authorization grants.`
  )
}

/**
 * Assert access to process providers that trusted executions and genuine agent runs may use.
 *
 * Agent provenance alone is not authority: the registered capability must be bound to the exact
 * same immutable execution before this check succeeds.
 */
export function assertProviderAccess(
  runtime: AuthorizedRuntime & { readonly runtimeAuthorization: RuntimeAuthorization },
  execution: ExecutionContext,
  operation: string
): void {
  const resolved = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  if (resolved.type === "unrestricted") {
    return
  }

  if (resolved.type === "delegated") {
    throw new AuthorizationError(
      `privileged:${operation}`,
      `[Sixb] Operation '${operation}' is not covered by delegated authority.`
    )
  }

  if (execution.executor.type === "agent") {
    return
  }

  throw new AuthorizationError(
    `privileged:${operation}`,
    `[Sixb] Operation '${operation}' is not covered by scoped authorization grants.`
  )
}

function delegatedDeniedMessage(requirement: string): string {
  return `[Sixb] Delegated authority does not include required grant '${requirement}'.`
}

function deniedMessage(
  authorization: AuthorizationContext | null | undefined,
  request: AuthzRequest
): string {
  const principalId = authorization?.principal.id ?? "unknown"
  switch (request.kind) {
    case "application.access":
      return `[Sixb] Principal '${principalId}' is not allowed to access application '${request.audience}'.`
    case "object.view":
      return `[Sixb] Principal '${principalId}' is not allowed to view object type '${request.objectTypeId}'.`
    case "dataset.view":
      return `[Sixb] Principal '${principalId}' is not allowed to view dataset '${request.datasetId}'.`
    case "object.edit":
      return `[Sixb] Principal '${principalId}' is not allowed to write object type '${request.objectTypeId}'.`
    case "telemetry.append":
      return `[Sixb] Principal '${principalId}' is not allowed to append telemetry for object type '${request.objectTypeId}'.`
    case "action.apply":
      return `[Sixb] Principal '${principalId}' is not allowed to apply action '${request.actionId}'.`
    case "workflow.run":
      return `[Sixb] Principal '${principalId}' is not allowed to run workflow '${request.workflowId}'.`
    case "sync.run":
      return `[Sixb] Principal '${principalId}' is not allowed to run sync '${request.syncId}'.`
    case "pipeline.run":
      return `[Sixb] Principal '${principalId}' is not allowed to run pipeline '${request.pipelineId}'.`
    case "agent.run":
      return `[Sixb] Principal '${principalId}' is not allowed to run agent '${request.agentId}'.`
    case "logs.observe":
      return `[Sixb] Principal '${principalId}' is not allowed to observe project logs.`
    case "connector.manage":
      return `[Sixb] Principal '${principalId}' is not allowed to manage connector '${request.connectorId}'.`
    case "object.query": {
      // Name the first touched type the principal cannot view.
      const blocked = request.touchedObjectTypeIds.find(
        (objectTypeId) => !isAllowed(authorization, { kind: "object.view", objectTypeId })
      )
      return `[Sixb] Principal '${principalId}' is not allowed to view object type '${blocked}'.`
    }
  }
}
