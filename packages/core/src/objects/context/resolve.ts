/**
 * Context resolution factories.
 *
 * Resolve ontology identifiers into concrete type data so leaf functions
 * receive all structural information pre-resolved.
 */

import type { ObjectLink } from "../../ontology"
import { OntologyNotFoundError } from "../../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type { SixbRuntimeContext } from "../../runtime/types"
import type { ResolvedLinkContext, ResolvedObjectContext } from "./types"

/** Look up a link definition on an object type, throwing if not found. */
export function requireLinkDefinition(
  objectType: ObjectTypeWithPropertyTokens,
  linkId: string
): ObjectLink {
  const def = objectType.links.find((l) => l.id === linkId)
  if (!def) throw new OntologyNotFoundError(`Unknown link '${objectType.id}.${linkId}'`)
  return def
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
