import { MaterializationConflictError } from "../../../materialization/errors"
import { effectiveMaterializerCommitId } from "../../../materialization/legacy"
import type {
  EffectiveLinkSnapshot,
  EffectiveObjectSnapshot,
  OntologyLinkRef,
} from "../../../materialization/model"
import { linkRefKey, linkRefSortKey, linkScopeSortKey } from "../../../materialization/refs"
import type { ObjectLinkRow, ObjectRow } from "../../objects/types"
import type { TimeseriesPoint } from "../../timeseries/types"
import type {
  StoredLinkOverride,
  StoredObjectOverride,
  StoredTelemetryPoint,
} from "../materializations"
import type {
  StageSourceAssertion,
  StoredSourceAssertion,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
} from "../sources"
import type { ReplacementSessionState } from "./materializations"
import type {
  InMemoryOntologyState,
  InMemorySourceMaterialization,
  InMemoryStoredLinkOverride,
  InMemoryStoredObjectOverride,
} from "./shared-state"

export function publicObjectOverride(
  value: InMemoryStoredObjectOverride | undefined
): StoredObjectOverride | null {
  if (!value) return null
  const { projectId: _, ...stored } = value
  return stored
}

export function publicLinkOverride(
  value: InMemoryStoredLinkOverride | undefined
): StoredLinkOverride | null {
  if (!value) return null
  const { projectId: _, ...stored } = value
  return stored
}

export function uniqueBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [keyOf(value), structuredClone(value)])).values()]
}

export function objectSnapshot(row: ObjectRow): EffectiveObjectSnapshot {
  return {
    ref: { objectTypeId: row.objectTypeId, primaryId: row.primaryId },
    properties: structuredClone(row.properties) as EffectiveObjectSnapshot["properties"],
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastCommitId: effectiveMaterializerCommitId(row.lastCommitId),
  }
}

export function linkSnapshot(row: ObjectLinkRow): EffectiveLinkSnapshot {
  return {
    ref: linkRef(row),
    ...(row.properties
      ? { properties: structuredClone(row.properties) as EffectiveLinkSnapshot["properties"] }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastCommitId: effectiveMaterializerCommitId(row.lastCommitId),
  }
}

export function linkRef(row: ObjectLinkRow): OntologyLinkRef {
  return {
    source: { objectTypeId: row.sourceTypeId, primaryId: row.sourceId },
    linkId: row.linkId,
    target: { objectTypeId: row.targetTypeId, primaryId: row.targetId },
  }
}

export function storedPoint(point: TimeseriesPoint): StoredTelemetryPoint {
  return {
    series: {
      object: { objectTypeId: point.objectTypeId, primaryId: point.objectId },
      propertyId: point.propertyId,
    },
    value: structuredClone(point.value) as StoredTelemetryPoint["value"],
    ...(point.unit !== undefined ? { unit: point.unit } : {}),
    at: point.at.toISOString(),
    lastCommitId: effectiveMaterializerCommitId(point.lastCommitId),
  }
}

export function findActiveSourceMaterialization(
  state: InMemoryOntologyState,
  projectId: string,
  sourceId: string
): InMemorySourceMaterialization | undefined {
  let active: InMemorySourceMaterialization | undefined
  for (const materialization of state.sourceMaterializations.values()) {
    if (
      materialization.projectId !== projectId ||
      materialization.source.projectionId !== sourceId ||
      materialization.status !== "active"
    ) {
      continue
    }
    if (active) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Source '${sourceId}' has more than one active materialization.`
      )
    }
    active = materialization
  }
  return active
}

export function storedSource(
  sourceId: string,
  materializationId: string,
  row: StageSourceAssertion
): StoredSourceAssertion {
  return {
    source: { projectionId: sourceId },
    materializationId,
    root: structuredClone(row.root),
    assertion: structuredClone(row.assertion),
    stagingOrdinal: row.stagingOrdinal,
  } as StoredSourceAssertion
}

export function storedSourceObject(
  sourceId: string,
  materializationId: string | undefined,
  row: StageSourceAssertion | undefined
): StoredSourceObjectAssertion | null {
  if (!materializationId || !row || row.assertion.kind !== "object") return null
  return storedSource(sourceId, materializationId, row) as StoredSourceObjectAssertion
}

export function storedSourceLink(
  sourceId: string,
  materializationId: string | undefined,
  row: StageSourceAssertion | undefined
): StoredSourceLinkAssertion | null {
  if (!materializationId || !row || row.assertion.kind !== "link") return null
  return storedSource(sourceId, materializationId, row) as StoredSourceLinkAssertion
}

export function addReplacementLink(
  replacement: ReplacementSessionState,
  ref: OntologyLinkRef,
  diffRequired: boolean
): void {
  const key = linkRefKey(ref)
  const existing = replacement.links.get(key)
  if (existing) {
    existing.diffRequired ||= diffRequired
    if (diffRequired) replacement.affectedScopes.add(linkScopeSortKey(ref.source, ref.linkId))
    return
  }
  replacement.links.set(key, {
    ref: structuredClone(ref),
    sortKey: linkRefSortKey(ref),
    diffRequired,
  })
  if (diffRequired) replacement.affectedScopes.add(linkScopeSortKey(ref.source, ref.linkId))
}
