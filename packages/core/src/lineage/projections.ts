import { isUnknownLineage, lineageColumn, versionLineage } from "../lake-storage/lineage"
import type { DatasetColumnLineage, DatasetColumnRef, LakeStorage } from "../lake-storage/types"
import type { PinnedDatasetVersion, ProjectionEntityRef } from "../materialization/model"
import type {
  ProjectionDefinition,
  ProjectionDefinitionCatalog,
  ProjectionTarget,
} from "../projections"
import { projectionTargetOf } from "../projections/builders"
import type { StoredSourceLinkAssertion, StoredSourceObjectAssertion } from "../storage/ontology"
import type { LineageReader } from "./reader"
import type { ProjectionLineageSource } from "./types"

/** What lineage reads beyond the runtime: the projections the code defines, and the lake. */
export interface LineageDependencies {
  readonly projections: ProjectionDefinitionCatalog
  readonly lakeStorage: Pick<LakeStorage, "getVersion" | "recordsLineage">
}

/** A projection source as the reader may see it, and the columns its values are read from. */
export interface DescribedProjection {
  /** Its key in a lineage's `sources`. */
  readonly key: string
  readonly source: ProjectionLineageSource
  /** The dataset column an object projection maps to this property. */
  propertyColumn(propertyId: string): string | undefined
  /** The dataset columns an object projection's foreign key or a link projection reads a link from. */
  linkColumns(linkId: string): readonly string[] | undefined
  /** The dataset columns these columns' values come from, or undefined when that is unknown. */
  origins(columns: readonly string[]): readonly DatasetColumnRef[] | undefined
}

/**
 * Describe the projection behind a stored source assertion: its active materialization, which
 * applied every value of the source, and the columns the projection's definition reads.
 *
 * - The run shows to a reader who may view the projection's runs.
 * - The dataset version, the columns that decide its rows and the projection's columns show to a
 *   reader who may view the dataset, and columns only while the code still defines the projection
 *   over that dataset.
 * - A dataset an upstream column belongs to shows to a reader who may view it.
 */
export async function describeProjection(
  reader: LineageReader,
  dependencies: LineageDependencies,
  stored: StoredSourceObjectAssertion | StoredSourceLinkAssertion
): Promise<DescribedProjection> {
  const { projectId, storage } = reader.runtime
  const { projectionId } = stored.source

  const active = await storage.ontology.sources.getActive({ projectId, source: stored.source })
  const definition = dependencies.projections.getById(projectionId)

  const target = definition ? projectionTargetOf(definition) : rootTarget(stored.root)
  const showsRun = active !== null && reader.canViewRun({ kind: "projection", target })
  if (active && !showsRun) reader.restrict(`projection-run:${active.projectionRunId}`)

  const version = active?.datasetVersion
  const showsVersion = version !== undefined && reader.canViewDataset(version.datasetId)
  if (version && !showsVersion) {
    reader.restrict(`dataset-version:${version.datasetId}:${version.versionId}`)
  }

  const lineage = showsVersion ? await columnLineage(dependencies.lakeStorage, version) : undefined
  const rowOrigins = lineage && visibleRefs(reader, lineage.rows)
  const columns = showsVersion && definition?.datasetId === version.datasetId ? definition : null

  return {
    key: `projection:${projectionId}`,
    source: {
      kind: "projection",
      projectionId,
      ...(showsRun ? { projectionRunId: active.projectionRunId } : {}),
      ...(showsVersion
        ? { datasetVersion: { datasetId: version.datasetId, versionId: version.versionId } }
        : {}),
      ...(rowOrigins === undefined ? {} : { rowOrigins }),
    },
    propertyColumn: (propertyId) =>
      columns?._tag === "ObjectProjectionDefinition"
        ? ownValue(columns.properties, propertyId)
        : undefined,
    linkColumns: (linkId) => (columns ? linkColumns(columns, linkId) : undefined),
    origins: (names) => (lineage ? visibleOrigins(reader, lineage, names) : undefined),
  }
}

/** A version's column lineage, or undefined when the lake no longer holds it or it is unknown. */
async function columnLineage(
  lakeStorage: LineageDependencies["lakeStorage"],
  pinned: PinnedDatasetVersion
): Promise<DatasetColumnLineage | undefined> {
  const version = await lakeStorage.getVersion(pinned.datasetId, pinned.versionId)
  if (!version) return undefined

  const lineage = versionLineage(version, lakeStorage)
  return isUnknownLineage(lineage) ? undefined : lineage
}

/**
 * The dataset columns these columns' values come from, each once, the ones of a dataset the reader
 * cannot view left out. The columns that decide which rows exist are the source's `rowOrigins`.
 * Undefined when the lineage does not list one of the columns: its values could come from anywhere.
 */
function visibleOrigins(
  reader: LineageReader,
  lineage: DatasetColumnLineage,
  columns: readonly string[]
): readonly DatasetColumnRef[] | undefined {
  const origins = new Map<string, DatasetColumnRef>()

  for (const column of columns) {
    const refs = lineageColumn(lineage, column)
    if (refs === undefined) return undefined

    for (const ref of refs) {
      origins.set(JSON.stringify([ref.datasetId, ref.column]), ref)
    }
  }

  return visibleRefs(reader, [...origins.values()])
}

/** These columns, the ones of a dataset the reader cannot view left out and counted. */
function visibleRefs(
  reader: LineageReader,
  refs: readonly DatasetColumnRef[]
): readonly DatasetColumnRef[] {
  return refs.filter((ref) => {
    if (reader.canViewDataset(ref.datasetId)) return true

    reader.restrict(`dataset:${ref.datasetId}`)
    return false
  })
}

function linkColumns(
  definition: ProjectionDefinition,
  linkId: string
): readonly string[] | undefined {
  switch (definition._tag) {
    case "ObjectProjectionDefinition": {
      const foreignKey = ownValue(definition.links, linkId)
      if (!foreignKey) return undefined

      const column =
        foreignKey.sourceField ??
        (foreignKey.sourcePropertyId === undefined
          ? undefined
          : ownValue(definition.properties, foreignKey.sourcePropertyId))
      return column === undefined ? undefined : [column]
    }
    case "LinkProjectionDefinition":
      return definition.linkId === linkId
        ? [definition.sourceField, definition.targetField]
        : undefined
    case "TelemetryProjectionDefinition":
      return undefined
  }
}

/** What a projection the code no longer defines described: the type or link its rows were. */
function rootTarget(root: ProjectionEntityRef): ProjectionTarget {
  return root.kind === "object"
    ? { objectTypeId: root.ref.objectTypeId }
    : {
        sourceObjectTypeId: root.ref.source.objectTypeId,
        targetObjectTypeId: root.ref.target.objectTypeId,
      }
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}
