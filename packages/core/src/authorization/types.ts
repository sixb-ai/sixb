/**
 * Authorization context types.
 *
 * The context is plain, immutable data resolved once per request
 * (`principal -> groups -> roles -> grants`). Grants resolve eagerly into set
 * lookups so enforcement on the hot path is synchronous and allocation-free.
 * Group and role ids are retained so decisions stay explainable.
 */

import type { Principal } from "../auth/types"
import type { GrantKind } from "./grant-kinds"

/**
 * Grants resolved to concrete id sets, keyed by grant kind (`view:object`,
 * `run:sync`, …). Broad grants and object subtypes are already expanded, so
 * enforcement is a single `grants[kind].has(id)` lookup. Keyed by `GrantKind`
 * so a new grant family adds one key, not a new bucket every consumer must
 * learn.
 */
export type GrantIndex = Readonly<Record<GrantKind, ReadonlySet<string>>>

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
