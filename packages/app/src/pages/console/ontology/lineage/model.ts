import type { GetDatasetVersionLineageResponse, GetObjectLineageResponse } from "@sixb/client"

// What the lineage routes answer, read for display. Sources are described once and keyed;
// `existence` and each property point at one by its key.

export type ObjectLineage = GetObjectLineageResponse
export type LineageSource = ObjectLineage["sources"][string]
export type PropertyLineage = ObjectLineage["properties"][string]
export type EditSource = Extract<LineageSource, { kind: "edit" }>
export type ProjectionSource = Extract<LineageSource, { kind: "projection" }>
export type TelemetrySource = Extract<LineageSource, { kind: "telemetry" }>
export type Requester = NonNullable<EditSource["requestedBy"]>

export type DatasetLineage = GetDatasetVersionLineageResponse
export type DatasetLineageNode = DatasetLineage["nodes"][number]

/** The sources a person can be shown; the identity, which holds the primary key, explains nothing. */
export type ExplainedSourceKind = "projection" | "edit" | "telemetry"

/** A property with the source that decided its value. */
export interface ExplainedProperty {
  readonly property: PropertyLineage
  readonly source: Exclude<LineageSource, { kind: "identity" }>
}

/**
 * The property's lineage and its deciding source, or `null` when there is nothing to explain: the
 * property is the primary key, the reader is not cleared for it, or its source is not described.
 */
export function explainProperty(
  lineage: ObjectLineage | undefined,
  propertyId: string
): ExplainedProperty | null {
  const property = lineage?.properties[propertyId]
  const source = property ? lineage.sources[property.source] : undefined
  if (!property || !source || source.kind === "identity") return null

  return { property, source }
}

/** What made the object exist and how many of its values an edit decided, for the page's header. */
export function lineageSummary(lineage: ObjectLineage): {
  readonly existence: LineageSource | undefined
  readonly edited: number
} {
  const edited = Object.values(lineage.properties).filter(
    (property) => lineage.sources[property.source]?.kind === "edit"
  ).length

  return { existence: lineage.sources[lineage.existence.source], edited }
}

/**
 * Why the deciding source won over the other candidate, when the projection resolves conflicts by
 * `mostRecent`. Under `editsWin` an edit wins by rule, and the value it replaced says enough.
 */
export type Resolution =
  | { readonly winner: "edit"; readonly projectionId: string | null }
  | { readonly winner: "source"; readonly edit: EditSource | null }

export function resolutionOf(
  lineage: ObjectLineage,
  explained: ExplainedProperty
): Resolution | null {
  if (explained.property.resolution?.strategy !== "mostRecent") return null

  const replaced = explained.property.replaced
  const loser = replaced ? lineage.sources[replaced.source] : undefined

  if (explained.source.kind === "edit") {
    return {
      winner: "edit",
      projectionId: loser?.kind === "projection" ? loser.projectionId : null,
    }
  }

  if (explained.source.kind === "projection") {
    return { winner: "source", edit: loser?.kind === "edit" ? loser : null }
  }

  return null
}

/** Whether the reader may open the projection's page: it may when it may view its runs. */
export function projectionOpens(source: ProjectionSource): boolean {
  return source.projectionRunId !== undefined
}

/**
 * The telemetry projection whose page the reader may open, or `null`. Its run shows as the commit's
 * executor exactly when the reader may view it, which is what the projection's page asks too.
 */
export function telemetryProjection(source: TelemetrySource): string | null {
  const executor = source.executor
  return source.projectionId && executor?.type === "primitive" && executor.kind === "projection"
    ? source.projectionId
    : null
}

/** One dataset version upstream of the property's column, with the columns of it the value reads. */
export interface UpstreamStep {
  readonly node: DatasetLineageNode
  readonly columns: readonly string[]
}

/**
 * The versions upstream of the applied one that the value comes from, nearest first, each with
 * the columns its value reads. A version is kept when its dataset holds one of the value's
 * `origins` or `rowOrigins`, or when it was computed from such a version: the other branches of a
 * join feed other columns. When the applied version records no column lineage, every version is
 * kept, since none can be ruled out.
 */
export function upstreamSteps(
  upstream: DatasetLineage,
  origins: PropertyLineage["origins"],
  rowOrigins: ProjectionSource["rowOrigins"]
): readonly UpstreamStep[] {
  const nodes = upstream.nodes.slice(1)
  const columns = (node: DatasetLineageNode) =>
    (origins ?? []).filter((origin) => origin.datasetId === node.datasetId).map((o) => o.column)

  if (origins === undefined && rowOrigins === undefined) {
    return nodes.map((node) => ({ node, columns: columns(node) }))
  }

  const read = new Set([...(origins ?? []), ...(rowOrigins ?? [])].map((ref) => ref.datasetId))
  const feeding = new Set(nodes.filter((node) => read.has(node.datasetId)).map(versionKey))

  // Down every edge from a version the value reads to the version computed from it, until none
  // adds another: the walk is a DAG of at most a hundred versions.
  let grew = true
  while (grew) {
    grew = false
    for (const edge of upstream.edges) {
      if (feeding.has(versionKey(edge.from)) && !feeding.has(versionKey(edge.to))) {
        feeding.add(versionKey(edge.to))
        grew = true
      }
    }
  }

  return nodes
    .filter((node) => feeding.has(versionKey(node)))
    .map((node) => ({ node, columns: columns(node) }))
}

/**
 * The steps of this property's trail the reader cannot see: a source that arrives visibly
 * incomplete (a projection without its run or its dataset version, an edit or a telemetry point
 * without what wrote it), and the versions the walk upstream left out. Other properties' hidden
 * steps are not this trail's.
 */
export function hiddenSteps(explained: ExplainedProperty, upstream?: DatasetLineage): number {
  const { source } = explained
  const hidden =
    source.kind === "projection"
      ? Number(!source.projectionRunId) + Number(!source.datasetVersion)
      : source.kind === "edit"
        ? Number(source.commitId !== null && !source.executor)
        : Number(!source.executor)

  return hidden + (upstream?.restricted ?? 0)
}

type ExpiredNode = Extract<DatasetLineageNode, { expired: true }>

/** Whether the lake no longer holds a version the walk reached, as after a cleanup. */
export function isExpired(
  node: DatasetLineageNode | { readonly datasetId: string; readonly versionId: string }
): node is ExpiredNode {
  return "expired" in node && node.expired === true
}

function versionKey(ref: { readonly datasetId: string; readonly versionId: string }): string {
  return `${ref.datasetId}@${ref.versionId}`
}
