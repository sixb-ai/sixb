import type { AuthorizablePrincipal } from "../execution/types"
import type { JsonValue } from "../json"
import type { DatasetColumnRef, DatasetVersionRef } from "../lake-storage/types"
import type { EventExecutor } from "../materialization/events"

/**
 * Where an object's current values come from, as the reader may see it. Each source is described
 * once in `sources`; the object's existence and each property point at one by its key.
 */
export interface ObjectLineage {
  readonly objectTypeId: string
  readonly primaryId: string
  /** What makes the object exist: a projection's source row, or the edit that created it. */
  readonly existence: { readonly source: string }
  /**
   * Keyed `projection:<projectionId>`, `commit:<commitId>`, `commit@<instant>` for an edit whose
   * commit cannot be told apart at its instant, `telemetry:<commitId>`, and `identity`.
   */
  readonly sources: Readonly<Record<string, LineageSource>>
  /**
   * Each property the reader can read that holds a value or was cleared, in the object type's
   * order. A property the reader lacks a clearance for is left out.
   */
  readonly properties: Readonly<Record<string, PropertyLineage>>
  /** Steps left out because the reader cannot view them: runs, dataset versions, datasets. */
  readonly restricted: number
}

/** Where a link comes from, as the reader may see it. */
export interface LinkLineage {
  readonly sourceTypeId: string
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
  /** What makes the link exist: a projection's source row, or the edit that set it. */
  readonly existence: LinkExistenceLineage
  /** Keyed as in {@link ObjectLineage.sources}. */
  readonly sources: Readonly<Record<string, LineageSource>>
  /** Steps left out because the reader cannot view them: runs, dataset versions, datasets. */
  readonly restricted: number
}

export type LineageSource =
  | ProjectionLineageSource
  | EditLineageSource
  | TelemetryLineageSource
  | IdentityLineageSource

/**
 * A projection's source rows, as its active materialization applied them: every value of the
 * source comes from that dataset version, a row a later version left unchanged included.
 */
export interface ProjectionLineageSource {
  readonly kind: "projection"
  readonly projectionId: string
  /** The run that applied the version. Omitted for a reader who cannot view the projection's runs. */
  readonly projectionRunId?: string
  /** The dataset version applied. Omitted for a reader who cannot view the dataset. */
  readonly datasetVersion?: DatasetVersionRef
  /**
   * The dataset columns that decide which rows the version holds, which every value depends on:
   * filters, join keys, everything a code step reads. Absent when the version records no lineage
   * or the reader cannot view it; a dataset the reader cannot view is left out.
   */
  readonly rowOrigins?: readonly DatasetColumnRef[]
}

/** An Action's or a direct (runtime) write's edit. */
export interface EditLineageSource {
  readonly kind: "edit"
  /** The commit that made the edit, or null when commits at its instant cannot be told apart. */
  readonly commitId: string | null
  readonly committedAt: string
  /** On whose behalf the commit ran; absent for automatic or anonymous work. */
  readonly requestedBy?: AuthorizablePrincipal
  /**
   * What wrote the commit, as its events name it. Absent when the commit is unknown, and when it
   * names a run the reader cannot view.
   */
  readonly executor?: EventExecutor
  /** The Action run that made the edit. Absent for a direct write, and for a run the reader cannot view. */
  readonly action?: { readonly actionId: string; readonly runId: string }
}

/** The commit that appended a telemetry property's latest point. */
export interface TelemetryLineageSource {
  readonly kind: "telemetry"
  readonly commitId: string
  readonly committedAt: string
  /** The telemetry projection that appended the point; absent for a direct append. */
  readonly projectionId?: string
  readonly requestedBy?: AuthorizablePrincipal
  /** What wrote the commit. Absent when it names a run the reader cannot view. */
  readonly executor?: EventExecutor
}

/** The object's identity, which its primary key holds. */
export interface IdentityLineageSource {
  readonly kind: "identity"
}

export interface PropertyLineage {
  /** The source that decided the value: a key of `sources`. */
  readonly source: string
  /** The dataset column the projection maps to the property. */
  readonly column?: string
  /**
   * The dataset columns that column's values come from, across every upstream step, as the
   * applied version records them; `[]` when none flows in beyond the columns that decide which
   * rows exist, which are the projection source's `rowOrigins`. Absent when the version records
   * none; a dataset the reader cannot view is left out.
   */
  readonly origins?: readonly DatasetColumnRef[]
  /** The deciding source cleared the property, so it holds no value. */
  readonly removed?: true
  /** When the latest telemetry point was observed. */
  readonly at?: string
  /** What the deciding source won over: the source row an edit replaced, or the edit it outlived. */
  readonly replaced?: ReplacedPropertyValue
  /** How the source row and the edit were weighed, when both hold a candidate. */
  readonly resolution?: PropertyResolution
}

export interface ReplacedPropertyValue {
  /** A key of `sources`. */
  readonly source: string
  readonly column?: string
  /** Absent when that source cleared the property. */
  readonly value?: JsonValue
}

/** The projection's conflict resolution, with the times `mostRecent` compared. */
export type PropertyResolution =
  | { readonly strategy: "editsWin" }
  | {
      readonly strategy: "mostRecent"
      readonly sourceUpdatedAt: string
      readonly editedAt?: string
    }

export interface LinkExistenceLineage {
  /** A key of `sources`. */
  readonly source: string
  /** The dataset columns the projection reads the link from. */
  readonly columns?: readonly string[]
  /** The dataset columns those columns' values come from, as in {@link PropertyLineage.origins}. */
  readonly origins?: readonly DatasetColumnRef[]
}
