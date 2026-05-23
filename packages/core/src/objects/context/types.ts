/**
 * Resolved context types for object operations.
 *
 * Context hierarchy: SixbRuntimeContext → ResolvedObjectContext → ResolvedLinkContext
 */

import type { ObjectLink } from "../../ontology"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type { SixbRuntimeContext } from "../../runtime/types"

/** Resolved context for object operations — extends runtime with resolved type info. */
export interface ResolvedObjectContext extends SixbRuntimeContext {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly primaryPropertyId: string
}

/** Resolved context for link operations. */
export interface ResolvedLinkContext extends ResolvedObjectContext {
  readonly linkDefinition: ObjectLink
}

/** Pre-resolved data for a single item in a link batch operation. */
export interface ResolvedLinkBatchItem {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly linkDefinition: ObjectLink
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
  readonly properties?: Record<string, unknown>
}
