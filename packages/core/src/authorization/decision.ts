/**
 * Authorization decisions for the core data path.
 *
 * `evaluate` is the single place that maps a request to the resolved grant
 * index. `can` (boolean) and `assertAuthorized` (throw) are the two ways to
 * consume a decision; every enforcement site goes through one of them.
 *
 * A missing authorization context means a privileged caller (raw `sixb`,
 * syncs, workers, tests) — everything is allowed. Scoped contexts are
 * default-deny: a request without a covering grant is denied.
 */

import { AuthorizationError } from "./errors"
import type { AuthorizationContext, GrantIndex } from "./types"

/** Something a principal may attempt, paired with the resource it targets. */
export type AuthzRequest =
  | { readonly kind: "object.view"; readonly objectTypeId: string }
  | { readonly kind: "action.apply"; readonly actionId: string }
  | { readonly kind: "workflow.start"; readonly workflowId: string }
  | { readonly kind: "object.query"; readonly touchedObjectTypeIds: readonly string[] }

export interface AuthzDecision {
  readonly allowed: boolean
  /** Grant keys the request needs, e.g. `view:object:quote`. */
  readonly requirements: readonly string[]
  /** Required keys the principal lacks; empty when allowed. */
  readonly missing: readonly string[]
}

interface AuthorizedRuntime {
  readonly authorization?: AuthorizationContext
}

// A request expands to one or more atomic (capability, id) checks. The atom is
// the single unit that both names a requirement and tests the grant index, so
// the two can never drift.
type Atom =
  | { readonly capability: "view"; readonly id: string }
  | { readonly capability: "apply"; readonly id: string }
  | { readonly capability: "start"; readonly id: string }

function atomsFor(request: AuthzRequest): readonly Atom[] {
  switch (request.kind) {
    case "object.view":
      return [{ capability: "view", id: request.objectTypeId }]
    case "action.apply":
      return [{ capability: "apply", id: request.actionId }]
    case "workflow.start":
      return [{ capability: "start", id: request.workflowId }]
    case "object.query":
      return request.touchedObjectTypeIds.map((id) => ({ capability: "view", id }))
  }
}

function atomKey(atom: Atom): string {
  switch (atom.capability) {
    case "view":
      return `view:object:${atom.id}`
    case "apply":
      return `apply:action:${atom.id}`
    case "start":
      return `start:workflow:${atom.id}`
  }
}

function holds(grants: GrantIndex, atom: Atom): boolean {
  switch (atom.capability) {
    case "view":
      return grants.objectTypes.view.has(atom.id)
    case "apply":
      return grants.actions.apply.has(atom.id)
    case "start":
      return grants.workflows.start.has(atom.id)
  }
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
  const decision = evaluate(runtime.authorization, request)
  if (decision.allowed) {
    return
  }

  throw new AuthorizationError(
    decision.missing[0] ?? request.kind,
    deniedMessage(runtime.authorization, request)
  )
}

/**
 * Fail closed for operations that have no grant semantics yet (writes, links,
 * telemetry). Keeps unsupported surfaces denied even if a scoped runtime
 * context reaches a code path the scoped SDK does not expose.
 */
export function assertPrivileged(runtime: AuthorizedRuntime, operation: string): void {
  if (!runtime.authorization) {
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
    case "object.view":
      return `[Sixb] Principal '${principalId}' is not allowed to view object type '${request.objectTypeId}'.`
    case "action.apply":
      return `[Sixb] Principal '${principalId}' is not allowed to apply action '${request.actionId}'.`
    case "workflow.start":
      return `[Sixb] Principal '${principalId}' is not allowed to start workflow '${request.workflowId}'.`
    case "object.query": {
      // Name the first touched type the principal cannot view.
      const blocked = request.touchedObjectTypeIds.find(
        (objectTypeId) => !isAllowed(authorization, { kind: "object.view", objectTypeId })
      )
      return `[Sixb] Principal '${principalId}' is not allowed to view object type '${blocked}'.`
    }
  }
}
