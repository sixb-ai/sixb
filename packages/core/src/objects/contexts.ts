/**
 * Resolved context types for object operations.
 *
 * Context hierarchy: SixbRuntimeContext → ResolvedObjectContext → ResolvedLinkContext
 *
 * Factory functions resolve ontology identifiers into concrete type data,
 * so leaf functions receive all structural information pre-resolved.
 */

import type { ObjectLink } from "../ontology"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { SixbRuntimeContext } from "../runtime/types"
import { requireLinkDefinition } from "./context/resolve.js"

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

/**
 * Resolve an object type id to a full ResolvedObjectContext.
 *
 * Uses ontology.resolveObjectType() and getPrimaryPropertyId() — these
 * are structural resolution calls that belong in factories, not leaf functions.
 */
export function resolveObjectContext(
  runtime: SixbRuntimeContext,
  objectTypeId: string
): ResolvedObjectContext {
  const objectType = runtime.ontology.resolveObjectType(objectTypeId)
  const primaryPropertyId = runtime.ontology.getPrimaryPropertyId(objectTypeId)
  return { ...runtime, objectType, primaryPropertyId }
}

/**
 * Resolve a link id to a full ResolvedLinkContext.
 *
 * Uses requireLinkDefinition to look up the link definition on the
 * already-resolved object type.
 */
export function resolveLinkContext(
  objCtx: ResolvedObjectContext,
  linkId: string
): ResolvedLinkContext {
  const linkDefinition = requireLinkDefinition(objCtx.objectType, linkId)
  return { ...objCtx, linkDefinition }
}
