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
 *
 * SECURITY — this makes "privileged" the silent default: any caller that
 * reaches a leaf without an authorization context bypasses all grant checks.
 * That is intended for internal callers, but it means HTTP routes serving
 * authenticated principals must go through the scoped runtime (`sixb.as(ctx)`),
 * never the raw runtime. See `RequestAuthState` in the server for the rule.
 */

import { AuthorizationError } from "./errors"
import type { AuthorizationContext, GrantIndex } from "./types"

/** Something a principal may attempt, paired with the resource it targets. */
export type AuthzRequest =
  | { readonly kind: "object.view"; readonly objectTypeId: string }
  | { readonly kind: "dataset.view"; readonly datasetId: string }
  | { readonly kind: "action.apply"; readonly actionId: string }
  | { readonly kind: "workflow.run"; readonly workflowId: string }
  | { readonly kind: "sync.run"; readonly syncId: string }
  | { readonly kind: "pipeline.run"; readonly pipelineId: string }
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
  | { readonly capability: "view"; readonly target: "object" | "dataset"; readonly id: string }
  | { readonly capability: "apply"; readonly id: string }
  | {
      readonly capability: "run"
      readonly target: "workflow" | "sync" | "pipeline"
      readonly id: string
    }

function atomsFor(request: AuthzRequest): readonly Atom[] {
  switch (request.kind) {
    case "object.view":
      return [{ capability: "view", target: "object", id: request.objectTypeId }]
    case "dataset.view":
      return [{ capability: "view", target: "dataset", id: request.datasetId }]
    case "action.apply":
      return [{ capability: "apply", id: request.actionId }]
    case "workflow.run":
      return [{ capability: "run", target: "workflow", id: request.workflowId }]
    case "sync.run":
      return [{ capability: "run", target: "sync", id: request.syncId }]
    case "pipeline.run":
      return [{ capability: "run", target: "pipeline", id: request.pipelineId }]
    case "object.query":
      return request.touchedObjectTypeIds.map((id) => ({
        capability: "view",
        target: "object",
        id,
      }))
  }
}

function atomKey(atom: Atom): string {
  switch (atom.capability) {
    case "view":
      return `view:${atom.target}:${atom.id}`
    case "apply":
      return `apply:action:${atom.id}`
    case "run":
      return `run:${atom.target}:${atom.id}`
  }
}

function holds(grants: GrantIndex, atom: Atom): boolean {
  switch (atom.capability) {
    case "view":
      return atom.target === "dataset"
        ? grants.datasets.view.has(atom.id)
        : grants.objectTypes.view.has(atom.id)
    case "apply":
      return grants.actions.apply.has(atom.id)
    case "run":
      switch (atom.target) {
        case "sync":
          return grants.syncs.run.has(atom.id)
        case "pipeline":
          return grants.pipelines.run.has(atom.id)
        case "workflow":
          return grants.workflows.run.has(atom.id)
      }
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
    case "dataset.view":
      return `[Sixb] Principal '${principalId}' is not allowed to view dataset '${request.datasetId}'.`
    case "action.apply":
      return `[Sixb] Principal '${principalId}' is not allowed to apply action '${request.actionId}'.`
    case "workflow.run":
      return `[Sixb] Principal '${principalId}' is not allowed to run workflow '${request.workflowId}'.`
    case "sync.run":
      return `[Sixb] Principal '${principalId}' is not allowed to run sync '${request.syncId}'.`
    case "pipeline.run":
      return `[Sixb] Principal '${principalId}' is not allowed to run pipeline '${request.pipelineId}'.`
    case "object.query": {
      // Name the first touched type the principal cannot view.
      const blocked = request.touchedObjectTypeIds.find(
        (objectTypeId) => !isAllowed(authorization, { kind: "object.view", objectTypeId })
      )
      return `[Sixb] Principal '${principalId}' is not allowed to view object type '${blocked}'.`
    }
  }
}
