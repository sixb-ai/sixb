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
  telemetryPointKey,
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

interface LinkScopeRow extends EffectiveLinkRow {
  readonly scope_sort_key: string
  readonly link_sort_key: string
}

interface ObjectOverrideRow extends PgOntologyOverrideRow {
  readonly object_type_id: string
  readonly primary_id: string
}

interface LinkOverrideRow extends PgOntologyOverrideRow {
  readonly source_type_id: string
  readonly source_primary_id: string
  readonly link_id: string
  readonly target_type_id: string
  readonly target_primary_id: string
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

interface ReplacementSources {
  readonly owned: ReadonlySet<string>
  readonly byMaterialization: ReadonlyMap<string, ReadonlyMap<string, StoredSourceAssertion>>
}

interface ReplacementIdentityInput {
  readonly sessionId: string
  readonly sourceId: string
  readonly candidateMaterializationId: string
  readonly previousMaterializationId: string | null
  readonly kind: "object" | "link"
  readonly pageRows: number
}

interface ReplacementWorkRow {
  readonly entity_kind: "object" | "link"
  readonly identity_key: string
  readonly sort_key: string
  readonly diff_required: boolean
}

export class PgMaterializationStateReader {
  constructor(
    private readonly sql: SQLClient,
    readonly projectId: string
  ) {}

  async objectState(ref: OntologyObjectRef): Promise<MaterializationObjectState> {
    const [state] = await this.objectStates([ref])
    return state!
  }

  async objectStates(
    refs: readonly OntologyObjectRef[]
  ): Promise<readonly MaterializationObjectState[]> {
    if (refs.length === 0) return []
    const requested = refs.map((ref) => ({
      object_type_id: ref.objectTypeId,
      primary_id: ref.primaryId,
    }))
    const requestedParameter = jsonParameter(this.sql, requested)
    const [effectiveRows, sourceRows, overrideRows, telemetryRows] = await Promise.all([
      this.sql<EffectiveObjectRow[]>`
        WITH requested AS (
          SELECT DISTINCT * FROM jsonb_to_recordset(${requestedParameter})
            AS requested_values(object_type_id TEXT, primary_id TEXT)
        )
        SELECT objects.* FROM objects
        JOIN requested USING (object_type_id, primary_id)
        WHERE objects.project_id = ${this.projectId}
      `,
      this.sql<PgOntologySourceAssertionRow[]>`
        WITH requested AS (
          SELECT DISTINCT * FROM jsonb_to_recordset(${requestedParameter})
            AS requested_values(object_type_id TEXT, primary_id TEXT)
        )
        SELECT rows.*
        FROM ontology_source_rows AS rows
        JOIN requested USING (object_type_id, primary_id)
        JOIN ontology_sources AS sources
          ON sources.project_id = rows.project_id
         AND sources.source_id = rows.source_id
         AND sources.materialization_id = rows.materialization_id
        WHERE rows.project_id = ${this.projectId}
          AND rows.entity_kind = 'object'
          AND sources.status = 'active'
      `,
      this.sql<ObjectOverrideRow[]>`
        WITH requested AS (
          SELECT DISTINCT * FROM jsonb_to_recordset(${requestedParameter})
            AS requested_values(object_type_id TEXT, primary_id TEXT)
        )
        SELECT overrides.* FROM ontology_overrides AS overrides
        JOIN requested USING (object_type_id, primary_id)
        WHERE overrides.project_id = ${this.projectId}
          AND overrides.entity_kind = 'object'
      `,
      this.sql<TelemetryRow[]>`
        WITH requested AS (
          SELECT DISTINCT * FROM jsonb_to_recordset(${requestedParameter})
            AS requested_values(object_type_id TEXT, primary_id TEXT)
        )
        SELECT latest.*
          FROM timeseries_latest AS latest
          JOIN requested
            ON requested.object_type_id = latest.object_type_id
           AND requested.primary_id = latest.object_id
          WHERE latest.project_id = ${this.projectId}
      `,
    ])

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

  async linkState(ref: OntologyLinkRef): Promise<MaterializationLinkState> {
    const [state] = await this.linkStates([ref])
    return state!
  }

  async linkStates(refs: readonly OntologyLinkRef[]): Promise<readonly MaterializationLinkState[]> {
    if (refs.length === 0) return []
    const requested = refs.map((ref) => ({
      source_type_id: ref.source.objectTypeId,
      source_id: ref.source.primaryId,
      source_primary_id: ref.source.primaryId,
      link_id: ref.linkId,
      target_type_id: ref.target.objectTypeId,
      target_id: ref.target.primaryId,
      target_primary_id: ref.target.primaryId,
    }))
    const requestedParameter = jsonParameter(this.sql, requested)
    const [effectiveRows, sourceRows, overrideRows] = await Promise.all([
      this.sql<EffectiveLinkRow[]>`
        WITH requested AS (
          SELECT DISTINCT * FROM jsonb_to_recordset(${requestedParameter}) AS requested_values(
            source_type_id TEXT, source_id TEXT, link_id TEXT,
            target_type_id TEXT, target_id TEXT
          )
        )
        SELECT links.* FROM links
        JOIN requested USING (source_type_id, source_id, link_id, target_type_id, target_id)
        WHERE links.project_id = ${this.projectId}
      `,
      this.sql<PgOntologySourceAssertionRow[]>`
        WITH requested AS (
          SELECT DISTINCT * FROM jsonb_to_recordset(${requestedParameter}) AS requested_values(
            source_type_id TEXT, source_primary_id TEXT, link_id TEXT,
            target_type_id TEXT, target_primary_id TEXT
          )
        )
        SELECT rows.*
        FROM ontology_source_rows AS rows
        JOIN requested USING (
          source_type_id, source_primary_id, link_id, target_type_id, target_primary_id
        )
        JOIN ontology_sources AS sources
          ON sources.project_id = rows.project_id
         AND sources.source_id = rows.source_id
         AND sources.materialization_id = rows.materialization_id
        WHERE rows.project_id = ${this.projectId}
          AND rows.entity_kind = 'link'
          AND sources.status = 'active'
      `,
      this.sql<LinkOverrideRow[]>`
        WITH requested AS (
          SELECT DISTINCT * FROM jsonb_to_recordset(${requestedParameter}) AS requested_values(
            source_type_id TEXT, source_primary_id TEXT, link_id TEXT,
            target_type_id TEXT, target_primary_id TEXT
          )
        )
        SELECT overrides.* FROM ontology_overrides AS overrides
        JOIN requested USING (
          source_type_id, source_primary_id, link_id, target_type_id, target_primary_id
        )
        WHERE overrides.project_id = ${this.projectId}
          AND overrides.entity_kind = 'link'
      `,
    ])
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

  async exactPoint(
    series: TelemetrySeriesRef,
    at: string,
    lock = false
  ): Promise<StoredTelemetryPoint | null> {
    return (await this.exactPoints([{ series, at }], lock))[0] ?? null
  }

  async exactPoints(
    points: readonly { readonly series: TelemetrySeriesRef; readonly at: string }[],
    lock = false
  ): Promise<readonly StoredTelemetryPoint[]> {
    if (points.length === 0) return []
    const requested = points.map(({ series, at }) => ({
      object_type_id: series.object.objectTypeId,
      object_id: series.object.primaryId,
      property_id: series.propertyId,
      at,
    }))
    const lockFragment = lock ? this.sql`FOR UPDATE OF timeseries` : this.sql``
    const rows = await this.sql<TelemetryRow[]>`
      WITH requested AS (
        SELECT DISTINCT * FROM jsonb_to_recordset(${jsonParameter(this.sql, requested)}) AS requested_values(
          object_type_id TEXT, object_id TEXT, property_id TEXT, at TIMESTAMPTZ
        )
      )
      SELECT timeseries.* FROM timeseries
      JOIN requested USING (object_type_id, object_id, property_id, at)
      WHERE timeseries.project_id = ${this.projectId}
      ${lockFragment}
    `
    const found = new Map(
      rows.map((row) => {
        const point = storedPoint(row)
        return [telemetryPointKey(point.series, point.at), point] as const
      })
    )
    return points.flatMap((point) => {
      const stored = found.get(telemetryPointKey(point.series, point.at))
      return stored ? [stored] : []
    })
  }

  async linkScopes(
    scopes: readonly { readonly source: OntologyObjectRef; readonly linkId: string }[]
  ): Promise<readonly MaterializationLinkScopeState[]> {
    if (scopes.length === 0) return []
    const requested = scopes.map(({ source, linkId }) => ({
      scope_sort_key: linkScopeSortKey(source, linkId),
      source_type_id: source.objectTypeId,
      source_id: source.primaryId,
      link_id: linkId,
    }))
    const accumulators = new Map(
      scopes.map(({ source, linkId }) => {
        const key = linkScopeSortKey(source, linkId)
        return [key, startScopeAccumulator(source, linkId, key)] as const
      })
    )
    let scopeCursor: string | null = null
    let linkCursor: string | null = null
    while (true) {
      const rows: LinkScopeRow[] = await this.sql`
        WITH requested AS (
          SELECT DISTINCT * FROM jsonb_to_recordset(${jsonParameter(this.sql, requested)})
            AS requested_values(
              scope_sort_key TEXT, source_type_id TEXT, source_id TEXT, link_id TEXT
            )
        ), selected AS (
          SELECT requested.scope_sort_key, links.*,
            ${this.sql.unsafe(linkSortExpression("links"))} AS link_sort_key
          FROM links
          JOIN requested USING (source_type_id, source_id, link_id)
          WHERE links.project_id = ${this.projectId}
        )
        SELECT * FROM selected
        WHERE (${scopeCursor}::text IS NULL OR (scope_sort_key, link_sort_key) >
          (${scopeCursor}, ${linkCursor}))
        ORDER BY scope_sort_key, link_sort_key
        LIMIT 500
      `
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
      if (rows.length < 500) break
      const last: LinkScopeRow = rows[rows.length - 1]!
      scopeCursor = last.scope_sort_key
      linkCursor = last.link_sort_key
    }
    return scopes.map(({ source, linkId }) =>
      finishScopeAccumulator(accumulators.get(linkScopeSortKey(source, linkId))!)
    )
  }

  async linkScope(
    source: OntologyObjectRef,
    linkId: string
  ): Promise<MaterializationLinkScopeState> {
    const [scope] = await this.linkScopes([{ source, linkId }])
    if (!scope) {
      throw new MaterializationConflictError(
        "effective-state",
        "Link scope lookup returned no row."
      )
    }
    return scope
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
          SELECT DISTINCT *
          FROM jsonb_to_recordset(${jsonParameter(this.sql, requested)})
            AS requested_values(object_type_id TEXT, primary_id TEXT)
        ), authority_links AS (
          SELECT links.source_type_id, links.source_id, links.link_id,
            links.target_type_id, links.target_id
          FROM links
          JOIN requested
            ON requested.object_type_id = links.source_type_id
           AND requested.primary_id = links.source_id
          WHERE links.project_id = ${this.projectId}
          UNION
          SELECT links.source_type_id, links.source_id, links.link_id,
            links.target_type_id, links.target_id
          FROM links
          JOIN requested
            ON requested.object_type_id = links.target_type_id
           AND requested.primary_id = links.target_id
          WHERE links.project_id = ${this.projectId}
          UNION
          SELECT overrides.source_type_id, overrides.source_primary_id AS source_id,
            overrides.link_id, overrides.target_type_id,
            overrides.target_primary_id AS target_id
          FROM ontology_overrides AS overrides
          JOIN requested
            ON requested.object_type_id = overrides.source_type_id
           AND requested.primary_id = overrides.source_primary_id
          WHERE overrides.project_id = ${this.projectId} AND overrides.entity_kind = 'link'
          UNION
          SELECT overrides.source_type_id, overrides.source_primary_id AS source_id,
            overrides.link_id, overrides.target_type_id,
            overrides.target_primary_id AS target_id
          FROM ontology_overrides AS overrides
          JOIN requested
            ON requested.object_type_id = overrides.target_type_id
           AND requested.primary_id = overrides.target_primary_id
          WHERE overrides.project_id = ${this.projectId} AND overrides.entity_kind = 'link'
          UNION
          SELECT rows.source_type_id, rows.source_primary_id AS source_id,
            rows.link_id, rows.target_type_id, rows.target_primary_id AS target_id
          FROM ontology_source_rows AS rows
          JOIN ontology_sources AS sources
            ON sources.project_id = rows.project_id
           AND sources.source_id = rows.source_id
           AND sources.materialization_id = rows.materialization_id
          JOIN requested
            ON requested.object_type_id = rows.source_type_id
           AND requested.primary_id = rows.source_primary_id
          WHERE rows.project_id = ${this.projectId}
            AND rows.entity_kind = 'link'
            AND sources.status = 'active'
          UNION
          SELECT rows.source_type_id, rows.source_primary_id AS source_id,
            rows.link_id, rows.target_type_id, rows.target_primary_id AS target_id
          FROM ontology_source_rows AS rows
          JOIN ontology_sources AS sources
            ON sources.project_id = rows.project_id
           AND sources.source_id = rows.source_id
           AND sources.materialization_id = rows.materialization_id
          JOIN requested
            ON requested.object_type_id = rows.target_type_id
           AND requested.primary_id = rows.target_primary_id
          WHERE rows.project_id = ${this.projectId}
            AND rows.entity_kind = 'link'
            AND sources.status = 'active'
        ), selected AS (
          SELECT DISTINCT links.*,
            ${this.sql.unsafe(linkSortExpression("links"))} AS sort_key
          FROM authority_links AS links
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
    await this.prepareReplacementIdentities(input)
    let cursor: string | null = null
    while (true) {
      const rows: ReplacementWorkRow[] = await this.sql<ReplacementWorkRow[]>`
        SELECT entity_kind, identity_key, sort_key, diff_required
        FROM ${this.sql(PG_REPLACEMENT_WORK_TABLE)}
        WHERE session_id = ${input.sessionId} AND entity_kind = ${input.kind}
          AND (${cursor}::text IS NULL OR sort_key > ${cursor})
        ORDER BY sort_key
        LIMIT ${input.pageRows}
      `
      if (rows.length === 0) break
      yield rows.map(replacementIdentity)
      cursor = rows[rows.length - 1]?.sort_key ?? null
    }
  }

  async replacementObjectStates(
    sourceId: string,
    candidateMaterializationId: string,
    refs: readonly OntologyObjectRef[]
  ): Promise<readonly SourceReplacementObjectState[]> {
    const base = await this.objectStates(refs)
    const candidates = await this.replacementSources(
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

  async replacementLinkStates(
    sourceId: string,
    candidateMaterializationId: string,
    materializationIds: readonly string[],
    identities: readonly Extract<ReplacementIdentity, { readonly kind: "link" }>[]
  ): Promise<readonly SourceReplacementLinkState[]> {
    const refs = identities.map((identity) => identity.ref)
    const base = await this.linkStates(refs)
    const replacements = await this.replacementSources(
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

  async effectiveObjectRevision(
    ref: OntologyObjectRef,
    lock = false
  ): Promise<{ readonly version: number; readonly lastCommitId: string | null } | null> {
    return (await this.effectiveObjectRevisions([ref], lock)).get(objectRefKey(ref)) ?? null
  }

  async effectiveObjectRevisions(
    refs: readonly OntologyObjectRef[],
    lock = false
  ): Promise<
    ReadonlyMap<string, { readonly version: number; readonly lastCommitId: string | null }>
  > {
    if (refs.length === 0) return new Map()
    const requested = refs.map((ref) => ({
      object_type_id: ref.objectTypeId,
      primary_id: ref.primaryId,
    }))
    const lockFragment = lock ? this.sql`FOR UPDATE OF objects` : this.sql``
    const rows = await this.sql<
      {
        readonly object_type_id: string
        readonly primary_id: string
        readonly version: number
        readonly last_commit_id: string | null
      }[]
    >`
      WITH requested AS (
        SELECT DISTINCT * FROM jsonb_to_recordset(${jsonParameter(this.sql, requested)})
          AS requested_values(object_type_id TEXT, primary_id TEXT)
      )
      SELECT objects.object_type_id, objects.primary_id, objects.version,
        objects.last_commit_id
      FROM objects JOIN requested USING (object_type_id, primary_id)
      WHERE objects.project_id = ${this.projectId}
      ${lockFragment}
    `
    return new Map(
      rows.map(
        (row) =>
          [
            objectRefKey(objectRefFromColumns(row)),
            { version: row.version, lastCommitId: row.last_commit_id },
          ] as const
      )
    )
  }

  async effectiveLinkLastCommit(
    ref: OntologyLinkRef,
    lock = false
  ): Promise<string | null | undefined> {
    return (await this.effectiveLinkLastCommits([ref], lock)).get(linkRefKey(ref))
  }

  async effectiveLinkLastCommits(
    refs: readonly OntologyLinkRef[],
    lock = false
  ): Promise<ReadonlyMap<string, string | null>> {
    if (refs.length === 0) return new Map()
    const requested = refs.map((ref) => ({
      source_type_id: ref.source.objectTypeId,
      source_id: ref.source.primaryId,
      link_id: ref.linkId,
      target_type_id: ref.target.objectTypeId,
      target_id: ref.target.primaryId,
    }))
    const lockFragment = lock ? this.sql`FOR UPDATE OF links` : this.sql``
    const rows = await this.sql<EffectiveLinkRow[]>`
      WITH requested AS (
        SELECT DISTINCT * FROM jsonb_to_recordset(${jsonParameter(this.sql, requested)})
          AS requested_values(
            source_type_id TEXT, source_id TEXT, link_id TEXT,
            target_type_id TEXT, target_id TEXT
          )
      )
      SELECT links.* FROM links
      JOIN requested USING (source_type_id, source_id, link_id, target_type_id, target_id)
      WHERE links.project_id = ${this.projectId}
      ${lockFragment}
    `
    return new Map(
      rows.map((row) => [linkRefKey(linkRefFromColumns(row)), row.last_commit_id] as const)
    )
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

  private async replacementSources(
    sourceId: string,
    materializationIds: readonly string[],
    refs: readonly ProjectionEntityRef[]
  ): Promise<ReplacementSources> {
    if (materializationIds.length === 0 || refs.length === 0) {
      return { owned: new Set(), byMaterialization: new Map() }
    }
    const keys = refs.map((ref) => ({
      entity_kind: ref.kind,
      entity_key: JSON.parse(projectionEntityKey(ref)) as unknown,
    }))
    const rows = await this.sql<PgOntologySourceAssertionRow[]>`
      WITH requested AS (
        SELECT *
        FROM jsonb_to_recordset(${jsonParameter(this.sql, keys)})
          AS requested_values(entity_kind TEXT, entity_key JSONB)
      )
      SELECT rows.* FROM ontology_source_rows AS rows
      JOIN requested USING (entity_kind, entity_key)
      WHERE rows.project_id = ${this.projectId}
        AND rows.source_id = ${sourceId}
        AND rows.materialization_id = ANY(
          ${this.sql.array([...new Set(materializationIds)])}::text[]
        )
    `
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

  private async prepareReplacementIdentities(input: ReplacementIdentityInput): Promise<void> {
    if (input.kind === "object") {
      await this.prepareReplacementObjects(input)
      return
    }
    await this.prepareReplacementLinks(input)
  }

  private async prepareReplacementObjects(input: ReplacementIdentityInput): Promise<void> {
    const materializationIds = [
      input.candidateMaterializationId,
      ...(input.previousMaterializationId ? [input.previousMaterializationId] : []),
    ]
    await this.sql`
      WITH selected AS (
        SELECT DISTINCT object_type_id, primary_id,
          ${this.sql.unsafe(objectKeyExpression("rows"))} AS identity_key,
          ${this.sql.unsafe(objectSortExpression("rows"))} AS sort_key
        FROM ontology_source_rows AS rows
        WHERE project_id = ${this.projectId}
          AND source_id = ${input.sourceId}
          AND entity_kind = 'object'
          AND materialization_id = ANY(${this.sql.array(materializationIds)}::text[])
      )
      INSERT INTO ${this.sql(PG_REPLACEMENT_WORK_TABLE)} (
        session_id, entity_kind, identity_key, sort_key, diff_required
      )
      SELECT ${input.sessionId}, 'object', identity_key, sort_key, TRUE
      FROM selected
      ON CONFLICT (session_id, entity_kind, identity_key) DO UPDATE SET
        diff_required = ${this.sql(PG_REPLACEMENT_WORK_TABLE)}.diff_required
          OR EXCLUDED.diff_required
    `
  }

  private async prepareReplacementLinks(input: ReplacementIdentityInput): Promise<void> {
    const materializationIds = [
      input.candidateMaterializationId,
      ...(input.previousMaterializationId ? [input.previousMaterializationId] : []),
    ]
    await this.sql`
      WITH incident_objects AS (
        SELECT DISTINCT payload->'ref'->>'objectTypeId' AS object_type_id,
          payload->'ref'->>'primaryId' AS primary_id
        FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
        WHERE session_id = ${input.sessionId} AND kind = 'incident-object'
      ), replacement_links AS (
        SELECT source_type_id, source_primary_id AS source_id, link_id,
          target_type_id, target_primary_id AS target_id
        FROM ontology_source_rows
        WHERE project_id = ${this.projectId}
          AND source_id = ${input.sourceId}
          AND entity_kind = 'link'
          AND materialization_id = ANY(${this.sql.array(materializationIds)}::text[])
      ), incident_links AS (
        SELECT links.source_type_id, links.source_id, links.link_id,
          links.target_type_id, links.target_id
        FROM links
        JOIN incident_objects
          ON incident_objects.object_type_id = links.source_type_id
         AND incident_objects.primary_id = links.source_id
        WHERE links.project_id = ${this.projectId}
        UNION
        SELECT links.source_type_id, links.source_id, links.link_id,
          links.target_type_id, links.target_id
        FROM links
        JOIN incident_objects
          ON incident_objects.object_type_id = links.target_type_id
         AND incident_objects.primary_id = links.target_id
        WHERE links.project_id = ${this.projectId}
        UNION
        SELECT overrides.source_type_id, overrides.source_primary_id AS source_id,
          overrides.link_id, overrides.target_type_id,
          overrides.target_primary_id AS target_id
        FROM ontology_overrides AS overrides
        JOIN incident_objects
          ON incident_objects.object_type_id = overrides.source_type_id
         AND incident_objects.primary_id = overrides.source_primary_id
        WHERE overrides.project_id = ${this.projectId} AND overrides.entity_kind = 'link'
        UNION
        SELECT overrides.source_type_id, overrides.source_primary_id AS source_id,
          overrides.link_id, overrides.target_type_id,
          overrides.target_primary_id AS target_id
        FROM ontology_overrides AS overrides
        JOIN incident_objects
          ON incident_objects.object_type_id = overrides.target_type_id
         AND incident_objects.primary_id = overrides.target_primary_id
        WHERE overrides.project_id = ${this.projectId} AND overrides.entity_kind = 'link'
        UNION
        SELECT rows.source_type_id, rows.source_primary_id AS source_id,
          rows.link_id, rows.target_type_id, rows.target_primary_id AS target_id
        FROM ontology_source_rows AS rows
        JOIN ontology_sources AS sources
          ON sources.project_id = rows.project_id
         AND sources.source_id = rows.source_id
         AND sources.materialization_id = rows.materialization_id
        JOIN incident_objects
          ON incident_objects.object_type_id = rows.source_type_id
         AND incident_objects.primary_id = rows.source_primary_id
        WHERE rows.project_id = ${this.projectId}
          AND rows.entity_kind = 'link'
          AND sources.status = 'active'
        UNION
        SELECT rows.source_type_id, rows.source_primary_id AS source_id,
          rows.link_id, rows.target_type_id, rows.target_primary_id AS target_id
        FROM ontology_source_rows AS rows
        JOIN ontology_sources AS sources
          ON sources.project_id = rows.project_id
         AND sources.source_id = rows.source_id
         AND sources.materialization_id = rows.materialization_id
        JOIN incident_objects
          ON incident_objects.object_type_id = rows.target_type_id
         AND incident_objects.primary_id = rows.target_primary_id
        WHERE rows.project_id = ${this.projectId}
          AND rows.entity_kind = 'link'
          AND sources.status = 'active'
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
          ${this.sql.unsafe(linkKeyExpression("all_links"))} AS identity_key,
          ${this.sql.unsafe(linkSortExpression("all_links"))} AS sort_key,
          BOOL_OR(diff_required) AS diff_required
        FROM all_links
        GROUP BY source_type_id, source_id, link_id, target_type_id, target_id
      )
      INSERT INTO ${this.sql(PG_REPLACEMENT_WORK_TABLE)} (
        session_id, entity_kind, identity_key, sort_key, diff_required
      )
      SELECT ${input.sessionId}, 'link', identity_key, sort_key, diff_required
      FROM selected
      ON CONFLICT (session_id, entity_kind, identity_key) DO UPDATE SET
        diff_required = ${this.sql(PG_REPLACEMENT_WORK_TABLE)}.diff_required
          OR EXCLUDED.diff_required
    `
  }
}

function replacementIdentity(row: ReplacementWorkRow): ReplacementIdentity {
  const parts = JSON.parse(row.identity_key) as string[]
  if (row.entity_kind === "object") {
    return {
      kind: "object",
      ref: { objectTypeId: parts[0]!, primaryId: parts[1]! },
      sortKey: row.sort_key,
      diffRequired: true,
    }
  }
  return {
    kind: "link",
    ref: {
      source: { objectTypeId: parts[0]!, primaryId: parts[1]! },
      linkId: parts[2]!,
      target: { objectTypeId: parts[3]!, primaryId: parts[4]! },
    },
    sortKey: row.sort_key,
    diffRequired: row.diff_required,
  }
}

function activeSourceMap(
  rows: readonly PgOntologySourceAssertionRow[]
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
    value: structuredClone(row.value) as StoredObjectOverride["value"],
    lastCommitId: row.last_commit_id,
    updatedAt: toIsoString(row.updated_at),
  }
}

function storedLinkOverride(row: LinkOverrideRow): StoredLinkOverride {
  const ref = linkRefFromOverrideColumns(row)
  return {
    ref,
    value: structuredClone(row.value) as StoredLinkOverride["value"],
    lastCommitId: row.last_commit_id,
    updatedAt: toIsoString(row.updated_at),
  }
}

function linkRefFromOverrideColumns(row: LinkOverrideRow): OntologyLinkRef {
  return {
    source: { objectTypeId: row.source_type_id, primaryId: row.source_primary_id },
    linkId: row.link_id,
    target: { objectTypeId: row.target_type_id, primaryId: row.target_primary_id },
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
  return utf8SortExpression([
    `to_jsonb(${prefix}object_type_id)::text`,
    `to_jsonb(${prefix}primary_id)::text`,
  ])
}

function objectKeyExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return jsonTupleExpression([
    `to_jsonb(${prefix}object_type_id)::text`,
    `to_jsonb(${prefix}primary_id)::text`,
  ])
}

export function linkSortExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return utf8SortExpression([
    `to_jsonb(${prefix}source_type_id)::text`,
    `to_jsonb(${prefix}source_id)::text`,
    `to_jsonb(${prefix}link_id)::text`,
    `to_jsonb(${prefix}target_type_id)::text`,
    `to_jsonb(${prefix}target_id)::text`,
  ])
}

function linkKeyExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return jsonTupleExpression([
    `to_jsonb(${prefix}source_type_id)::text`,
    `to_jsonb(${prefix}source_id)::text`,
    `to_jsonb(${prefix}link_id)::text`,
    `to_jsonb(${prefix}target_type_id)::text`,
    `to_jsonb(${prefix}target_id)::text`,
  ])
}

export function pointSortExpression(alias?: string): string {
  const prefix = alias ? `${alias}.` : ""
  return utf8SortExpression([
    `to_jsonb(${prefix}object_type_id)::text`,
    `to_jsonb(${prefix}object_id)::text`,
    `to_jsonb(${prefix}property_id)::text`,
    `to_jsonb(to_char(${prefix}at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text`,
  ])
}

function utf8SortExpression(parts: readonly string[]): string {
  return `encode(convert_to(${jsonTupleExpression(parts)}, 'UTF8'), 'hex')`
}

function jsonTupleExpression(parts: readonly string[]): string {
  return `concat('[', ${parts.join(", ',', ")}, ']')`
}
