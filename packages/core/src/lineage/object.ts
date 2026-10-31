import type { JsonValue } from "../json"
import type { OntologyObjectRef } from "../materialization/model"
import {
  type ExplainedObjectValue,
  explainEffectiveObject,
  type ObjectPropertyCandidate,
  type PropertyAuthority,
  storedObjectEditedAt,
} from "../materializer/effective/resolve"
import type { SixbRuntimeContext } from "../runtime/types"
import type { StoredObjectOverride } from "../storage/ontology"
import type { LineageDependencies } from "./projections"
import { LineageReader } from "./reader"
import { type EditLookup, LineageCommitReads, LineageSources } from "./sources"
import type { ObjectLineage, PropertyLineage, PropertyResolution } from "./types"

/**
 * Explain where an object's current values come from, for the runtime's reader. Null when the
 * reader cannot read the object, which includes a missing one. See `README.md`.
 */
export async function explainObject(
  runtime: SixbRuntimeContext,
  dependencies: LineageDependencies,
  ref: OntologyObjectRef
): Promise<ObjectLineage | null> {
  const reader = LineageReader.for(runtime)
  if (!reader) return null

  const [row] = (await reader.readObjects([ref])) ?? []
  if (!row) return null

  const { objects } = await runtime.storage.ontology.materializations.readState({
    projectId: runtime.projectId,
    objects: [ref],
    links: [],
    linkScopes: [],
  })
  const state = objects[0]
  if (!state?.effective) return null

  const explained = explainEffectiveObject({
    ref,
    primaryPropertyId: runtime.ontology.getPrimaryPropertyId(ref.objectTypeId),
    source: state.source,
    override: state.override?.value ?? null,
    editedAt: storedObjectEditedAt(state.override),
    latestTelemetry: state.latestTelemetry,
  })
  if (!explained) return null

  // A property the reader lacks a clearance for is not explained at all.
  const redacted = new Set(Object.keys(row.redactions ?? {}))
  const decided = inTypeOrder(runtime, ref.objectTypeId, explained.properties).filter(
    ([propertyId]) => !redacted.has(propertyId)
  )

  const override = state.override
  const created: EditLookup = {
    kind: "at",
    instant: state.effective.createdAt,
    change: "created",
  }

  const reads = new LineageCommitReads()
  if (explained.existence === "create") reads.edit(created)
  for (const [propertyId, authority] of decided) {
    if (authority.kind === "telemetry") reads.telemetry(authority.point.lastCommitId)
    if (authority.kind === "edit" || (authority.kind === "source" && authority.wonOver)) {
      reads.edit(editLookup(override, propertyId))
    }
  }

  const sources = await LineageSources.read({
    reader,
    dependencies,
    object: ref,
    stored: state.source,
    reads,
  })

  const existence =
    explained.existence === "source" ? sources.citeProjection() : sources.citeEdit(created)
  const properties = Object.fromEntries(
    decided.map(([propertyId, authority]) => [
      propertyId,
      propertyLineage({ sources, explained, override, propertyId, authority }),
    ])
  )

  return {
    objectTypeId: ref.objectTypeId,
    primaryId: ref.primaryId,
    existence: { source: existence },
    sources: sources.cited,
    properties,
    restricted: reader.restricted,
  }
}

function propertyLineage(input: {
  readonly sources: LineageSources
  readonly explained: ExplainedObjectValue
  readonly override: StoredObjectOverride | null
  readonly propertyId: string
  readonly authority: PropertyAuthority
}): PropertyLineage {
  const { sources, explained, override, propertyId, authority } = input
  const edit = () => sources.citeEdit(editLookup(override, propertyId))
  const removed = Object.hasOwn(explained.value.properties, propertyId)
    ? {}
    : { removed: true as const }

  switch (authority.kind) {
    case "identity":
      return { source: sources.citeIdentity() }

    case "telemetry":
      return {
        source: sources.citeTelemetry(authority.point.lastCommitId),
        at: authority.point.at,
      }

    case "source": {
      const column = sources.projection?.propertyColumn(propertyId)
      const origins = column === undefined ? undefined : sources.projection?.origins([column])
      const lineage = {
        source: sources.citeProjection(),
        ...(column === undefined ? {} : { column }),
        ...(origins === undefined ? {} : { origins }),
        ...removed,
      }

      // Only `mostRecent` lets a source row win over an edit.
      const { wonOver } = authority
      if (!wonOver) return lineage

      return {
        ...lineage,
        replaced: { source: edit(), ...candidateValue(wonOver.candidate) },
        resolution: {
          strategy: "mostRecent",
          sourceUpdatedAt: wonOver.sourceUpdatedAt,
          editedAt: wonOver.editedAt,
        },
      }
    }

    case "edit": {
      const { wonOver } = authority
      if (!wonOver) return { source: edit(), ...removed }

      const column = sources.projection?.propertyColumn(propertyId)
      return {
        source: edit(),
        ...removed,
        replaced: {
          source: sources.citeProjection(),
          ...(column === undefined ? {} : { column }),
          ...candidateValue(wonOver.candidate),
        },
        resolution: resolution(wonOver.sourceUpdatedAt, authority.editedAt),
      }
    }
  }
}

/**
 * How the commit behind an edited property is found: by its edit time, which is its commit's
 * `committedAt`. An override written before edit times were recorded has none for the property;
 * its last commit may not be the one that edited it, so the commit is unknown.
 */
function editLookup(override: StoredObjectOverride | null, propertyId: string): EditLookup {
  if (!override) {
    throw new Error(`[Sixb] Lineage found an edit of '${propertyId}' with no override.`)
  }

  const instant = override.editedAt?.[propertyId]
  if (instant === undefined) return { kind: "unknown", instant: override.updatedAt }

  return { kind: "at", instant, change: { propertyId } }
}

/** Under `mostRecent` the source row carries its update time; `editsWin` compares nothing. */
function resolution(
  sourceUpdatedAt: string | undefined,
  editedAt: string | undefined
): PropertyResolution {
  if (sourceUpdatedAt === undefined) return { strategy: "editsWin" }

  return {
    strategy: "mostRecent",
    sourceUpdatedAt,
    ...(editedAt === undefined ? {} : { editedAt }),
  }
}

function candidateValue(candidate: ObjectPropertyCandidate): { readonly value?: JsonValue } {
  return candidate.present ? { value: candidate.value as JsonValue } : {}
}

/** The decided properties in the object type's order, then any it no longer defines. */
function inTypeOrder(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  properties: ReadonlyMap<string, PropertyAuthority>
): [string, PropertyAuthority][] {
  const ordered = new Map<string, PropertyAuthority>()

  for (const { id } of runtime.ontology.resolveObjectType(objectTypeId).properties) {
    const authority = properties.get(id)
    if (authority) ordered.set(id, authority)
  }
  for (const [id, authority] of properties) {
    if (!ordered.has(id)) ordered.set(id, authority)
  }

  return [...ordered]
}
