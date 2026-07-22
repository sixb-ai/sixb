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
import type { SQLClient } from "../pg-client"
import {
  databaseSafeInteger,
  jsonKeyParameter,
  jsonParameter,
  linkRefFromColumns,
  objectRefFromColumns,
  type PgOntologyOverrideRow,
  type PgOntologySourceAssertionRow,
  toIsoString,
} from "./shared"

export const PG_MATERIALIZATION_WORK_TABLE = "ontology_materialization_work"
export const PG_REPLACEMENT_WORK_TABLE = "ontology_replacement_work"

interface EffectiveObjectRow {
  readonly object_type_id: string
  readonly primary_id: string
  readonly properties: unknown
  readonly created_at: Date | string
  readonly updated_at: Date | string
  readonly version: number
  readonly last_commit_id: string | null
}

interface EffectiveLinkRow {
  readonly source_type_id: string
  readonly source_id: string
  readonly link_id: string
  readonly target_type_id: string
  readonly target_id: string
  readonly properties: unknown | null
  readonly created_at: Date | string
  readonly updated_at: Date | string
  readonly last_commit_id: string | null
}

interface TelemetryRow {
  readonly object_type_id: string
  readonly object_id: string
  readonly property_id: string
  readonly value: unknown
  readonly unit: string | null
  readonly at: Date | string
  readonly last_commit_id: string | null
}

interface LinkIdentityRow {
  readonly source_type_id: string
  readonly source_id: string
  readonly link_id: string
  readonly target_type_id: string
  readonly target_id: string
  readonly sort_key: string
}

export interface ReplacementIdentity {
  readonly kind: "object" | "link"
  readonly ref: OntologyObjectRef | OntologyLinkRef
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

export class PgMaterializationStateReader {
  constructor(
    private readonly sql: SQLClient,
    readonly projectId: string
  ) {}

  async objectState(ref: OntologyObjectRef): Promise<MaterializationObjectState> {
    const [effective] = await this.sql<EffectiveObjectRow[]>`
      SELECT * FROM objects
      WHERE project_id = ${this.projectId}
        AND object_type_id = ${ref.objectTypeId}
        AND primary_id = ${ref.primaryId}
    `
    return {
      ref: structuredClone(ref),
      source: await this.activeObjectSource(ref),
      override: await this.objectOverride(ref),
      effective: effective ? effectiveObjectSnapshot(effective) : null,
      latestTelemetry: await this.latestTelemetry(ref),
    }
  }

  async linkState(ref: OntologyLinkRef): Promise<MaterializationLinkState> {
    const effective = await this.getEffectiveLink(ref)
    return {
      ref: structuredClone(ref),
      source: await this.activeLinkSource(ref),
      override: await this.linkOverride(ref),
      effective: effective ? effectiveLinkSnapshot(effective) : null,
    }
  }

  async exactPoint(
    series: TelemetrySeriesRef,
    at: string,
    lock = false
  ): Promise<StoredTelemetryPoint | null> {
    const lockFragment = lock ? this.sql`FOR UPDATE` : this.sql``
    const [row] = await this.sql<TelemetryRow[]>`
      SELECT * FROM timeseries
      WHERE project_id = ${this.projectId}
        AND object_type_id = ${series.object.objectTypeId}
        AND object_id = ${series.object.primaryId}
        AND property_id = ${series.propertyId}
        AND at = ${at}
      ${lockFragment}
    `
    return row ? storedPoint(row) : null
  }

  async linkScope(
    source: OntologyObjectRef,
    linkId: string
  ): Promise<MaterializationLinkScopeState> {
    const accumulator = startScopeAccumulator(source, linkId, "")
    let cursor: string | null = null
    while (true) {
      const rows: (EffectiveLinkRow & { readonly sort_key: string })[] = await this.sql`
        WITH selected AS (
          SELECT links.*, ${this.sql.unsafe(linkSortExpression("links"))} AS sort_key
          FROM links
          WHERE project_id = ${this.projectId}
            AND source_type_id = ${source.objectTypeId}
            AND source_id = ${source.primaryId}
            AND link_id = ${linkId}
        )
        SELECT * FROM selected
        WHERE (${cursor}::text IS NULL OR sort_key > ${cursor})
        ORDER BY sort_key
        LIMIT 500
      `
      for (const row of rows) appendScopeSnapshot(accumulator, effectiveLinkSnapshot(row))
      if (rows.length < 500) break
      cursor = rows[rows.length - 1]?.sort_key ?? null
    }
    return finishScopeAccumulator(accumulator)
  }

  async *incidentLinks(
    objects: readonly OntologyObjectRef[],
    pageRows: number
  ): AsyncIterable<OntologyLinkRef[]> {
    if (objects.length === 0) return
    const requested = objects.map((ref) => ({
      object_type_id: ref.objectTypeId,
      primary_id: ref.primaryId,
    }))
    let cursor: string | null = null
    while (true) {
      const rows: LinkIdentityRow[] = await this.sql`
        WITH requested AS (
          SELECT *
          FROM jsonb_to_recordset(${jsonParameter(this.sql, requested)})
            AS requested_values(object_type_id TEXT, primary_id TEXT)
        ), authority_links AS (
          SELECT source_type_id, source_id, link_id, target_type_id, target_id
          FROM links WHERE project_id = ${this.projectId}
          UNION
          SELECT source_type_id, source_primary_id AS source_id, link_id,
            target_type_id, target_primary_id AS target_id
          FROM ontology_overrides
          WHERE project_id = ${this.projectId} AND entity_kind = 'link'
          UNION
          SELECT rows.source_type_id, rows.source_primary_id AS source_id, rows.link_id,
            rows.target_type_id, rows.target_primary_id AS target_id
          FROM ontology_source_rows AS rows
          JOIN ontology_sources AS sources
            ON sources.project_id = rows.project_id
           AND sources.source_id = rows.source_id
           AND sources.materialization_id = rows.materialization_id
          WHERE rows.project_id = ${this.projectId}
            AND rows.entity_kind = 'link'
            AND sources.status = 'active'
        ), selected AS (
          SELECT DISTINCT links.*,
            ${this.sql.unsafe(linkSortExpression("links"))} AS sort_key
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
        WHERE (${cursor}::text IS NULL OR sort_key > ${cursor})
        ORDER BY sort_key
        LIMIT ${pageRows}
      `
      if (rows.length === 0) break
      yield rows.map(linkRefFromColumns)
      cursor = rows[rows.length - 1]?.sort_key ?? null
    }
  }

  async *replacementIdentities(
    input: ReplacementIdentityInput
  ): AsyncIterable<ReplacementIdentity[]> {
    let cursor: string | null = null
    while (true) {
      if (input.kind === "object") {
        const rows = await this.replacementObjectRows(input, cursor)
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
      const rows = await this.replacementLinkRows(input, cursor)
      if (rows.length === 0) break
      yield rows.map((row) => ({
        kind: "link",
        ref: linkRefFromColumns(row),
        sortKey: row.sort_key,
        diffRequired: row.diff_required,
      }))
      cursor = rows[rows.length - 1]?.sort_key ?? null
    }
  }

  async replacementObjectState(
    sourceId: string,
    candidateMaterializationId: string,
    ref: OntologyObjectRef
  ): Promise<SourceReplacementObjectState> {
    const base = await this.objectState(ref)
    return {
      ref: base.ref,
      candidateSource: await this.candidateObjectSource(sourceId, candidateMaterializationId, ref),
      override: base.override,
      effective: base.effective,
      latestTelemetry: base.latestTelemetry,
    }
  }

  async replacementLinkState(
    sourceId: string,
    candidateMaterializationId: string,
    ref: OntologyLinkRef,
    diffRequired: boolean,
    ownedByReplacement: boolean
  ): Promise<SourceReplacementLinkState> {
    const base = await this.linkState(ref)
    return {
      ref: base.ref,
      candidateSource: ownedByReplacement
        ? await this.candidateLinkSource(sourceId, candidateMaterializationId, ref)
        : base.source,
      override: base.override,
      effective: base.effective,
      diffRequired,
    }
  }

  async sourceOwnsEntity(
    sourceId: string,
    materializationIds: readonly string[],
    entityKey: string
  ): Promise<boolean> {
    if (materializationIds.length === 0) return false
    const [row] = await this.sql<{ readonly marker: number }[]>`
      SELECT 1 AS marker FROM ontology_source_rows
      WHERE project_id = ${this.projectId}
        AND source_id = ${sourceId}
        AND materialization_id = ANY(${this.sql.array([...materializationIds])}::text[])
        AND entity_key = ${jsonKeyParameter(this.sql, entityKey)}
      LIMIT 1
    `
    return row !== undefined
  }

  async effectiveObjectRevision(
    ref: OntologyObjectRef,
    lock = false
  ): Promise<{ readonly version: number; readonly lastCommitId: string | null } | null> {
    const lockFragment = lock ? this.sql`FOR UPDATE` : this.sql``
    const [row] = await this.sql<
      { readonly version: number; readonly last_commit_id: string | null }[]
    >`
      SELECT version, last_commit_id FROM objects
      WHERE project_id = ${this.projectId}
        AND object_type_id = ${ref.objectTypeId}
        AND primary_id = ${ref.primaryId}
      ${lockFragment}
    `
    return row ? { version: row.version, lastCommitId: row.last_commit_id } : null
  }

  async effectiveLinkLastCommit(
    ref: OntologyLinkRef,
    lock = false
  ): Promise<string | null | undefined> {
    const lockFragment = lock ? this.sql`FOR UPDATE` : this.sql``
    const [row] = await this.sql<{ readonly last_commit_id: string | null }[]>`
      SELECT last_commit_id FROM links
      WHERE project_id = ${this.projectId}
        AND source_type_id = ${ref.source.objectTypeId}
        AND source_id = ${ref.source.primaryId}
        AND link_id = ${ref.linkId}
        AND target_type_id = ${ref.target.objectTypeId}
        AND target_id = ${ref.target.primaryId}
      ${lockFragment}
    `
    return row ? row.last_commit_id : undefined
  }

  async overrideLastCommit(kind: "object" | "link", entityKey: string): Promise<string | null> {
    const [row] = await this.sql<{ readonly last_commit_id: string }[]>`
      SELECT last_commit_id FROM ontology_overrides
      WHERE project_id = ${this.projectId}
        AND entity_kind = ${kind}
        AND entity_key = ${jsonKeyParameter(this.sql, entityKey)}
    `
    return row?.last_commit_id ?? null
  }

  private async latestTelemetry(ref: OntologyObjectRef): Promise<StoredTelemetryPoint[]> {
    const rows = await this.sql<TelemetryRow[]>`
      SELECT * FROM (
        SELECT timeseries.*,
          ROW_NUMBER() OVER (PARTITION BY property_id ORDER BY at DESC) AS rank
        FROM timeseries
        WHERE project_id = ${this.projectId}
          AND object_type_id = ${ref.objectTypeId}
          AND object_id = ${ref.primaryId}
      ) AS ranked
      WHERE rank = 1
      ORDER BY ${this.sql.unsafe(pointSortExpression("ranked"))}
    `
    return rows.map(storedPoint)
  }

  private async getEffectiveLink(ref: OntologyLinkRef): Promise<EffectiveLinkRow | null> {
    const [row] = await this.sql<EffectiveLinkRow[]>`
      SELECT * FROM links
      WHERE project_id = ${this.projectId}
        AND source_type_id = ${ref.source.objectTypeId}
        AND source_id = ${ref.source.primaryId}
        AND link_id = ${ref.linkId}
        AND target_type_id = ${ref.target.objectTypeId}
        AND target_id = ${ref.target.primaryId}
    `
    return row ?? null
  }

  private async objectOverride(ref: OntologyObjectRef): Promise<StoredObjectOverride | null> {
    const [row] = await this.sql<PgOntologyOverrideRow[]>`
      SELECT entity_kind, value, last_commit_id, updated_at
      FROM ontology_overrides
      WHERE project_id = ${this.projectId}
        AND entity_kind = 'object'
        AND entity_key = ${jsonKeyParameter(this.sql, objectRefKey(ref))}
    `
    return row
      ? {
          ref: structuredClone(ref),
          value: structuredClone(row.value) as StoredObjectOverride["value"],
          lastCommitId: row.last_commit_id,
          updatedAt: toIsoString(row.updated_at),
        }
      : null
  }

  private async linkOverride(ref: OntologyLinkRef): Promise<StoredLinkOverride | null> {
    const [row] = await this.sql<PgOntologyOverrideRow[]>`
      SELECT entity_kind, value, last_commit_id, updated_at
      FROM ontology_overrides
      WHERE project_id = ${this.projectId}
        AND entity_kind = 'link'
        AND entity_key = ${jsonKeyParameter(this.sql, linkRefKey(ref))}
    `
    return row
      ? {
          ref: structuredClone(ref),
          value: structuredClone(row.value) as StoredLinkOverride["value"],
          lastCommitId: row.last_commit_id,
          updatedAt: toIsoString(row.updated_at),
        }
      : null
  }

  private async activeObjectSource(
    ref: OntologyObjectRef
  ): Promise<StoredSourceObjectAssertion | null> {
    const found = await this.activeSource(projectionEntityKey({ kind: "object", ref }))
    return found?.assertion.kind === "object" ? (found as StoredSourceObjectAssertion) : null
  }

  private async activeLinkSource(ref: OntologyLinkRef): Promise<StoredSourceLinkAssertion | null> {
    const found = await this.activeSource(projectionEntityKey({ kind: "link", ref }))
    return found?.assertion.kind === "link" ? (found as StoredSourceLinkAssertion) : null
  }

  private async activeSource(entityKey: string): Promise<StoredSourceAssertion | null> {
    const rows = await this.sql<PgOntologySourceAssertionRow[]>`
      SELECT rows.*
      FROM ontology_source_rows AS rows
      JOIN ontology_sources AS sources
        ON sources.project_id = rows.project_id
       AND sources.source_id = rows.source_id
       AND sources.materialization_id = rows.materialization_id
      WHERE rows.project_id = ${this.projectId}
        AND rows.entity_key = ${jsonKeyParameter(this.sql, entityKey)}
        AND sources.status = 'active'
      LIMIT 2
    `
    if (rows.length > 1) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Multiple active sources assert ${entityKey}.`
      )
    }
    return rows[0] ? storedSource(rows[0]) : null
  }

  private async candidateObjectSource(
    sourceId: string,
    materializationId: string,
    ref: OntologyObjectRef
  ): Promise<StoredSourceObjectAssertion | null> {
    const row = await this.candidateSource(
      sourceId,
      materializationId,
      projectionEntityKey({ kind: "object", ref })
    )
    return row?.assertion.kind === "object" ? (row as StoredSourceObjectAssertion) : null
  }

  private async candidateLinkSource(
    sourceId: string,
    materializationId: string,
    ref: OntologyLinkRef
  ): Promise<StoredSourceLinkAssertion | null> {
    const row = await this.candidateSource(
      sourceId,
      materializationId,
      projectionEntityKey({ kind: "link", ref })
    )
    return row?.assertion.kind === "link" ? (row as StoredSourceLinkAssertion) : null
  }

  private async candidateSource(
    sourceId: string,
    materializationId: string,
    entityKey: string
  ): Promise<StoredSourceAssertion | null> {
    const [row] = await this.sql<PgOntologySourceAssertionRow[]>`
      SELECT * FROM ontology_source_rows
      WHERE project_id = ${this.projectId}
        AND source_id = ${sourceId}
        AND materialization_id = ${materializationId}
        AND entity_key = ${jsonKeyParameter(this.sql, entityKey)}
    `
    return row ? storedSource(row) : null
  }

  private async replacementObjectRows(
    input: ReplacementIdentityInput,
    cursor: string | null
  ): Promise<
    { readonly object_type_id: string; readonly primary_id: string; readonly sort_key: string }[]
  > {
    const after = cursor === null ? this.sql`` : this.sql`AND entity_sort_key > ${cursor}`
    return this.sql`
      SELECT DISTINCT object_type_id, primary_id, entity_sort_key AS sort_key
      FROM ontology_source_rows
      WHERE project_id = ${this.projectId}
        AND source_id = ${input.sourceId}
        AND entity_kind = 'object'
        AND materialization_id = ANY(
          ${this.sql.array(
            [input.candidateMaterializationId, input.previousMaterializationId].filter(
              (value): value is string => value !== null
            )
          )}::text[]
        )
        ${after}
      ORDER BY sort_key
      LIMIT ${input.pageRows}
    `
  }

  private async replacementLinkRows(
    input: ReplacementIdentityInput,
    cursor: string | null
  ): Promise<(LinkIdentityRow & { readonly diff_required: boolean })[]> {
    const materializationIds = [
      input.candidateMaterializationId,
      ...(input.previousMaterializationId ? [input.previousMaterializationId] : []),
    ]
    const after = cursor === null ? this.sql`` : this.sql`WHERE sort_key > ${cursor}`
    return this.sql`
      WITH incident_objects AS (
        SELECT payload->'ref'->>'objectTypeId' AS object_type_id,
          payload->'ref'->>'primaryId' AS primary_id
        FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
        WHERE session_id = ${input.sessionId} AND kind = 'incident-object'
      ), authority_links AS (
        SELECT source_type_id, source_id, link_id, target_type_id, target_id
        FROM links WHERE project_id = ${this.projectId}
        UNION
        SELECT source_type_id, source_primary_id AS source_id, link_id,
          target_type_id, target_primary_id AS target_id
        FROM ontology_overrides
        WHERE project_id = ${this.projectId} AND entity_kind = 'link'
        UNION
        SELECT rows.source_type_id, rows.source_primary_id AS source_id, rows.link_id,
          rows.target_type_id, rows.target_primary_id AS target_id
        FROM ontology_source_rows AS rows
        JOIN ontology_sources AS sources
          ON sources.project_id = rows.project_id
         AND sources.source_id = rows.source_id
         AND sources.materialization_id = rows.materialization_id
        WHERE rows.project_id = ${this.projectId}
          AND rows.entity_kind = 'link'
          AND sources.status = 'active'
      ), replacement_links AS (
        SELECT source_type_id, source_primary_id AS source_id, link_id,
          target_type_id, target_primary_id AS target_id
        FROM ontology_source_rows
        WHERE project_id = ${this.projectId}
          AND source_id = ${input.sourceId}
          AND entity_kind = 'link'
          AND materialization_id = ANY(${this.sql.array(materializationIds)}::text[])
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
        SELECT diff_links.*, TRUE AS diff_required FROM diff_links
        UNION ALL
        SELECT links.source_type_id, links.source_id, links.link_id,
          links.target_type_id, links.target_id, FALSE AS diff_required
        FROM links
        JOIN affected_scopes USING (source_type_id, source_id, link_id)
        WHERE links.project_id = ${this.projectId}
      ), selected AS (
        SELECT source_type_id, source_id, link_id, target_type_id, target_id,
          ${this.sql.unsafe(linkSortExpression("all_links"))} AS sort_key,
          BOOL_OR(diff_required) AS diff_required
        FROM all_links
        GROUP BY source_type_id, source_id, link_id, target_type_id, target_id
      )
      SELECT * FROM selected
      ${after}
      ORDER BY sort_key
      LIMIT ${input.pageRows}
    `
  }
}

function storedSource(row: PgOntologySourceAssertionRow): StoredSourceAssertion {
  return {
    source: { projectionId: row.source_id },
    materializationId: row.materialization_id,
    root: structuredClone(row.root) as StoredSourceAssertion["root"],
    assertion: structuredClone(row.assertion) as StoredSourceAssertion["assertion"],
    stagingOrdinal: databaseSafeInteger(row.staging_ordinal, "Source staging ordinal"),
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
    properties: structuredClone(row.properties) as EffectiveObjectSnapshot["properties"],
    version: row.version,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
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
          properties: structuredClone(row.properties) as NonNullable<
            EffectiveLinkSnapshot["properties"]
          >,
        }),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    lastCommitId: row.last_commit_id,
  }
}

function storedPoint(row: TelemetryRow): StoredTelemetryPoint {
  const at = toIsoString(row.at)
  if (!row.last_commit_id) {
    throw new MaterializationConflictError(
      "timeseries-point",
      `Telemetry point ${telemetryPointSortKey(
        {
          object: { objectTypeId: row.object_type_id, primaryId: row.object_id },
          propertyId: row.property_id,
        },
        at
      )} lacks materializer provenance.`
    )
  }
  return {
    series: {
      object: { objectTypeId: row.object_type_id, primaryId: row.object_id },
      propertyId: row.property_id,
    },
    value: structuredClone(row.value) as StoredTelemetryPoint["value"],
    ...(row.unit === null ? {} : { unit: row.unit }),
    at,
    lastCommitId: row.last_commit_id,
  }
}

export function objectSortExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return jsonTupleSortExpression([
    `to_jsonb(${prefix}object_type_id)::text`,
    `to_jsonb(${prefix}primary_id)::text`,
  ])
}

export function linkSortExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return jsonTupleSortExpression([
    `to_jsonb(${prefix}source_type_id)::text`,
    `to_jsonb(${prefix}source_id)::text`,
    `to_jsonb(${prefix}link_id)::text`,
    `to_jsonb(${prefix}target_type_id)::text`,
    `to_jsonb(${prefix}target_id)::text`,
  ])
}

export function pointSortExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return jsonTupleSortExpression([
    `to_jsonb(${prefix}object_type_id)::text`,
    `to_jsonb(${prefix}object_id)::text`,
    `to_jsonb(${prefix}property_id)::text`,
    `to_jsonb(to_char(${prefix}at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text`,
  ])
}

function jsonTupleSortExpression(parts: readonly string[]): string {
  return `encode(convert_to(concat('[', ${parts.join(", ',', ")}, ']'), 'UTF8'), 'hex')`
}
