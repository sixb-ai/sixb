import {
  MaterializationValidationError,
  projectionEntityKey,
} from "@sixb/core/internal/materializer"
import {
  assertSourceBeginInput as assertBeginInput,
  assertSourceExecutionIdentity as assertExecutionIdentity,
  assertSourceProject as assertProjectAndSource,
  assertSourceCandidateOwner,
  assertSourceStagedRow,
  assertSourceWriteIdentity as assertWriteIdentity,
  sourceEntityColumns as entityColumns,
  isExactStagingManifest,
  sourceConflict,
  sourceMaterializationIdentity,
  utf8SortKey,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  AbandonSourceMaterializationCandidateInput,
  AbandonSourceMaterializationInput,
  AssertSourceMaterializationExecutionInput,
  BeginSourceMaterializationInput,
  CleanupTerminalSourceMaterializationsInput,
  CleanupTerminalSourceMaterializationsResult,
  GetActiveOntologySourceInput,
  MarkSourceMaterializationReadyInput,
  OntologySourceRecord,
  OntologySourceStorage,
  ReclaimSourceMaterializationInput,
  StageSourceAssertion,
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
  canonicalJson,
  databaseSafeInteger,
  jsonKeyParameter,
  jsonParameter,
  ontologyLockKey,
  type PgOntologySourceAssertionRow,
  type PgOntologySourceRow,
  type PgRootOperation,
  sourceAssertion,
  sourceEntityKey,
  sourceRecord,
  toIsoString,
} from "./shared"

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
          `Projection run '${input.execution.projectionRunId}' already has a nonterminal source materialization; reclaim it before beginning another.`
        )
      }

      const rows = await sql<PgOntologySourceRow[]>`
        INSERT INTO ontology_sources (
          project_id, source_id, materialization_id, projection_run_id,
          projection_kind, protocol, status, execution_token,
          dataset_id, dataset_version_id, dataset_version_created_at,
          projection_revision, ownership_hash, ontology_revision,
          root_count, assertion_count, created_at, ready_at, activated_at,
          terminal_at, last_commit_id, updated_at
        ) VALUES (
          ${input.projectId}, ${input.source.projectionId}, ${input.materializationId},
          ${input.execution.projectionRunId}, ${input.projectionKind}, 'replacement',
          'staging', ${input.execution.executionToken}, ${input.datasetVersion.datasetId},
          ${input.datasetVersion.versionId}, ${input.datasetVersion.createdAt},
          ${input.projectionRevision}, ${input.ownershipHash}, ${input.ontologyRevision},
          NULL, NULL, ${input.createdAt}, NULL, NULL, NULL, NULL, ${input.createdAt}
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
          `Projection run '${input.execution.projectionRunId}' already has a nonterminal source materialization; reclaim it before beginning another.`
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

      const pending = new Map<string, StageSourceAssertion>()
      const rootOrdinals = new Map<string, number>()
      const ordinalRoots = new Map<number, string>()
      let unchanged = 0
      for (const row of input.rows) {
        assertSourceStagedRow(manifest.projection_kind, row)
        const rootKey = projectionEntityKey(row.root)
        const entityKey = sourceEntityKey(row)
        const rootOrdinal =
          (await this.findRootOrdinal(sql, input, rootKey)) ?? rootOrdinals.get(rootKey)
        if (rootOrdinal !== undefined && rootOrdinal !== row.stagingOrdinal) {
          throw new MaterializationValidationError(
            `Source materialization repeats root ${rootKey} at a different stream ordinal.`
          )
        }
        const ordinalRoot =
          (await this.findOrdinalRoot(sql, input, row.stagingOrdinal)) ??
          ordinalRoots.get(row.stagingOrdinal)
        if (ordinalRoot !== undefined && ordinalRoot !== rootKey) {
          throw new MaterializationValidationError(
            `Source materialization repeats stream ordinal ${row.stagingOrdinal} for another root.`
          )
        }

        const existing = (await this.getAssertion(sql, input, entityKey)) ?? pending.get(entityKey)
        if (existing) {
          if (canonicalJson(existing) === canonicalJson(row)) {
            unchanged += 1
            continue
          }
          throw new MaterializationValidationError(
            `Source materialization repeats asserted entity ${entityKey}.`
          )
        }
        rootOrdinals.set(rootKey, row.stagingOrdinal)
        ordinalRoots.set(row.stagingOrdinal, rootKey)
        pending.set(entityKey, structuredClone(row))
      }

      for (const [entityKey, row] of pending) {
        const entity = entityColumns(row.assertion)
        const root = entityColumns(row.root)
        await sql`
          INSERT INTO ontology_source_rows (
            project_id, source_id, materialization_id,
            entity_kind, entity_key, entity_sort_key,
            root_kind, root_key, root_sort_key, staging_ordinal,
            root, assertion,
            object_type_id, primary_id,
            source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
            root_object_type_id, root_primary_id,
            root_source_type_id, root_source_primary_id, root_link_id,
            root_target_type_id, root_target_primary_id
          ) VALUES (
            ${input.projectId}, ${input.source.projectionId}, ${input.materializationId},
            ${row.assertion.kind}, ${jsonKeyParameter(sql, entityKey)}, ${utf8SortKey(entityKey)},
            ${row.root.kind}, ${jsonKeyParameter(sql, projectionEntityKey(row.root))},
            ${utf8SortKey(projectionEntityKey(row.root))}, ${row.stagingOrdinal},
            ${jsonParameter(sql, row.root)}, ${jsonParameter(sql, row.assertion)},
            ${entity.objectTypeId}, ${entity.primaryId}, ${entity.sourceTypeId},
            ${entity.sourcePrimaryId}, ${entity.linkId}, ${entity.targetTypeId},
            ${entity.targetPrimaryId}, ${root.objectTypeId}, ${root.primaryId},
            ${root.sourceTypeId}, ${root.sourcePrimaryId}, ${root.linkId},
            ${root.targetTypeId}, ${root.targetPrimaryId}
          )
        `
      }
      return { inserted: pending.size, unchanged }
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

  async abandon(input: AbandonSourceMaterializationCandidateInput): Promise<OntologySourceRecord>
  async abandon(input: ReclaimSourceMaterializationInput): Promise<OntologySourceRecord | null>
  async abandon(input: AbandonSourceMaterializationInput): Promise<OntologySourceRecord | null> {
    return this.runRootOperation(async (sql) => {
      assertProjectAndSource(input)
      assertExecutionIdentity(input.execution.projectionRunId, input.execution.executionToken)
      assertTimestamp(input.abandonedAt, "Source abandonedAt", true)
      await this.assertExecution(sql, input)
      return input.kind === "candidate"
        ? this.abandonCandidate(sql, input)
        : this.abandonForReclaim(sql, input)
    })
  }

  async cleanupTerminal(
    input: CleanupTerminalSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult> {
    return this.runRootOperation(async (sql) => {
      assertNonblank(input.projectId, "Terminal source cleanup project id")
      assertTimestamp(input.terminalBefore, "Terminal source cleanup cutoff", true)
      assertPositiveInteger(input.limit, "Terminal source cleanup limit")
      const manifests = await sql<PgOntologySourceRow[]>`
        SELECT * FROM ontology_sources
        WHERE project_id = ${input.projectId}
          AND status IN ('superseded', 'abandoned')
          AND terminal_at < ${input.terminalBefore}
        ORDER BY terminal_at, source_id, materialization_id
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      `
      let remaining = input.limit
      let rowsDeleted = 0
      let materializationsDeleted = 0
      for (const manifest of manifests) {
        if (remaining === 0) break
        const deletedRows = await sql<{ readonly entity_sort_key: string }[]>`
          WITH selected AS (
            SELECT rows.ctid
            FROM ontology_source_rows AS rows
            WHERE rows.project_id = ${manifest.project_id}
              AND rows.source_id = ${manifest.source_id}
              AND rows.materialization_id = ${manifest.materialization_id}
            ORDER BY rows.entity_sort_key
            LIMIT ${remaining}
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM ontology_source_rows AS rows
          USING selected
          WHERE rows.ctid = selected.ctid
          RETURNING rows.entity_sort_key
        `
        rowsDeleted += deletedRows.length
        remaining -= deletedRows.length
        if (remaining === 0) break
        const removed = await sql<{ readonly materialization_id: string }[]>`
          DELETE FROM ontology_sources AS sources
          WHERE sources.project_id = ${manifest.project_id}
            AND sources.source_id = ${manifest.source_id}
            AND sources.materialization_id = ${manifest.materialization_id}
            AND sources.status IN ('superseded', 'abandoned')
            AND sources.terminal_at = ${manifest.terminal_at}
            AND sources.terminal_at < ${input.terminalBefore}
            AND NOT EXISTS (
              SELECT 1 FROM ontology_source_rows AS rows
              WHERE rows.project_id = sources.project_id
                AND rows.source_id = sources.source_id
                AND rows.materialization_id = sources.materialization_id
            )
          RETURNING sources.materialization_id
        `
        materializationsDeleted += removed.length
        remaining -= removed.length
      }
      return { rowsDeleted, materializationsDeleted }
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

  private async abandonForReclaim(
    sql: SQLClient,
    input: ReclaimSourceMaterializationInput
  ): Promise<OntologySourceRecord | null> {
    const candidates = await sql<PgOntologySourceRow[]>`
      SELECT * FROM ontology_sources
      WHERE project_id = ${input.projectId}
        AND source_id = ${input.source.projectionId}
        AND projection_run_id = ${input.execution.projectionRunId}
        AND status IN ('staging', 'ready')
      FOR UPDATE
    `
    if (
      candidates.some((candidate) => candidate.execution_token === input.execution.executionToken)
    ) {
      throw sourceConflict(
        `Projection run '${input.execution.projectionRunId}' already has a source materialization owned by the current execution.`
      )
    }
    if (candidates.length > 1) {
      throw sourceConflict(
        `Projection run '${input.execution.projectionRunId}' has multiple nonterminal source materializations.`
      )
    }
    return candidates[0] ? this.transitionToAbandoned(sql, candidates[0], input.abandonedAt) : null
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
    return sourceRecord(rows[0])
  }

  private async assertReadyState(
    sql: SQLClient,
    manifest: PgOntologySourceRow,
    rootCount: number,
    assertionCount: number
  ): Promise<void> {
    const [counts] = await sql<
      {
        readonly assertions: number | string
        readonly roots: number | string
        readonly ordinals: number | string
        readonly min_ordinal: number | string | null
        readonly max_ordinal: number | string | null
      }[]
    >`
      SELECT COUNT(*) AS assertions, COUNT(DISTINCT root_key) AS roots,
        COUNT(DISTINCT staging_ordinal) AS ordinals,
        MIN(staging_ordinal) AS min_ordinal, MAX(staging_ordinal) AS max_ordinal
      FROM ontology_source_rows
      WHERE project_id = ${manifest.project_id}
        AND source_id = ${manifest.source_id}
        AND materialization_id = ${manifest.materialization_id}
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

    const [invalid] =
      manifest.projection_kind === "link"
        ? await sql<{ readonly root_key: unknown }[]>`
            SELECT root_key
            FROM ontology_source_rows
            WHERE project_id = ${manifest.project_id}
              AND source_id = ${manifest.source_id}
              AND materialization_id = ${manifest.materialization_id}
            GROUP BY root_key
            HAVING COUNT(*) <> 1
              OR BOOL_OR(root_kind <> 'link')
              OR BOOL_OR(entity_kind <> 'link')
              OR BOOL_OR(root_key <> entity_key)
            LIMIT 1
          `
        : await sql<{ readonly root_key: unknown }[]>`
            SELECT root_key
            FROM ontology_source_rows
            WHERE project_id = ${manifest.project_id}
              AND source_id = ${manifest.source_id}
              AND materialization_id = ${manifest.materialization_id}
            GROUP BY root_key
            HAVING BOOL_OR(root_kind <> 'object')
              OR COUNT(*) FILTER (
                WHERE entity_kind = 'object' AND entity_key = root_key
              ) <> 1
              OR COUNT(*) FILTER (
                WHERE (entity_kind = 'object' AND entity_key <> root_key)
                   OR (entity_kind = 'link' AND (
                     source_type_id <> root_object_type_id
                     OR source_primary_id <> root_primary_id
                   ))
              ) <> 0
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

  private async findRootOrdinal(
    sql: SQLClient,
    input: StageSourceRowsInput,
    rootKey: string
  ): Promise<number | undefined> {
    const [row] = await sql<{ readonly staging_ordinal: number | string }[]>`
      SELECT staging_ordinal FROM ontology_source_rows
      WHERE project_id = ${input.projectId}
        AND source_id = ${input.source.projectionId}
        AND materialization_id = ${input.materializationId}
        AND root_key = ${jsonKeyParameter(sql, rootKey)}
      LIMIT 1
    `
    return row ? databaseSafeInteger(row.staging_ordinal, "Source staging ordinal") : undefined
  }

  private async findOrdinalRoot(
    sql: SQLClient,
    input: StageSourceRowsInput,
    ordinal: number
  ): Promise<string | undefined> {
    const [row] = await sql<{ readonly root_key: unknown }[]>`
      SELECT root_key FROM ontology_source_rows
      WHERE project_id = ${input.projectId}
        AND source_id = ${input.source.projectionId}
        AND materialization_id = ${input.materializationId}
        AND staging_ordinal = ${ordinal}
      LIMIT 1
    `
    return row ? canonicalJson(row.root_key) : undefined
  }

  private async getAssertion(
    sql: SQLClient,
    input: StageSourceRowsInput,
    entityKey: string
  ): Promise<StageSourceAssertion | undefined> {
    const [row] = await sql<PgOntologySourceAssertionRow[]>`
      SELECT * FROM ontology_source_rows
      WHERE project_id = ${input.projectId}
        AND source_id = ${input.source.projectionId}
        AND materialization_id = ${input.materializationId}
        AND entity_key = ${jsonKeyParameter(sql, entityKey)}
    `
    return row ? sourceAssertion(row) : undefined
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
