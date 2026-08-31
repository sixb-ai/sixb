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
  resolveRuntimeAuthorization,
} from "../execution/authorization"
import type { ExecutionContext, RuntimeAuthorization } from "../execution/types"
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
  const decision = evaluate(authorization, request)
  if (decision.allowed) {
    return
  }

  throw new AuthorizationError(
    decision.missing[0] ?? request.kind,
    deniedMessage(authorization, request)
  )
}

/** Resolve registered process-local authority before a protected leaf makes a decision. */
export function assertRuntimeAuthorizationBound(
  runtime: AuthorizedRuntime
): Exclude<ResolvedRuntimeAuthorization, { readonly type: "denied" }> {
  const resolved = resolveRuntimeAuthorization(runtime.runtimeAuthorization)
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
 * One caller left — `listLinks`, whose rows reveal target types that no read grant covers. Object,
 * link, and telemetry writes moved to {@link assertCanEdit} / {@link assertCanAppendTelemetry}.
 * Keeps unsupported surfaces denied even if a principal-bound runtime context reaches a code path
 * the execution SDK does not expose.
 */
export function assertPrivileged(runtime: AuthorizedRuntime, operation: string): void {
  const resolved = assertRuntimeAuthorizationBound(runtime)
  if (resolved.type === "unrestricted") {
    return
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
 * same agent and run before this check succeeds.
 */
export function assertProviderAccess(
  runtime: AuthorizedRuntime,
  execution: ExecutionContext,
  operation: string
): void {
  const resolved = assertRuntimeAuthorizationBound(runtime)
  if (resolved.type === "unrestricted") {
    return
  }

  const binding = resolved.executionBinding
  const executor = execution.executor
  if (
    binding?.type === "agent" &&
    executor.type === "agent" &&
    binding.executionId === execution.id &&
    binding.agentId === executor.agentId &&
    binding.runId === executor.runId
  ) {
    return
  }

  throw new AuthorizationError(
    `privileged:${operation}`,
    `[Sixb] Operation '${operation}' is not covered by scoped authorization grants.`
  )
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
