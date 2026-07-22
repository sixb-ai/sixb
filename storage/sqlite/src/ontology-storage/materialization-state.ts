import type { Database } from "bun:sqlite"
import type {
  EffectiveLinkSnapshot,
  EffectiveObjectSnapshot,
  OntologyLinkRef,
  OntologyObjectRef,
  TelemetrySeriesRef,
} from "@sixb/core/internal/materializer"
import {
  linkRefKey,
  MaterializationConflictError,
  objectRefKey,
  projectionEntityKey,
  telemetryPointSortKey,
} from "@sixb/core/internal/materializer"
import {
  appendScopeSnapshot,
  finishScopeAccumulator,
  startScopeAccumulator,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectState,
  SourceReplacementLinkState,
  SourceReplacementObjectState,
  StoredLinkOverride,
  StoredObjectOverride,
  StoredSourceAssertion,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
  StoredTelemetryPoint,
} from "@sixb/core/storage"
import {
  linkRefFromColumns,
  objectRefFromColumns,
  parseJson,
  type SqliteOntologyOverrideRow,
  type SqliteOntologySourceAssertionRow,
} from "./shared"

export const SQLITE_MATERIALIZATION_WORK_TABLE = "ontology_materialization_work"
export const SQLITE_REPLACEMENT_WORK_TABLE = "ontology_replacement_work"

interface EffectiveObjectRow {
  readonly object_type_id: string
  readonly primary_id: string
  readonly properties: string
  readonly created_at: string
  readonly updated_at: string
  readonly version: number
  readonly last_commit_id: string | null
}

interface EffectiveLinkRow {
  readonly source_type_id: string
  readonly source_id: string
  readonly link_id: string
  readonly target_type_id: string
  readonly target_id: string
  readonly properties: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly last_commit_id: string | null
}

interface TelemetryRow {
  readonly object_type_id: string
  readonly object_id: string
  readonly property_id: string
  readonly value: string
  readonly unit: string | null
  readonly at: string
  readonly last_commit_id: string | null
}

export type ReplacementIdentity =
  | {
      readonly kind: "object"
      readonly ref: OntologyObjectRef
      readonly sortKey: string
      readonly diffRequired: true
    }
  | {
      readonly kind: "link"
      readonly ref: OntologyLinkRef
      readonly sortKey: string
      readonly diffRequired: boolean
    }

interface ReplacementIdentityInput {
  readonly sessionId: string
  readonly sourceId: string
  readonly candidateMaterializationId: string
  readonly previousMaterializationId: string | null
  readonly kind: "object" | "link"
  readonly pageRows: number
}

export class SqliteMaterializationStateReader {
  constructor(
    private readonly db: Database,
    readonly projectId: string
  ) {}

  objectState(ref: OntologyObjectRef): MaterializationObjectState {
    const effective = this.db
      .query(
        `
          SELECT * FROM objects
          WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
        `
      )
      .get(this.projectId, ref.objectTypeId, ref.primaryId) as EffectiveObjectRow | null
    return {
      ref: structuredClone(ref),
      source: this.activeObjectSource(ref),
      override: this.objectOverride(ref),
      effective: effective ? effectiveObjectSnapshot(effective) : null,
      latestTelemetry: this.latestTelemetry(ref),
    }
  }

  linkState(ref: OntologyLinkRef): MaterializationLinkState {
    const effective = this.getEffectiveLink(ref)
    return {
      ref: structuredClone(ref),
      source: this.activeLinkSource(ref),
      override: this.linkOverride(ref),
      effective: effective ? effectiveLinkSnapshot(effective) : null,
    }
  }

  exactPoint(series: TelemetrySeriesRef, at: string): StoredTelemetryPoint | null {
    const row = this.db
      .query(
        `
          SELECT * FROM timeseries
          WHERE project_id = ? AND object_type_id = ? AND object_id = ?
            AND property_id = ? AND at = ?
        `
      )
      .get(
        this.projectId,
        series.object.objectTypeId,
        series.object.primaryId,
        series.propertyId,
        at
      ) as TelemetryRow | null
    return row ? storedPoint(row) : null
  }

  linkScope(source: OntologyObjectRef, linkId: string): MaterializationLinkScopeState {
    const accumulator = startScopeAccumulator(source, linkId, "")
    let cursor: string | null = null
    while (true) {
      const rows = this.db
        .query(
          `
            SELECT *, ${linkSortExpression()} AS sort_key
            FROM links
            WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?
              AND (? IS NULL OR ${linkSortExpression()} > ?)
            ORDER BY sort_key
            LIMIT 500
          `
        )
        .all(
          this.projectId,
          source.objectTypeId,
          source.primaryId,
          linkId,
          cursor,
          cursor
        ) as (EffectiveLinkRow & { readonly sort_key: string })[]
      for (const row of rows) appendScopeSnapshot(accumulator, effectiveLinkSnapshot(row))
      if (rows.length < 500) break
      cursor = rows[rows.length - 1]?.sort_key ?? null
    }
    return finishScopeAccumulator(accumulator)
  }

  *incidentLinks(
    objects: readonly OntologyObjectRef[],
    pageRows: number
  ): Iterable<OntologyLinkRef[]> {
    if (objects.length === 0) return
    const values = objects.map(() => "(?, ?)").join(", ")
    const args = objects.flatMap((ref) => [ref.objectTypeId, ref.primaryId])
    let cursor: string | null = null
    while (true) {
      const rows = this.db
        .query(
          `
            WITH requested(object_type_id, primary_id) AS (VALUES ${values}),
            authority_links AS (
              SELECT source_type_id, source_id, link_id, target_type_id, target_id
              FROM links WHERE project_id = ?
              UNION
              SELECT source_type_id, source_primary_id, link_id, target_type_id, target_primary_id
              FROM ontology_overrides
              WHERE project_id = ? AND entity_kind = 'link'
              UNION
              SELECT rows.source_type_id, rows.source_primary_id, rows.link_id,
                rows.target_type_id, rows.target_primary_id
              FROM ontology_source_rows AS rows
              JOIN ontology_sources AS sources
                ON sources.project_id = rows.project_id
               AND sources.source_id = rows.source_id
               AND sources.materialization_id = rows.materialization_id
              WHERE rows.project_id = ? AND rows.entity_kind = 'link' AND sources.status = 'active'
            ), selected AS (
              SELECT DISTINCT links.*,
                ${linkSortExpression("links")} AS sort_key
              FROM authority_links AS links
              WHERE EXISTS (
                SELECT 1 FROM requested
                WHERE (requested.object_type_id = links.source_type_id
                    AND requested.primary_id = links.source_id)
                   OR (requested.object_type_id = links.target_type_id
                    AND requested.primary_id = links.target_id)
              )
            )
            SELECT * FROM selected
            WHERE (? IS NULL OR sort_key > ?)
            ORDER BY sort_key
            LIMIT ?
          `
        )
        .all(
          ...args,
          this.projectId,
          this.projectId,
          this.projectId,
          cursor,
          cursor,
          pageRows
        ) as (EffectiveLinkRow & { readonly sort_key: string })[]
      if (rows.length === 0) break
      yield rows.map(linkRefFromColumns)
      cursor = rows[rows.length - 1]?.sort_key ?? null
    }
  }

  *replacementIdentities(input: ReplacementIdentityInput): Iterable<ReplacementIdentity[]> {
    let cursor: string | null = null
    while (true) {
      if (input.kind === "object") {
        const rows = this.replacementObjectRows(input, cursor)
        if (rows.length === 0) break
        yield rows.map((row) => ({
          kind: "object",
          ref: { objectTypeId: row.object_type_id, primaryId: row.primary_id },
          sortKey: row.sort_key,
          diffRequired: true,
        }))
        cursor = rows[rows.length - 1]?.sort_key ?? null
        continue
      }
      const rows = this.replacementLinkRows(input, cursor)
      if (rows.length === 0) break
      yield rows.map((row) => ({
        kind: "link",
        ref: linkRefFromColumns(row),
        sortKey: row.sort_key,
        diffRequired: row.diff_required === 1,
      }))
      cursor = rows[rows.length - 1]?.sort_key ?? null
    }
  }

  replacementObjectState(
    sourceId: string,
    candidateMaterializationId: string,
    ref: OntologyObjectRef
  ): SourceReplacementObjectState {
    const base = this.objectState(ref)
    return {
      ref: base.ref,
      candidateSource: this.candidateObjectSource(sourceId, candidateMaterializationId, ref),
      override: base.override,
      effective: base.effective,
      latestTelemetry: base.latestTelemetry,
    }
  }

  replacementLinkState(
    sourceId: string,
    candidateMaterializationId: string,
    ref: OntologyLinkRef,
    diffRequired: boolean,
    ownedByReplacement: boolean
  ): SourceReplacementLinkState {
    const base = this.linkState(ref)
    return {
      ref: base.ref,
      candidateSource: ownedByReplacement
        ? this.candidateLinkSource(sourceId, candidateMaterializationId, ref)
        : base.source,
      override: base.override,
      effective: base.effective,
      diffRequired,
    }
  }

  sourceOwnsEntity(
    sourceId: string,
    materializationIds: readonly string[],
    entityKey: string
  ): boolean {
    if (materializationIds.length === 0) return false
    const placeholders = materializationIds.map(() => "?").join(", ")
    return (
      this.db
        .query(
          `
          SELECT 1 FROM ontology_source_rows
          WHERE project_id = ? AND source_id = ? AND materialization_id IN (${placeholders})
            AND entity_key = ?
          LIMIT 1
        `
        )
        .get(this.projectId, sourceId, ...materializationIds, entityKey) !== null
    )
  }

  effectiveObjectRevision(ref: OntologyObjectRef): {
    readonly version: number
    readonly lastCommitId: string | null
  } | null {
    const row = this.db
      .query(
        `SELECT version, last_commit_id FROM objects
         WHERE project_id = ? AND object_type_id = ? AND primary_id = ?`
      )
      .get(this.projectId, ref.objectTypeId, ref.primaryId) as {
      readonly version: number
      readonly last_commit_id: string | null
    } | null
    return row ? { version: row.version, lastCommitId: row.last_commit_id } : null
  }

  effectiveLinkLastCommit(ref: OntologyLinkRef): string | null | undefined {
    const row = this.db
      .query(
        `
          SELECT last_commit_id FROM links
          WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?
            AND target_type_id = ? AND target_id = ?
        `
      )
      .get(
        this.projectId,
        ref.source.objectTypeId,
        ref.source.primaryId,
        ref.linkId,
        ref.target.objectTypeId,
        ref.target.primaryId
      ) as { readonly last_commit_id: string | null } | null
    return row ? row.last_commit_id : undefined
  }

  overrideLastCommit(kind: "object" | "link", entityKey: string): string | null {
    const row = this.db
      .query(
        `SELECT last_commit_id FROM ontology_overrides
         WHERE project_id = ? AND entity_kind = ? AND entity_key = ?`
      )
      .get(this.projectId, kind, entityKey) as { readonly last_commit_id: string } | null
    return row?.last_commit_id ?? null
  }

  private latestTelemetry(ref: OntologyObjectRef): StoredTelemetryPoint[] {
    const rows = this.db
      .query(
        `
          SELECT * FROM (
            SELECT timeseries.*,
              ROW_NUMBER() OVER (PARTITION BY property_id ORDER BY at DESC) AS rank
            FROM timeseries
            WHERE project_id = ? AND object_type_id = ? AND object_id = ?
          ) WHERE rank = 1
          ORDER BY ${pointSortExpression()}
        `
      )
      .all(this.projectId, ref.objectTypeId, ref.primaryId) as TelemetryRow[]
    return rows.map(storedPoint)
  }

  private getEffectiveLink(ref: OntologyLinkRef): EffectiveLinkRow | null {
    return this.db
      .query(
        `
          SELECT * FROM links
          WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?
            AND target_type_id = ? AND target_id = ?
        `
      )
      .get(
        this.projectId,
        ref.source.objectTypeId,
        ref.source.primaryId,
        ref.linkId,
        ref.target.objectTypeId,
        ref.target.primaryId
      ) as EffectiveLinkRow | null
  }

  private objectOverride(ref: OntologyObjectRef): StoredObjectOverride | null {
    const row = this.db
      .query(
        `
          SELECT entity_kind, value, last_commit_id, updated_at
          FROM ontology_overrides
          WHERE project_id = ? AND entity_kind = 'object' AND entity_key = ?
        `
      )
      .get(this.projectId, objectRefKey(ref)) as SqliteOntologyOverrideRow | null
    return row
      ? {
          ref: structuredClone(ref),
          value: parseJson<StoredObjectOverride["value"]>(row.value),
          lastCommitId: row.last_commit_id,
          updatedAt: row.updated_at,
        }
      : null
  }

  private linkOverride(ref: OntologyLinkRef): StoredLinkOverride | null {
    const row = this.db
      .query(
        `
          SELECT entity_kind, value, last_commit_id, updated_at
          FROM ontology_overrides
          WHERE project_id = ? AND entity_kind = 'link' AND entity_key = ?
        `
      )
      .get(this.projectId, linkRefKey(ref)) as SqliteOntologyOverrideRow | null
    return row
      ? {
          ref: structuredClone(ref),
          value: parseJson<StoredLinkOverride["value"]>(row.value),
          lastCommitId: row.last_commit_id,
          updatedAt: row.updated_at,
        }
      : null
  }

  private activeObjectSource(ref: OntologyObjectRef): StoredSourceObjectAssertion | null {
    const found = this.activeSource(projectionEntityKey({ kind: "object", ref }))
    return found?.assertion.kind === "object" ? (found as StoredSourceObjectAssertion) : null
  }

  private activeLinkSource(ref: OntologyLinkRef): StoredSourceLinkAssertion | null {
    const found = this.activeSource(projectionEntityKey({ kind: "link", ref }))
    return found?.assertion.kind === "link" ? (found as StoredSourceLinkAssertion) : null
  }

  private activeSource(entityKey: string): StoredSourceAssertion | null {
    const rows = this.db
      .query(
        `
          SELECT rows.*
          FROM ontology_source_rows AS rows
          JOIN ontology_sources AS sources
            ON sources.project_id = rows.project_id
           AND sources.source_id = rows.source_id
           AND sources.materialization_id = rows.materialization_id
          WHERE rows.project_id = ? AND rows.entity_key = ? AND sources.status = 'active'
          LIMIT 2
        `
      )
      .all(this.projectId, entityKey) as SqliteOntologySourceAssertionRow[]
    if (rows.length > 1) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Multiple active sources assert ${entityKey}.`
      )
    }
    return rows[0] ? storedSource(rows[0]) : null
  }

  private candidateObjectSource(
    sourceId: string,
    materializationId: string,
    ref: OntologyObjectRef
  ): StoredSourceObjectAssertion | null {
    const row = this.candidateSource(
      sourceId,
      materializationId,
      projectionEntityKey({ kind: "object", ref })
    )
    return row?.assertion.kind === "object" ? (row as StoredSourceObjectAssertion) : null
  }

  private candidateLinkSource(
    sourceId: string,
    materializationId: string,
    ref: OntologyLinkRef
  ): StoredSourceLinkAssertion | null {
    const row = this.candidateSource(
      sourceId,
      materializationId,
      projectionEntityKey({ kind: "link", ref })
    )
    return row?.assertion.kind === "link" ? (row as StoredSourceLinkAssertion) : null
  }

  private candidateSource(
    sourceId: string,
    materializationId: string,
    entityKey: string
  ): StoredSourceAssertion | null {
    const row = this.db
      .query(
        `
          SELECT * FROM ontology_source_rows
          WHERE project_id = ? AND source_id = ? AND materialization_id = ? AND entity_key = ?
        `
      )
      .get(
        this.projectId,
        sourceId,
        materializationId,
        entityKey
      ) as SqliteOntologySourceAssertionRow | null
    return row ? storedSource(row) : null
  }

  private replacementObjectRows(
    input: ReplacementIdentityInput,
    cursor: string | null
  ): (EffectiveObjectRow & { readonly sort_key: string })[] {
    return this.db
      .query(
        `
          SELECT DISTINCT object_type_id, primary_id, entity_sort_key AS sort_key
          FROM ontology_source_rows
          WHERE project_id = ? AND source_id = ? AND entity_kind = 'object'
            AND materialization_id IN (?, COALESCE(?, ''))
            AND (? IS NULL OR entity_sort_key > ?)
          ORDER BY sort_key
          LIMIT ?
        `
      )
      .all(
        this.projectId,
        input.sourceId,
        input.candidateMaterializationId,
        input.previousMaterializationId,
        cursor,
        cursor,
        input.pageRows
      ) as (EffectiveObjectRow & { readonly sort_key: string })[]
  }

  private replacementLinkRows(
    input: ReplacementIdentityInput,
    cursor: string | null
  ): (EffectiveLinkRow & { readonly sort_key: string; readonly diff_required: number })[] {
    return this.db
      .query(
        `
          WITH incident_objects AS (
            SELECT
              json_extract(payload, '$.ref.objectTypeId') AS object_type_id,
              json_extract(payload, '$.ref.primaryId') AS primary_id
            FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
            WHERE session_id = ? AND kind = 'incident-object'
          ), authority_links AS (
            SELECT source_type_id, source_id, link_id, target_type_id, target_id
            FROM links WHERE project_id = ?
            UNION
            SELECT source_type_id, source_primary_id, link_id, target_type_id, target_primary_id
            FROM ontology_overrides
            WHERE project_id = ? AND entity_kind = 'link'
            UNION
            SELECT rows.source_type_id, rows.source_primary_id, rows.link_id,
              rows.target_type_id, rows.target_primary_id
            FROM ontology_source_rows AS rows
            JOIN ontology_sources AS sources
              ON sources.project_id = rows.project_id
             AND sources.source_id = rows.source_id
             AND sources.materialization_id = rows.materialization_id
            WHERE rows.project_id = ? AND rows.entity_kind = 'link' AND sources.status = 'active'
          ), replacement_links AS (
            SELECT source_type_id, source_primary_id AS source_id, link_id,
              target_type_id, target_primary_id AS target_id
            FROM ontology_source_rows
            WHERE project_id = ? AND source_id = ? AND entity_kind = 'link'
              AND materialization_id IN (?, COALESCE(?, ''))
          ), incident_links AS (
            SELECT links.* FROM authority_links AS links
            WHERE EXISTS (
              SELECT 1 FROM incident_objects
              WHERE (incident_objects.object_type_id = links.source_type_id
                  AND incident_objects.primary_id = links.source_id)
                 OR (incident_objects.object_type_id = links.target_type_id
                  AND incident_objects.primary_id = links.target_id)
            )
          ), diff_links AS (
            SELECT * FROM replacement_links
            UNION SELECT * FROM incident_links
          ), affected_scopes AS (
            SELECT DISTINCT source_type_id, source_id, link_id FROM diff_links
          ), all_links AS (
            SELECT *, 1 AS diff_required FROM diff_links
            UNION ALL
            SELECT links.source_type_id, links.source_id, links.link_id,
              links.target_type_id, links.target_id, 0 AS diff_required
            FROM links
            JOIN affected_scopes USING (source_type_id, source_id, link_id)
            WHERE links.project_id = ?
          ), selected AS (
            SELECT source_type_id, source_id, link_id, target_type_id, target_id,
              ${linkSortExpression("all_links")} AS sort_key,
              MAX(diff_required) AS diff_required
            FROM all_links
            GROUP BY source_type_id, source_id, link_id, target_type_id, target_id
          )
          SELECT * FROM selected
          WHERE (? IS NULL OR sort_key > ?)
          ORDER BY sort_key
          LIMIT ?
        `
      )
      .all(
        input.sessionId,
        this.projectId,
        this.projectId,
        this.projectId,
        this.projectId,
        input.sourceId,
        input.candidateMaterializationId,
        input.previousMaterializationId,
        this.projectId,
        cursor,
        cursor,
        input.pageRows
      ) as (EffectiveLinkRow & { readonly sort_key: string; readonly diff_required: number })[]
  }
}

function storedSource(row: SqliteOntologySourceAssertionRow): StoredSourceAssertion {
  return {
    source: { projectionId: row.source_id },
    materializationId: row.materialization_id,
    root: parseJson<StoredSourceAssertion["root"]>(row.root),
    assertion: parseJson<StoredSourceAssertion["assertion"]>(row.assertion),
    stagingOrdinal: row.staging_ordinal,
  } as StoredSourceAssertion
}

function effectiveObjectSnapshot(row: EffectiveObjectRow): EffectiveObjectSnapshot {
  if (!row.last_commit_id) {
    throw new MaterializationConflictError(
      "effective-state",
      `Effective object ${row.object_type_id}:${row.primary_id} lacks materializer provenance.`
    )
  }
  return {
    ref: objectRefFromColumns(row),
    properties: parseJson<EffectiveObjectSnapshot["properties"]>(row.properties),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCommitId: row.last_commit_id,
  }
}

function effectiveLinkSnapshot(row: EffectiveLinkRow): EffectiveLinkSnapshot {
  if (!row.last_commit_id) {
    throw new MaterializationConflictError(
      "effective-state",
      `Effective link ${linkRefKey(linkRefFromColumns(row))} lacks materializer provenance.`
    )
  }
  return {
    ref: linkRefFromColumns(row),
    ...(row.properties === null
      ? {}
      : {
          properties: parseJson<NonNullable<EffectiveLinkSnapshot["properties"]>>(row.properties),
        }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCommitId: row.last_commit_id,
  }
}

function storedPoint(row: TelemetryRow): StoredTelemetryPoint {
  if (!row.last_commit_id) {
    throw new MaterializationConflictError(
      "timeseries-point",
      `Telemetry point ${telemetryPointSortKey(
        {
          object: { objectTypeId: row.object_type_id, primaryId: row.object_id },
          propertyId: row.property_id,
        },
        row.at
      )} lacks materializer provenance.`
    )
  }
  return {
    series: {
      object: { objectTypeId: row.object_type_id, primaryId: row.object_id },
      propertyId: row.property_id,
    },
    value: parseJson<StoredTelemetryPoint["value"]>(row.value),
    ...(row.unit === null ? {} : { unit: row.unit }),
    at: row.at,
    lastCommitId: row.last_commit_id,
  }
}

export function objectSortExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return `LOWER(HEX(CAST(json_array(${prefix}object_type_id, ${prefix}primary_id) AS BLOB)))`
}

export function linkSortExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return `LOWER(HEX(CAST(json_array(${prefix}source_type_id, ${prefix}source_id, ${prefix}link_id, ${prefix}target_type_id, ${prefix}target_id) AS BLOB)))`
}

export function pointSortExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return `LOWER(HEX(CAST(json_array(${prefix}object_type_id, ${prefix}object_id, ${prefix}property_id, ${prefix}at) AS BLOB)))`
}
