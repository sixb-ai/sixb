import type { Database } from "bun:sqlite"
import type {
  EffectiveLinkSnapshot,
  EffectiveObjectSnapshot,
  OntologyLinkRef,
  OntologyObjectRef,
  ProjectionEntityRef,
  TelemetrySeriesRef,
} from "@sixb/core/internal/materialization"
import {
  linkRefKey,
  linkScopeSortKey,
  MaterializationConflictError,
  objectRefKey,
  projectionEntityKey,
  telemetryPointSortKey,
} from "@sixb/core/internal/materialization"
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
  canonicalJson,
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

interface LinkScopeRow extends EffectiveLinkRow {
  readonly scope_sort_key: string
}

interface ObjectOverrideRow extends SqliteOntologyOverrideRow {
  readonly object_type_id: string
  readonly primary_id: string
}

interface LinkOverrideRow extends SqliteOntologyOverrideRow {
  readonly source_type_id: string
  readonly source_primary_id: string
  readonly link_id: string
  readonly target_type_id: string
  readonly target_primary_id: string
}

interface ReplacementSources {
  readonly owned: ReadonlySet<string>
  readonly byMaterialization: ReadonlyMap<string, ReadonlyMap<string, StoredSourceAssertion>>
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
    return this.objectStates([ref])[0]!
  }

  objectStates(refs: readonly OntologyObjectRef[]): readonly MaterializationObjectState[] {
    if (refs.length === 0) return []
    const requested = canonicalJson(
      refs.map((ref) => ({ objectTypeId: ref.objectTypeId, primaryId: ref.primaryId }))
    )
    const requestedObjects = `
      SELECT DISTINCT json_extract(value, '$.objectTypeId') AS object_type_id,
        json_extract(value, '$.primaryId') AS primary_id
      FROM json_each(?)
    `
    // Keep the JSON request set on the outer side of each lookup. SQLite cannot estimate the
    // cardinality of json_each() and otherwise scans every project row once per requested key.
    // CROSS JOIN deliberately fixes the loop order so the existing composite indexes are used.
    const effectiveRows = this.db
      .query(
        `WITH requested AS (${requestedObjects})
         SELECT objects.* FROM requested
         CROSS JOIN objects
           ON objects.project_id = ?
          AND objects.object_type_id = requested.object_type_id
          AND objects.primary_id = requested.primary_id`
      )
      .all(requested, this.projectId) as EffectiveObjectRow[]
    const sourceRows = this.db
      .query(
        `WITH requested AS (${requestedObjects})
         SELECT rows.* FROM requested
         CROSS JOIN ontology_source_rows AS rows
           ON rows.project_id = ?
          AND rows.entity_kind = 'object'
          AND rows.object_type_id = requested.object_type_id
          AND rows.primary_id = requested.primary_id
         JOIN ontology_sources AS sources
           ON sources.project_id = rows.project_id
          AND sources.source_id = rows.source_id
          AND sources.materialization_id = rows.materialization_id
         WHERE sources.status = 'active'`
      )
      .all(requested, this.projectId) as SqliteOntologySourceAssertionRow[]
    const overrideRows = this.db
      .query(
        `WITH requested AS (${requestedObjects})
         SELECT overrides.* FROM requested
         CROSS JOIN ontology_overrides AS overrides
           ON overrides.project_id = ?
          AND overrides.entity_kind = 'object'
          AND overrides.object_type_id = requested.object_type_id
          AND overrides.primary_id = requested.primary_id`
      )
      .all(requested, this.projectId) as ObjectOverrideRow[]
    const telemetryRows = this.db
      .query(
        `WITH requested AS (${requestedObjects}), ranked AS (
           SELECT timeseries.*,
             ROW_NUMBER() OVER (
               PARTITION BY timeseries.object_type_id, timeseries.object_id,
                 timeseries.property_id
               ORDER BY timeseries.at DESC
             ) AS rank
           FROM requested
           CROSS JOIN timeseries
             ON timeseries.project_id = ?
            AND timeseries.object_type_id = requested.object_type_id
            AND timeseries.object_id = requested.primary_id
         )
         SELECT * FROM ranked WHERE rank = 1`
      )
      .all(requested, this.projectId) as TelemetryRow[]

    const effective = new Map(
      effectiveRows.map((row) => [objectRefKey(objectRefFromColumns(row)), row] as const)
    )
    const sources = activeSourceMap(sourceRows)
    const overrides = new Map(
      overrideRows.map(
        (row) => [objectRefKey(objectRefFromColumns(row)), storedObjectOverride(row)] as const
      )
    )
    const telemetry = new Map<string, StoredTelemetryPoint[]>()
    for (const row of telemetryRows) {
      const key = objectRefKey({ objectTypeId: row.object_type_id, primaryId: row.object_id })
      const points = telemetry.get(key) ?? []
      points.push(storedPoint(row))
      telemetry.set(key, points)
    }
    for (const points of telemetry.values()) {
      points.sort((left, right) =>
        telemetryPointSortKey(left.series, left.at).localeCompare(
          telemetryPointSortKey(right.series, right.at)
        )
      )
    }

    return refs.map((ref) => {
      const key = objectRefKey(ref)
      const effectiveRow = effective.get(key)
      return {
        ref: structuredClone(ref),
        source: sourceObject(sources.get(projectionEntityKey({ kind: "object", ref }))),
        override: overrides.get(key) ?? null,
        effective: effectiveRow ? effectiveObjectSnapshot(effectiveRow) : null,
        latestTelemetry: telemetry.get(key) ?? [],
      }
    })
  }

  linkState(ref: OntologyLinkRef): MaterializationLinkState {
    return this.linkStates([ref])[0]!
  }

  linkStates(refs: readonly OntologyLinkRef[]): readonly MaterializationLinkState[] {
    if (refs.length === 0) return []
    const requested = canonicalJson(
      refs.map((ref) => ({
        sourceTypeId: ref.source.objectTypeId,
        sourceId: ref.source.primaryId,
        linkId: ref.linkId,
        targetTypeId: ref.target.objectTypeId,
        targetId: ref.target.primaryId,
      }))
    )
    const effectiveRequest = `
      SELECT DISTINCT json_extract(value, '$.sourceTypeId') AS source_type_id,
        json_extract(value, '$.sourceId') AS source_id,
        json_extract(value, '$.linkId') AS link_id,
        json_extract(value, '$.targetTypeId') AS target_type_id,
        json_extract(value, '$.targetId') AS target_id
      FROM json_each(?)
    `
    const sourceRequest = `
      SELECT DISTINCT json_extract(value, '$.sourceTypeId') AS source_type_id,
        json_extract(value, '$.sourceId') AS source_primary_id,
        json_extract(value, '$.linkId') AS link_id,
        json_extract(value, '$.targetTypeId') AS target_type_id,
        json_extract(value, '$.targetId') AS target_primary_id
      FROM json_each(?)
    `
    const effectiveRows = this.db
      .query(
        `WITH requested AS (${effectiveRequest})
         SELECT links.* FROM requested
         CROSS JOIN links
           ON links.project_id = ?
          AND links.source_type_id = requested.source_type_id
          AND links.source_id = requested.source_id
          AND links.link_id = requested.link_id
          AND links.target_type_id = requested.target_type_id
          AND links.target_id = requested.target_id`
      )
      .all(requested, this.projectId) as EffectiveLinkRow[]
    const sourceRows = this.db
      .query(
        `WITH requested AS (${sourceRequest})
         SELECT rows.* FROM requested
         CROSS JOIN ontology_source_rows AS rows
           ON rows.project_id = ?
          AND rows.entity_kind = 'link'
          AND rows.source_type_id = requested.source_type_id
          AND rows.source_primary_id = requested.source_primary_id
          AND rows.link_id = requested.link_id
          AND rows.target_type_id = requested.target_type_id
          AND rows.target_primary_id = requested.target_primary_id
         JOIN ontology_sources AS sources
           ON sources.project_id = rows.project_id
          AND sources.source_id = rows.source_id
          AND sources.materialization_id = rows.materialization_id
         WHERE sources.status = 'active'`
      )
      .all(requested, this.projectId) as SqliteOntologySourceAssertionRow[]
    const overrideRows = this.db
      .query(
        `WITH requested AS (${sourceRequest})
         SELECT overrides.* FROM requested
         CROSS JOIN ontology_overrides AS overrides
           ON overrides.project_id = ?
          AND overrides.entity_kind = 'link'
          AND overrides.source_type_id = requested.source_type_id
          AND overrides.source_primary_id = requested.source_primary_id
          AND overrides.link_id = requested.link_id
          AND overrides.target_type_id = requested.target_type_id
          AND overrides.target_primary_id = requested.target_primary_id`
      )
      .all(requested, this.projectId) as LinkOverrideRow[]
    const effective = new Map(
      effectiveRows.map((row) => [linkRefKey(linkRefFromColumns(row)), row] as const)
    )
    const sources = activeSourceMap(sourceRows)
    const overrides = new Map(
      overrideRows.map(
        (row) => [linkRefKey(linkRefFromOverrideColumns(row)), storedLinkOverride(row)] as const
      )
    )
    return refs.map((ref) => {
      const key = linkRefKey(ref)
      const effectiveRow = effective.get(key)
      return {
        ref: structuredClone(ref),
        source: sourceLink(sources.get(projectionEntityKey({ kind: "link", ref }))),
        override: overrides.get(key) ?? null,
        effective: effectiveRow ? effectiveLinkSnapshot(effectiveRow) : null,
      }
    })
  }

  exactPoint(series: TelemetrySeriesRef, at: string): StoredTelemetryPoint | null {
    return this.exactPoints([{ series, at }])[0] ?? null
  }

  exactPoints(
    points: readonly { readonly series: TelemetrySeriesRef; readonly at: string }[]
  ): readonly StoredTelemetryPoint[] {
    if (points.length === 0) return []
    const requested = canonicalJson(
      points.map(({ series, at }) => ({
        objectTypeId: series.object.objectTypeId,
        objectId: series.object.primaryId,
        propertyId: series.propertyId,
        at,
      }))
    )
    const rows = this.db
      .query(
        `WITH requested AS (
           SELECT DISTINCT json_extract(value, '$.objectTypeId') AS object_type_id,
             json_extract(value, '$.objectId') AS object_id,
             json_extract(value, '$.propertyId') AS property_id,
             json_extract(value, '$.at') AS at
           FROM json_each(?)
         )
         SELECT timeseries.* FROM requested
         CROSS JOIN timeseries
           ON timeseries.project_id = ?
          AND timeseries.object_type_id = requested.object_type_id
          AND timeseries.object_id = requested.object_id
          AND timeseries.property_id = requested.property_id
          AND timeseries.at = requested.at`
      )
      .all(requested, this.projectId) as TelemetryRow[]
    const found = new Map(
      rows.map((row) => {
        const point = storedPoint(row)
        return [telemetryPointSortKey(point.series, point.at), point] as const
      })
    )
    return points.flatMap((point) => {
      const stored = found.get(telemetryPointSortKey(point.series, point.at))
      return stored ? [stored] : []
    })
  }

  linkScopes(
    scopes: readonly { readonly source: OntologyObjectRef; readonly linkId: string }[]
  ): readonly MaterializationLinkScopeState[] {
    if (scopes.length === 0) return []
    const requested = scopes.map(({ source, linkId }) => ({
      scopeSortKey: linkScopeSortKey(source, linkId),
      sourceTypeId: source.objectTypeId,
      sourceId: source.primaryId,
      linkId,
    }))
    const accumulators = new Map(
      scopes.map(({ source, linkId }) => {
        const key = linkScopeSortKey(source, linkId)
        return [key, startScopeAccumulator(source, linkId, key)] as const
      })
    )
    const rows = this.db
      .query(
        `
          WITH requested AS (
            SELECT DISTINCT
              json_extract(value, '$.scopeSortKey') AS scope_sort_key,
              json_extract(value, '$.sourceTypeId') AS source_type_id,
              json_extract(value, '$.sourceId') AS source_id,
              json_extract(value, '$.linkId') AS link_id
            FROM json_each(?)
          )
          SELECT requested.scope_sort_key, links.*
          FROM requested
          CROSS JOIN links
            ON links.project_id = ?
           AND links.source_type_id = requested.source_type_id
           AND links.source_id = requested.source_id
           AND links.link_id = requested.link_id
          ORDER BY requested.scope_sort_key, ${linkSortExpression("links")}
        `
      )
      .iterate(canonicalJson(requested), this.projectId) as Iterable<LinkScopeRow>
    for (const row of rows) {
      const accumulator = accumulators.get(row.scope_sort_key)
      if (!accumulator) {
        throw new MaterializationConflictError(
          "effective-state",
          `Unexpected link scope '${row.scope_sort_key}' returned by storage.`
        )
      }
      appendScopeSnapshot(accumulator, effectiveLinkSnapshot(row))
    }
    return scopes.map(({ source, linkId }) =>
      finishScopeAccumulator(accumulators.get(linkScopeSortKey(source, linkId))!)
    )
  }

  linkScope(source: OntologyObjectRef, linkId: string): MaterializationLinkScopeState {
    const [scope] = this.linkScopes([{ source, linkId }])
    if (!scope) {
      throw new MaterializationConflictError(
        "effective-state",
        "Link scope lookup returned no row."
      )
    }
    return scope
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

  replacementObjectStates(
    sourceId: string,
    candidateMaterializationId: string,
    refs: readonly OntologyObjectRef[]
  ): readonly SourceReplacementObjectState[] {
    const base = this.objectStates(refs)
    const candidates = this.replacementSources(
      sourceId,
      [candidateMaterializationId],
      refs.map((ref) => ({ kind: "object" as const, ref }))
    )
    return base.map((state) => ({
      ref: state.ref,
      candidateSource: sourceObject(
        candidates.byMaterialization
          .get(candidateMaterializationId)
          ?.get(projectionEntityKey({ kind: "object", ref: state.ref }))
      ),
      override: state.override,
      effective: state.effective,
      latestTelemetry: state.latestTelemetry,
    }))
  }

  replacementLinkStates(
    sourceId: string,
    candidateMaterializationId: string,
    materializationIds: readonly string[],
    identities: readonly Extract<ReplacementIdentity, { readonly kind: "link" }>[]
  ): readonly SourceReplacementLinkState[] {
    const refs = identities.map((identity) => identity.ref)
    const base = this.linkStates(refs)
    const replacements = this.replacementSources(
      sourceId,
      materializationIds,
      refs.map((ref) => ({ kind: "link" as const, ref }))
    )
    const candidate = replacements.byMaterialization.get(candidateMaterializationId)
    return base.map((state, index) => {
      const key = projectionEntityKey({ kind: "link", ref: state.ref })
      return {
        ref: state.ref,
        candidateSource: replacements.owned.has(key)
          ? sourceLink(candidate?.get(key))
          : state.source,
        override: state.override,
        effective: state.effective,
        diffRequired: identities[index]!.diffRequired,
      }
    })
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

  private replacementSources(
    sourceId: string,
    materializationIds: readonly string[],
    refs: readonly ProjectionEntityRef[]
  ): ReplacementSources {
    if (materializationIds.length === 0 || refs.length === 0) {
      return { owned: new Set(), byMaterialization: new Map() }
    }
    const requestedEntities = canonicalJson(
      refs.map((ref) => ({ entityKind: ref.kind, entityKey: projectionEntityKey(ref) }))
    )
    const requestedMaterializations = canonicalJson([...new Set(materializationIds)])
    const rows = this.db
      .query(
        `WITH requested_entities AS (
           SELECT DISTINCT json_extract(value, '$.entityKind') AS entity_kind,
             json_extract(value, '$.entityKey') AS entity_key
           FROM json_each(?)
         ), requested_materializations AS (
           SELECT value AS materialization_id FROM json_each(?)
         )
         SELECT rows.* FROM requested_materializations
         CROSS JOIN requested_entities
         CROSS JOIN ontology_source_rows AS rows
           ON rows.project_id = ?
          AND rows.source_id = ?
          AND rows.materialization_id = requested_materializations.materialization_id
          AND rows.entity_kind = requested_entities.entity_kind
          AND rows.entity_key = requested_entities.entity_key`
      )
      .all(
        requestedEntities,
        requestedMaterializations,
        this.projectId,
        sourceId
      ) as SqliteOntologySourceAssertionRow[]
    const owned = new Set<string>()
    const byMaterialization = new Map<string, Map<string, StoredSourceAssertion>>()
    for (const row of rows) {
      const source = storedSource(row)
      const key = projectionEntityKey(source.assertion)
      owned.add(key)
      const materialization = byMaterialization.get(row.materialization_id) ?? new Map()
      materialization.set(key, source)
      byMaterialization.set(row.materialization_id, materialization)
    }
    return { owned, byMaterialization }
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

function activeSourceMap(
  rows: readonly SqliteOntologySourceAssertionRow[]
): ReadonlyMap<string, StoredSourceAssertion> {
  const result = new Map<string, StoredSourceAssertion>()
  for (const row of rows) {
    const source = storedSource(row)
    const key = projectionEntityKey(source.assertion)
    if (result.has(key)) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Multiple active sources assert ${key}.`
      )
    }
    result.set(key, source)
  }
  return result
}

function sourceObject(
  source: StoredSourceAssertion | undefined
): StoredSourceObjectAssertion | null {
  return source?.assertion.kind === "object" ? (source as StoredSourceObjectAssertion) : null
}

function sourceLink(source: StoredSourceAssertion | undefined): StoredSourceLinkAssertion | null {
  return source?.assertion.kind === "link" ? (source as StoredSourceLinkAssertion) : null
}

function storedObjectOverride(row: ObjectOverrideRow): StoredObjectOverride {
  const ref = objectRefFromColumns(row)
  return {
    ref,
    value: parseJson<StoredObjectOverride["value"]>(row.value),
    lastCommitId: row.last_commit_id,
    updatedAt: row.updated_at,
  }
}

function storedLinkOverride(row: LinkOverrideRow): StoredLinkOverride {
  const ref = linkRefFromOverrideColumns(row)
  return {
    ref,
    value: parseJson<StoredLinkOverride["value"]>(row.value),
    lastCommitId: row.last_commit_id,
    updatedAt: row.updated_at,
  }
}

function linkRefFromOverrideColumns(row: LinkOverrideRow): OntologyLinkRef {
  return {
    source: { objectTypeId: row.source_type_id, primaryId: row.source_primary_id },
    linkId: row.link_id,
    target: { objectTypeId: row.target_type_id, primaryId: row.target_primary_id },
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
