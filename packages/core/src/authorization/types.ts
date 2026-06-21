/**
 * Authorization context types.
 *
 * The context is plain, immutable data resolved once per request
 * (`principal -> groups -> roles -> grants`). Grants resolve eagerly into set
 * lookups so enforcement on the hot path is synchronous and allocation-free.
 * Group and role ids are retained so decisions stay explainable.
 */

import type { Principal } from "../auth/types"

export interface GrantIndex {
  /** Object type ids viewable, expanded from grants (broad grants + subtypes). */
  readonly objectTypes: { readonly view: ReadonlySet<string> }
  /** Action ids this principal may request. */
  readonly actions: { readonly apply: ReadonlySet<string> }
  /** Workflow ids this principal may run. */
  readonly workflows: { readonly run: ReadonlySet<string> }
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
