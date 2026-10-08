import { MaterializationValidationError } from "@sixb/core/internal/materialization"
import {
  assertSourceBeginInput as assertBeginInput,
  assertSourceExecutionIdentity as assertExecutionIdentity,
  assertSourceProject as assertProjectAndSource,
  assertSourceCandidateOwner,
  assertSourceWriteIdentity as assertWriteIdentity,
  sourceEntityColumns as entityColumns,
  isExactStagingManifest,
  reconcileSourceStageRows,
  type SourceStageRow,
  sourceAssertionPayload,
  sourceConflict,
  sourceMaterializationIdentity,
  sourceStageRow,
  sourceStageRows,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  AbandonRunSourceMaterializationInput,
  AbandonSourceMaterializationCandidateInput,
  AbandonSourceMaterializationInput,
  AdoptedSourceMaterialization,
  AdoptSourceMaterializationInput,
  AssertSourceMaterializationExecutionInput,
  BeginSourceMaterializationInput,
  CleanupTerminalSourceMaterializationsInput,
  CleanupTerminalSourceMaterializationsResult,
  GetActiveOntologySourceInput,
  MarkSourceMaterializationReadyInput,
  OntologySourceRecord,
  OntologySourceStorage,
  PurgeAbandonedSourceMaterializationsInput,
  StageSourceRowsInput,
  StageSourceRowsResult,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { lockAdvisoryKeys } from "../transactions"
import {
  assertNonblank,
  assertNonnegativeInteger,
  assertPositiveInteger,
  assertProjectionExecution,
  assertTimestamp,
  jsonParameter,
  ontologyLockKey,
  type PgOntologySourceAssertionRow,
  type PgOntologySourceRow,
  type PgRootOperation,
  sourceAssertion,
  sourceRecord,
  toIsoString,
} from "./shared"
import { cleanupSourceVersions, purgeAbandonedSourceVersions } from "./source-cleanup"
import { assertSourceRootCoverage, sourceAssertionColumns, stageSourceRoots } from "./source-roots"

export class PgOntologySourceStorage implements OntologySourceStorage {
  constructor(private readonly runRootOperation: PgRootOperation) {}

  async beginMaterialization(
    input: BeginSourceMaterializationInput
  ): Promise<OntologySourceRecord> {
    return this.runRootOperation(async (sql) => {
      assertBeginInput(input)
      await this.assertExecution(sql, input, sourceMaterializationIdentity(input))
      await lockAdvisoryKeys(sql, [
        ontologyLockKey("source-candidate", input.projectId, input.execution.projectionRunId),
        ontologyLockKey(
          "source-materialization",
          input.projectId,
          input.source.projectionId,
          input.materializationId
        ),
      ])

      const existing = await this.getManifest(
        sql,
        input.projectId,
        input.source.projectionId,
        input.materializationId,
        true
      )
      if (existing) {
        if (isExactStagingManifest(sourceRecord(existing), input)) return sourceRecord(existing)
        throw sourceConflict(
          `Source materialization '${input.materializationId}' already exists with different identity or state.`
        )
      }

      const candidate = await this.getRunCandidate(sql, input)
      if (candidate) {
        throw sourceConflict(
          `Projection run '${input.execution.projectionRunId}' already has a nonterminal source materialization; adopt it before beginning another.`
        )
      }

      const rows = await sql<PgOntologySourceRow[]>`
        INSERT INTO ontology_sources (
          project_id, source_id, materialization_id, projection_run_id,
          projection_kind, protocol, status, execution_token,
          dataset_id, dataset_version_id, dataset_version_created_at,
          projection_revision, ownership_hash, ontology_revision,
          root_count, assertion_count, created_at, ready_at, activated_at,
          terminal_at, last_commit_id, updated_at, base_materialization_id, base_commit_id
        ) VALUES (
          ${input.projectId}, ${input.source.projectionId}, ${input.materializationId},
          ${input.execution.projectionRunId}, ${input.projectionKind}, 'replacement',
          'staging', ${input.execution.executionToken}, ${input.datasetVersion.datasetId},
          ${input.datasetVersion.versionId}, ${input.datasetVersion.createdAt},
          ${input.projectionRevision}, ${input.ownershipHash}, ${input.ontologyRevision},
          NULL, NULL, ${input.createdAt}, NULL, NULL, NULL, NULL, ${input.createdAt},
          ${input.base?.materializationId ?? null}, ${input.base?.lastCommitId ?? null}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `
      if (rows[0]) return sourceRecord(rows[0])

      const racedManifest = await this.getManifest(
        sql,
        input.projectId,
        input.source.projectionId,
        input.materializationId,
        true
      )
      if (racedManifest && isExactStagingManifest(sourceRecord(racedManifest), input)) {
        return sourceRecord(racedManifest)
      }
      if (await this.getRunCandidate(sql, input)) {
        throw sourceConflict(
          `Projection run '${input.execution.projectionRunId}' already has a nonterminal source materialization; adopt it before beginning another.`
        )
      }
      throw sourceConflict(
        `Source materialization '${input.materializationId}' already exists with different identity or state.`
      )
    })
  }

  async stageRows(input: StageSourceRowsInput): Promise<StageSourceRowsResult> {
    return this.runRootOperation(async (sql) => {
      assertWriteIdentity(input)
      await this.assertExecution(sql, input)
      const manifest = await this.requireManifest(
        sql,
        input.projectId,
        input.source.projectionId,
        input.materializationId,
        true
      )
      assertSourceCandidateOwner(sourceRecord(manifest), input.execution)
      if (manifest.status !== "staging") {
        throw sourceConflict(
          `Source materialization '${input.materializationId}' is '${manifest.status}' and cannot accept rows.`
        )
      }

      const rows = sourceStageRows(manifest.projection_kind, input.rows)
      const existing = await this.findStageRows(sql, manifest, rows)
      const { pending, unchanged } = reconcileSourceStageRows(rows, existing)
      await stageSourceRoots(sql, manifest, input)
      await this.insertStageRows(sql, manifest, pending)
      return { inserted: pending.length, unchanged }
    })
  }

  async markReady(input: MarkSourceMaterializationReadyInput): Promise<OntologySourceRecord> {
    return this.runRootOperation(async (sql) => {
      assertWriteIdentity(input)
      assertTimestamp(input.readyAt, "Source readyAt", true)
      assertNonnegativeInteger(input.rootCount, "Source root count")
      assertNonnegativeInteger(input.assertionCount, "Source assertion count")
      await this.assertExecution(sql, input)
      const manifest = await this.requireManifest(
        sql,
        input.projectId,
        input.source.projectionId,
        input.materializationId,
        true
      )
      assertSourceCandidateOwner(sourceRecord(manifest), input.execution)
      if (manifest.status === "ready") {
        if (
          numberOrNull(manifest.root_count) === input.rootCount &&
          numberOrNull(manifest.assertion_count) === input.assertionCount &&
          toIsoString(manifest.ready_at!) === input.readyAt
        ) {
          return sourceRecord(manifest)
        }
        throw sourceConflict(
          `Source materialization '${input.materializationId}' was marked ready with different counts or time.`
        )
      }
      if (manifest.status !== "staging") {
        throw sourceConflict(
          `Source materialization '${input.materializationId}' cannot transition from '${manifest.status}' to 'ready'.`
        )
      }
      if (input.readyAt < toIsoString(manifest.created_at)) {
        throw new MaterializationValidationError("Source readyAt cannot precede source createdAt.")
      }
      // A newly loaded run is absent from the planner statistics. Without refreshing them,
      // PostgreSQL can scan the whole run for each identity instead of using its full key.
      // Sparse deltas avoid this table-level sampling cost.
      if (input.assertionCount >= 1_000 || input.rootCount >= 1_000) {
        await sql`ANALYZE ontology_source_rows, ontology_source_roots`
      }
      await this.assertReadyState(sql, manifest, input.rootCount, input.assertionCount)
      const rows = await sql<PgOntologySourceRow[]>`
        UPDATE ontology_sources
        SET status = 'ready', root_count = ${input.rootCount},
          assertion_count = ${input.assertionCount}, ready_at = ${input.readyAt},
          updated_at = ${input.readyAt}
        WHERE project_id = ${input.projectId}
          AND source_id = ${input.source.projectionId}
          AND materialization_id = ${input.materializationId}
          AND status = 'staging'
          AND execution_token = ${input.execution.executionToken}
        RETURNING *
      `
      if (!rows[0]) {
        throw sourceConflict(`Source materialization '${input.materializationId}' changed.`)
      }
      return sourceRecord(rows[0])
    })
  }

  async getActive(input: GetActiveOntologySourceInput): Promise<OntologySourceRecord | null> {
    return this.runRootOperation(async (sql) => {
      assertProjectAndSource(input)
      const [row] = await sql<PgOntologySourceRow[]>`
        SELECT * FROM ontology_sources
        WHERE project_id = ${input.projectId}
          AND source_id = ${input.source.projectionId}
          AND status = 'active'
      `
      return row ? sourceRecord(row) : null
    })
  }

  async adopt(
    input: AdoptSourceMaterializationInput
  ): Promise<AdoptedSourceMaterialization | null> {
    return this.runRootOperation(async (sql) => {
      assertProjectAndSource(input)
      assertExecutionIdentity(input.execution.projectionRunId, input.execution.executionToken)
      assertTimestamp(input.adoptedAt, "Source adoptedAt", true)
      await this.assertExecution(sql, input)
      const candidate = await this.lockRunCandidate(sql, input)
      if (!candidate) return null
      // Workers' clocks differ; adoption never moves the record back in time.
      const [adopted] = await sql<PgOntologySourceRow[]>`
        UPDATE ontology_sources
        SET execution_token = ${input.execution.executionToken},
          updated_at = GREATEST(updated_at, ${input.adoptedAt}::timestamptz)
        WHERE project_id = ${candidate.project_id} AND source_id = ${candidate.source_id}
          AND materialization_id = ${candidate.materialization_id}
          AND status IN ('staging', 'ready')
        RETURNING *
      `
      if (!adopted) {
        throw sourceConflict(`Source materialization '${candidate.materialization_id}' changed.`)
      }
      return {
        record: sourceRecord(adopted),
        resumeStagingOrdinal:
          adopted.status === "ready"
            ? Number(adopted.root_count)
            : await this.lastStagedOrdinal(sql, adopted),
      }
    })
  }

  async abandon(input: AbandonSourceMaterializationCandidateInput): Promise<OntologySourceRecord>
  async abandon(input: AbandonRunSourceMaterializationInput): Promise<OntologySourceRecord | null>
  async abandon(input: AbandonSourceMaterializationInput): Promise<OntologySourceRecord | null> {
    return this.runRootOperation(async (sql) => {
      assertProjectAndSource(input)
      assertExecutionIdentity(input.execution.projectionRunId, input.execution.executionToken)
      assertTimestamp(input.abandonedAt, "Source abandonedAt", true)
      await this.assertExecution(sql, input)
      if (input.kind === "candidate") return this.abandonCandidate(sql, input)
      const candidate = await this.lockRunCandidate(sql, input)
      return candidate ? this.transitionToAbandoned(sql, candidate, input.abandonedAt) : null
    })
  }

  async cleanupTerminal(
    input: CleanupTerminalSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult> {
    return this.runRootOperation(async (sql) => {
      assertNonblank(input.projectId, "Terminal source cleanup project id")
      assertTimestamp(input.terminalBefore, "Terminal source cleanup cutoff", true)
      assertPositiveInteger(input.limit, "Terminal source cleanup limit")
      return cleanupSourceVersions(sql, input)
    })
  }

  async purgeAbandoned(
    input: PurgeAbandonedSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult> {
    return this.runRootOperation(async (sql) => {
      assertNonblank(input.projectId, "Abandoned source purge project id")
      assertPositiveInteger(input.limit, "Abandoned source purge limit")
      return purgeAbandonedSourceVersions(sql, input)
    })
  }

  private async abandonCandidate(
    sql: SQLClient,
    input: AbandonSourceMaterializationCandidateInput
  ): Promise<OntologySourceRecord> {
    const manifest = await this.requireManifest(
      sql,
      input.projectId,
      input.source.projectionId,
      input.materializationId,
      true
    )
    if (manifest.status === "abandoned") {
      if (
        manifest.projection_run_id === input.execution.projectionRunId &&
        manifest.terminal_at !== null &&
        toIsoString(manifest.terminal_at) === input.abandonedAt
      ) {
        return sourceRecord(manifest)
      }
      throw sourceConflict(
        `Source materialization '${input.materializationId}' was abandoned by another execution or at another time.`
      )
    }
    assertSourceCandidateOwner(sourceRecord(manifest), input.execution)
    return this.transitionToAbandoned(sql, manifest, input.abandonedAt)
  }

  /** The run's one staging or ready candidate, locked, whichever execution staged it. */
  private async lockRunCandidate(
    sql: SQLClient,
    input: {
      readonly projectId: string
      readonly source: { readonly projectionId: string }
      readonly execution: { readonly projectionRunId: string }
    }
  ): Promise<PgOntologySourceRow | null> {
    const candidates = await sql<PgOntologySourceRow[]>`
      SELECT * FROM ontology_sources
      WHERE project_id = ${input.projectId}
        AND source_id = ${input.source.projectionId}
        AND projection_run_id = ${input.execution.projectionRunId}
        AND status IN ('staging', 'ready')
      FOR UPDATE
    `
    if (candidates.length > 1) {
      throw sourceConflict(
        `Projection run '${input.execution.projectionRunId}' has multiple nonterminal source materializations.`
      )
    }
    return candidates[0] ?? null
  }

  private async lastStagedOrdinal(sql: SQLClient, manifest: PgOntologySourceRow): Promise<number> {
    const [last] = await sql<{ readonly ordinal: number | string | null }[]>`
      SELECT MAX(staging_ordinal) AS ordinal FROM ontology_source_roots
      WHERE version_id = ${manifest.version_id}
    `
    return last?.ordinal == null ? 0 : Number(last.ordinal)
  }

  private async transitionToAbandoned(
    sql: SQLClient,
    manifest: PgOntologySourceRow,
    abandonedAt: string
  ): Promise<OntologySourceRecord> {
    if (
      abandonedAt < toIsoString(manifest.created_at) ||
      (manifest.ready_at !== null && abandonedAt < toIsoString(manifest.ready_at))
    ) {
      throw new MaterializationValidationError(
        "Source abandonedAt cannot precede source creation or readiness."
      )
    }
    const rows = await sql<PgOntologySourceRow[]>`
      UPDATE ontology_sources
      SET status = 'abandoned', execution_token = NULL,
        terminal_at = ${abandonedAt}, updated_at = ${abandonedAt}
      WHERE project_id = ${manifest.project_id}
        AND source_id = ${manifest.source_id}
        AND materialization_id = ${manifest.materialization_id}
        AND status IN ('staging', 'ready')
      RETURNING *
    `
    if (!rows[0]) {
      throw sourceConflict(
        `Source materialization '${manifest.materialization_id}' cannot transition to 'abandoned'.`
      )
    }
    // Its roots were never live and stay unpublished; purging removes them with the version.
    return sourceRecord(rows[0])
  }

  private async assertReadyState(
    sql: SQLClient,
    manifest: PgOntologySourceRow,
    rootCount: number,
    assertionCount: number
  ): Promise<void> {
    const version = manifest.version_id
    const [counts] = await sql<
      {
        readonly assertions: number | string
        readonly roots: number | string
        readonly ordinals: number | string
        readonly min_ordinal: number | string | null
        readonly max_ordinal: number | string | null
      }[]
    >`
      SELECT (SELECT COUNT(*) FROM ontology_source_roots AS roots
          JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
          WHERE roots.version_id = ${version}) AS assertions,
        COUNT(*) AS roots, COUNT(DISTINCT staging_ordinal) AS ordinals,
        MIN(staging_ordinal) AS min_ordinal, MAX(staging_ordinal) AS max_ordinal
      FROM ontology_source_roots
      WHERE version_id = ${version}
    `
    const assertions = Number(counts?.assertions ?? 0)
    const roots = Number(counts?.roots ?? 0)
    const ordinals = Number(counts?.ordinals ?? 0)
    const minimum = counts?.min_ordinal === null ? null : Number(counts?.min_ordinal)
    const maximum = counts?.max_ordinal === null ? null : Number(counts?.max_ordinal)
    if (
      assertions !== assertionCount ||
      roots !== rootCount ||
      ordinals !== rootCount ||
      (rootCount > 0 && (minimum !== 0 || maximum !== rootCount - 1))
    ) {
      throw new MaterializationValidationError(
        "Source ready counts do not match the staged roots and assertions."
      )
    }
    await assertSourceRootCoverage(sql, manifest)

    // Roots store only their canonical key; compare its parts with each row's typed identity.
    const [invalid] =
      manifest.projection_kind === "link"
        ? await sql<{ readonly root_key: string }[]>`
            SELECT roots.root_key
            FROM ontology_source_roots AS roots
            CROSS JOIN LATERAL (SELECT roots.root_key::jsonb AS parts) AS root
            JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
            WHERE roots.version_id = ${version}
            GROUP BY roots.id, roots.root_key
            HAVING COUNT(*) <> 1
              OR BOOL_OR(root.parts->>0 <> 'link')
              OR BOOL_OR(rows.entity_kind <> 'link')
              OR BOOL_OR(rows.source_type_id <> root.parts->>1
                OR rows.source_primary_id <> root.parts->>2 OR rows.link_id <> root.parts->>3
                OR rows.target_type_id <> root.parts->>4 OR rows.target_primary_id <> root.parts->>5)
            LIMIT 1
          `
        : await sql<{ readonly root_key: string }[]>`
            SELECT roots.root_key
            FROM ontology_source_roots AS roots
            CROSS JOIN LATERAL (SELECT roots.root_key::jsonb AS parts) AS root
            JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
            WHERE roots.version_id = ${version}
            GROUP BY roots.id, roots.root_key
            HAVING BOOL_OR(root.parts->>0 <> 'object')
              OR COUNT(*) FILTER (
                WHERE rows.entity_kind = 'object' AND rows.object_type_id = root.parts->>1
                  AND rows.primary_id = root.parts->>2
              ) <> 1
              OR COUNT(*) FILTER (
                WHERE (rows.entity_kind = 'object' AND (rows.object_type_id <> root.parts->>1
                    OR rows.primary_id <> root.parts->>2))
                  OR (rows.entity_kind = 'link' AND (rows.source_type_id <> root.parts->>1
                    OR rows.source_primary_id <> root.parts->>2))
              ) <> 0
              OR COUNT(*) FILTER (WHERE rows.entity_kind = 'link') <> COUNT(DISTINCT (
                rows.link_id, rows.target_type_id, rows.target_primary_id
              )) FILTER (WHERE rows.entity_kind = 'link')
            LIMIT 1
          `
    if (invalid) {
      throw new MaterializationValidationError(
        manifest.projection_kind === "link"
          ? "Link projection roots must contain exactly their matching link assertion."
          : "Object projection roots must contain exactly their matching object assertion plus links sourced from that root."
      )
    }
  }

  /** Already staged assertions sharing a root or an ordinal with `rows`. */
  private async findStageRows(
    sql: SQLClient,
    manifest: PgOntologySourceRow,
    rows: readonly SourceStageRow[]
  ): Promise<readonly SourceStageRow[]> {
    if (rows.length === 0) return []
    const rootKeys = [...new Set(rows.map((row) => row.rootKey))]
    const ordinals = [...new Set(rows.map((row) => row.row.stagingOrdinal))]
    const existing = await sql<PgOntologySourceAssertionRow[]>`
      SELECT ${sourceAssertionColumns(sql)}
      FROM ontology_source_roots AS roots
      JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
      JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
      WHERE roots.version_id = ${manifest.version_id}
        AND (
          roots.root_key = ANY(${sql.array(rootKeys)}::text[])
          OR roots.staging_ordinal = ANY(${sql.array(ordinals)}::bigint[])
        )
    `
    return existing.map((row) => sourceStageRow(sourceAssertion(row)))
  }

  private async insertStageRows(
    sql: SQLClient,
    manifest: PgOntologySourceRow,
    rows: readonly SourceStageRow[]
  ): Promise<void> {
    if (rows.length === 0) return
    const payload = rows.map(({ rootKey, row }) => {
      const entity = entityColumns(row.assertion)
      return {
        root_key: rootKey,
        entity_kind: row.assertion.kind,
        object_type_id: entity.objectTypeId,
        primary_id: entity.primaryId,
        source_type_id: entity.sourceTypeId,
        source_primary_id: entity.sourcePrimaryId,
        link_id: entity.linkId,
        target_type_id: entity.targetTypeId,
        target_primary_id: entity.targetPrimaryId,
        payload: sourceAssertionPayload(row.assertion),
      }
    })
    const inserted = await sql`
      INSERT INTO ontology_source_rows (
        root_id, entity_kind, object_type_id, primary_id,
        source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, payload
      )
      SELECT roots.id, staged.entity_kind, staged.object_type_id, staged.primary_id,
        staged.source_type_id, staged.source_primary_id, staged.link_id,
        staged.target_type_id, staged.target_primary_id, staged.payload
      FROM jsonb_to_recordset(${jsonParameter(sql, payload)}) AS staged(
        root_key TEXT, entity_kind TEXT, object_type_id TEXT, primary_id TEXT,
        source_type_id TEXT, source_primary_id TEXT, link_id TEXT,
        target_type_id TEXT, target_primary_id TEXT, payload JSONB
      )
      JOIN ontology_source_roots AS roots
        ON roots.version_id = ${manifest.version_id} AND roots.root_key = staged.root_key
    `
    if (inserted.count !== rows.length) {
      throw sourceConflict("Staged source rows do not all belong to a staged root.")
    }
  }

  private assertExecution(
    sql: SQLClient,
    input: {
      readonly projectId: string
      readonly source: { readonly projectionId: string }
      readonly execution: { readonly projectionRunId: string; readonly executionToken: string }
    },
    identity?: AssertSourceMaterializationExecutionInput["identity"]
  ): Promise<void> {
    return assertProjectionExecution(sql, {
      projectId: input.projectId,
      sourceId: input.source.projectionId,
      projectionRunId: input.execution.projectionRunId,
      executionToken: input.execution.executionToken,
      ...(identity ? { identity } : {}),
    })
  }

  private async getRunCandidate(
    sql: SQLClient,
    input: BeginSourceMaterializationInput
  ): Promise<PgOntologySourceRow | null> {
    const [row] = await sql<PgOntologySourceRow[]>`
      SELECT * FROM ontology_sources
      WHERE project_id = ${input.projectId}
        AND projection_run_id = ${input.execution.projectionRunId}
        AND status IN ('staging', 'ready')
      LIMIT 1
      FOR UPDATE
    `
    return row ?? null
  }

  private async getManifest(
    sql: SQLClient,
    projectId: string,
    sourceId: string,
    materializationId: string,
    lock = false
  ): Promise<PgOntologySourceRow | null> {
    const lockFragment = lock ? sql`FOR UPDATE` : sql``
    const [row] = await sql<PgOntologySourceRow[]>`
      SELECT * FROM ontology_sources
      WHERE project_id = ${projectId}
        AND source_id = ${sourceId}
        AND materialization_id = ${materializationId}
      ${lockFragment}
    `
    return row ?? null
  }

  private async requireManifest(
    sql: SQLClient,
    projectId: string,
    sourceId: string,
    materializationId: string,
    lock = false
  ): Promise<PgOntologySourceRow> {
    const row = await this.getManifest(sql, projectId, sourceId, materializationId, lock)
    if (!row) throw sourceConflict(`Source materialization '${materializationId}' does not exist.`)
    return row
  }
}

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value)
}
