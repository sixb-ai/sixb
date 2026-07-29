/**
 * Authorization context types.
 *
 * The context is plain, immutable data resolved once per request
 * (`principal -> groups -> roles -> grants`). Grants resolve eagerly into set
 * lookups so enforcement on the hot path is synchronous and allocation-free.
 * Group and role ids are retained so decisions stay explainable.
 */

import type { Principal } from "../auth/types"
import { emptyGrantSets, type GrantKind } from "./grant-kinds"

/**
 * Grants resolved to concrete id sets, keyed by grant kind (`view:object`,
 * `run:sync`, …). Broad grants and object subtypes are already expanded, so
 * enforcement is a single `grants[kind].has(id)` lookup. Keyed by `GrantKind`
 * so a new grant family adds one key, not a new bucket every consumer must
 * learn.
 */
export type GrantIndex = Readonly<Record<GrantKind, ReadonlySet<string>>>

/**
 * A grant index that grants nothing, as the base for a hand-built context — typically in tests.
 *
 * This is the read-only face of `emptyGrantSets()`, the mutable builder resolution fills in and which
 * stays internal. A factory rather than a shared constant, because the sets are only `ReadonlySet` to
 * the type system: one frozen instance would be aliased into every context that spreads it.
 *
 * Writing the literal by hand is what this avoids. `GrantIndex` is deliberately a total `Record` so
 * that `grants[kind].has(id)` cannot be misspelled into a silent `undefined` — with an optional index
 * every enforcement site would read `?.has(id) ?? false`, where a typo denies instead of failing to
 * compile. The cost of totality is that a literal breaks whenever a grant family is added.
 */
export function emptyGrantIndex(): GrantIndex {
  return emptyGrantSets()
}

/** A role with its grants pre-expanded to concrete id sets at startup. */
export interface ResolvedRole {
  readonly id: string
  readonly grantedToGroupIds: readonly string[]
  readonly grants: GrantIndex
}

export interface AuthorizationContext {
  readonly principal: Principal
  readonly sessionId?: string
  readonly groupIds: readonly string[]
  /** Roles whose grantedTo groups intersect the principal's memberships. */
  readonly roleIds: readonly string[]
  readonly grants: GrantIndex
}
