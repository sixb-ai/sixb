import type { OntologyLinkRef, OntologyObjectRef } from "../materialization/model"
import { objectRefKey } from "../materialization/refs"
import { linkCardinality } from "../materializer/edits/read-set"
import {
  type LinkAuthority,
  resolveEffectiveLink,
  resolveEffectiveLinkSlotMember,
  usableLinkSlotOverride,
} from "../materializer/effective/resolve"
import type { SixbRuntimeContext } from "../runtime/types"
import type { MaterializationLinkState } from "../storage/ontology"
import type { LineageDependencies } from "./projections"
import { LineageReader } from "./reader"
import { LineageCommitReads, LineageSources } from "./sources"
import type { LinkExistenceLineage, LinkLineage } from "./types"

/**
 * Explain where a link comes from, for the runtime's reader. Null when the reader cannot read
 * both of its objects or links of its kind, or when the link does not exist. See `README.md`.
 */
export async function explainLink(
  runtime: SixbRuntimeContext,
  dependencies: LineageDependencies,
  ref: OntologyLinkRef
): Promise<LinkLineage | null> {
  const reader = LineageReader.for(runtime)
  if (!reader) return null

  const endpoints = await reader.readObjects([ref.source, ref.target])
  if (!endpoints || !(await reader.canReadLink(ref.source.objectTypeId, ref.linkId))) return null

  const state = await runtime.storage.ontology.materializations.readState({
    projectId: runtime.projectId,
    objects: [ref.source, ref.target],
    links: [ref],
    linkScopes: [],
  })
  const link = state.links[0]
  if (!link) return null

  // An endpoint exists when its effective row does: the materializer resolved that itself, as it
  // resolves the link here.
  const effective = new Set(
    state.objects.flatMap((object) => (object.effective ? [objectRefKey(object.ref)] : []))
  )
  const cardinality = linkCardinality(runtime.ontology, ref)
  const authority = linkAuthority(cardinality, link, (object) =>
    effective.has(objectRefKey(object))
  )
  if (!authority) return null

  // An override names the commit that last wrote it, which is the one that set this link.
  const override = cardinality === "one" ? link.slotOverride : link.override
  const reads = new LineageCommitReads()
  if (authority === "override" && override) {
    reads.edit({ kind: "named", commitId: override.lastCommitId })
  }

  const sources = await LineageSources.read({
    reader,
    dependencies,
    object: ref.source,
    stored: authority === "source" ? link.source : null,
    reads,
  })

  return {
    sourceTypeId: ref.source.objectTypeId,
    sourceId: ref.source.primaryId,
    linkId: ref.linkId,
    targetTypeId: ref.target.objectTypeId,
    targetId: ref.target.primaryId,
    existence: existence(sources, authority, override?.lastCommitId, ref.linkId),
    sources: sources.cited,
    restricted: reader.restricted,
  }
}

/**
 * Resolve the link as the materializer does for its cardinality, and return the authority that
 * selected it: null when the link is not effective.
 */
function linkAuthority(
  cardinality: "one" | "many",
  link: MaterializationLinkState,
  endpointExists: (object: OntologyObjectRef) => boolean
): LinkAuthority | null {
  let authority: LinkAuthority | null = null
  const record = (decided: LinkAuthority) => {
    authority = decided
  }

  const resolved =
    cardinality === "one"
      ? resolveEffectiveLinkSlotMember(
          {
            ref: link.ref,
            source: link.source,
            override: usableLinkSlotOverride(link.slotOverride),
            endpointExists,
          },
          record
        )
      : resolveEffectiveLink(
          {
            ref: link.ref,
            source: link.source,
            override: link.override?.value ?? null,
            sourceEndpointExists: endpointExists(link.ref.source),
            targetEndpointExists: endpointExists(link.ref.target),
          },
          record
        )

  return resolved ? authority : null
}

function existence(
  sources: LineageSources,
  authority: LinkAuthority,
  overrideCommitId: string | undefined,
  linkId: string
): LinkExistenceLineage {
  if (authority === "override") {
    if (overrideCommitId === undefined) {
      throw new Error("[Sixb] Lineage found a link override authority without its override.")
    }
    return { source: sources.citeEdit({ kind: "named", commitId: overrideCommitId }) }
  }

  const columns = sources.projection?.linkColumns(linkId)
  const origins = columns === undefined ? undefined : sources.projection?.origins(columns)
  return {
    source: sources.citeProjection(),
    ...(columns === undefined ? {} : { columns }),
    ...(origins === undefined ? {} : { origins }),
  }
}
