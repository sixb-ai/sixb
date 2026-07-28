import type { Database } from "bun:sqlite"
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
  sourceConflict,
  sourceMaterializationIdentity,
  sourceStageRow,
  sourceStageRows,
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
  StageSourceRowsInput,
  StageSourceRowsResult,
  SummarizeTerminalSourceMaterializationsInput,
  TerminalSourceMaterializationSummary,
} from "@sixb/core/storage"
import {
  assertNonblank,
  assertNonnegativeInteger,
  assertPositiveInteger,
  assertProjectionExecution,
  assertTimestamp,
  canonicalJson,
  type SqliteOntologySourceAssertionRow,
  type SqliteOntologySourceRow,
  type SqliteRootOperation,
  sourceAssertion,
  sourceRecord,
} from "./shared"

export class SqliteOntologySourceStorage implements OntologySourceStorage {
  constructor(
    private readonly db: Database,
    private readonly runRootOperation: SqliteRootOperation
  ) {}

  async beginMaterialization(
    input: BeginSourceMaterializationInput
  ): Promise<OntologySourceRecord> {
    return this.runRootOperation(() => {
      assertBeginInput(input)
      this.assertExecution(input, sourceMaterializationIdentity(input))
      const existing = this.getManifest(
        input.projectId,
        input.source.projectionId,
        input.materializationId
      )
      if (existing) {
        if (isExactStagingManifest(sourceRecord(existing), input)) return sourceRecord(existing)
        throw sourceConflict(
          `Source materialization '${input.materializationId}' already exists with different identity or state.`
        )
      }

      const candidate = this.db
        .query(
          `
            SELECT 1
            FROM ontology_sources
            WHERE project_id = ? AND projection_run_id = ?
              AND status IN ('staging', 'ready')
            LIMIT 1
          `
        )
        .get(input.projectId, input.execution.projectionRunId)
      if (candidate) {
        throw sourceConflict(
          `Projection run '${input.execution.projectionRunId}' already has a nonterminal source materialization; reclaim it before beginning another.`
        )
      }

      this.db
        .query(
          `
            INSERT INTO ontology_sources (
              project_id, source_id, materialization_id, projection_run_id,
              projection_kind, protocol, status, execution_token,
              dataset_id, dataset_version_id, dataset_version_created_at,
              projection_revision, ownership_hash, ontology_revision,
              root_count, assertion_count, created_at, ready_at, activated_at,
              terminal_at, last_commit_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'replacement', 'staging', ?, ?, ?, ?, ?, ?, ?,
              NULL, NULL, ?, NULL, NULL, NULL, NULL, ?)
          `
        )
        .run(
          input.projectId,
          input.source.projectionId,
          input.materializationId,
          input.execution.projectionRunId,
          input.projectionKind,
          input.execution.executionToken,
          input.datasetVersion.datasetId,
          input.datasetVersion.versionId,
          input.datasetVersion.createdAt,
          input.projectionRevision,
          input.ownershipHash,
          input.ontologyRevision,
          input.createdAt,
          input.createdAt
        )
      return sourceRecord(
        this.requireManifest(input.projectId, input.source.projectionId, input.materializationId)
      )
    })
  }

  async stageRows(input: StageSourceRowsInput): Promise<StageSourceRowsResult> {
    return this.runRootOperation(() => {
      assertWriteIdentity(input)
      this.assertExecution(input)
      const manifest = this.requireManifest(
        input.projectId,
        input.source.projectionId,
        input.materializationId
      )
      assertSourceCandidateOwner(sourceRecord(manifest), input.execution)
      if (manifest.status !== "staging") {
        throw sourceConflict(
          `Source materialization '${input.materializationId}' is '${manifest.status}' and cannot accept rows.`
        )
      }

      const rows = sourceStageRows(manifest.projection_kind, input.rows)
      const existing = this.findStageRows(input, rows)
      const { pending, unchanged } = reconcileSourceStageRows(rows, existing)
      this.insertStageRows(input, pending)
      return { inserted: pending.length, unchanged }
    })
  }

  async markReady(input: MarkSourceMaterializationReadyInput): Promise<OntologySourceRecord> {
    return this.runRootOperation(() => {
      assertWriteIdentity(input)
      assertTimestamp(input.readyAt, "Source readyAt", true)
      assertNonnegativeInteger(input.rootCount, "Source root count")
      assertNonnegativeInteger(input.assertionCount, "Source assertion count")
      this.assertExecution(input)
      const manifest = this.requireManifest(
        input.projectId,
        input.source.projectionId,
        input.materializationId
      )
      assertSourceCandidateOwner(sourceRecord(manifest), input.execution)
      if (manifest.status === "ready") {
        if (
          manifest.root_count === input.rootCount &&
          manifest.assertion_count === input.assertionCount &&
          manifest.ready_at === input.readyAt
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
      if (input.readyAt < manifest.created_at) {
        throw new MaterializationValidationError("Source readyAt cannot precede source createdAt.")
      }
      this.assertReadyState(manifest, input.rootCount, input.assertionCount)
      const result = this.db
        .query(
          `
            UPDATE ontology_sources
            SET status = 'ready', root_count = ?, assertion_count = ?, ready_at = ?, updated_at = ?
            WHERE project_id = ? AND source_id = ? AND materialization_id = ?
              AND status = 'staging' AND execution_token = ?
          `
        )
        .run(
          input.rootCount,
          input.assertionCount,
          input.readyAt,
          input.readyAt,
          input.projectId,
          input.source.projectionId,
          input.materializationId,
          input.execution.executionToken
        )
      if (result.changes !== 1) {
        throw sourceConflict(`Source materialization '${input.materializationId}' changed.`)
      }
      return sourceRecord(
        this.requireManifest(input.projectId, input.source.projectionId, input.materializationId)
      )
    })
  }

  async getActive(input: GetActiveOntologySourceInput): Promise<OntologySourceRecord | null> {
    return this.runRootOperation(() => {
      assertProjectAndSource(input)
      const row = this.db
        .query(
          `
            SELECT * FROM ontology_sources
            WHERE project_id = ? AND source_id = ? AND status = 'active'
          `
        )
        .get(input.projectId, input.source.projectionId) as SqliteOntologySourceRow | null
      return row ? sourceRecord(row) : null
    })
  }

  async abandon(input: AbandonSourceMaterializationCandidateInput): Promise<OntologySourceRecord>
  async abandon(input: ReclaimSourceMaterializationInput): Promise<OntologySourceRecord | null>
  async abandon(input: AbandonSourceMaterializationInput): Promise<OntologySourceRecord | null> {
    return this.runRootOperation(() => {
      assertProjectAndSource(input)
      assertExecutionIdentity(input.execution.projectionRunId, input.execution.executionToken)
      assertTimestamp(input.abandonedAt, "Source abandonedAt", true)
      this.assertExecution(input)
      return input.kind === "candidate"
        ? this.abandonCandidate(input)
        : this.abandonForReclaim(input)
    })
  }

  async cleanupTerminal(
    input: CleanupTerminalSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Terminal source cleanup project id")
      assertTimestamp(input.terminalBefore, "Terminal source cleanup cutoff", true)
      assertPositiveInteger(input.limit, "Terminal source cleanup limit")
      const manifests = this.db
        .query(
          `
            SELECT * FROM ontology_sources
            WHERE project_id = ? AND status IN ('superseded', 'abandoned')
              AND terminal_at < ?
            ORDER BY terminal_at, source_id, materialization_id
            LIMIT ?
          `
        )
        .all(input.projectId, input.terminalBefore, input.limit) as SqliteOntologySourceRow[]
      let remaining = input.limit
      let rowsDeleted = 0
      let materializationsDeleted = 0
      for (const manifest of manifests) {
        if (remaining === 0) break
        const deleted = this.db
          .query(
            `
              DELETE FROM ontology_source_rows
              WHERE rowid IN (
                SELECT rows.rowid
                FROM ontology_source_rows AS rows
                JOIN ontology_sources AS sources
                  ON sources.project_id = rows.project_id
                 AND sources.source_id = rows.source_id
                 AND sources.materialization_id = rows.materialization_id
                WHERE rows.project_id = ? AND rows.source_id = ? AND rows.materialization_id = ?
                  AND sources.status IN ('superseded', 'abandoned')
                  AND sources.terminal_at = ? AND sources.terminal_at < ?
                ORDER BY rows.entity_sort_key
                LIMIT ?
              )
            `
          )
          .run(
            manifest.project_id,
            manifest.source_id,
            manifest.materialization_id,
            manifest.terminal_at,
            input.terminalBefore,
            remaining
          ).changes
        rowsDeleted += deleted
        remaining -= deleted
        if (remaining === 0) break
        const removed = this.db
          .query(
            `
              DELETE FROM ontology_sources
              WHERE project_id = ? AND source_id = ? AND materialization_id = ?
                AND status IN ('superseded', 'abandoned')
                AND terminal_at = ? AND terminal_at < ?
                AND NOT EXISTS (
                  SELECT 1 FROM ontology_source_rows AS rows
                  WHERE rows.project_id = ontology_sources.project_id
                    AND rows.source_id = ontology_sources.source_id
                    AND rows.materialization_id = ontology_sources.materialization_id
                )
            `
          )
          .run(
            manifest.project_id,
            manifest.source_id,
            manifest.materialization_id,
            manifest.terminal_at,
            input.terminalBefore
          ).changes
        materializationsDeleted += removed
        remaining -= removed
      }
      return { rowsDeleted, materializationsDeleted }
    })
  }

  async summarizeTerminal(
    input: SummarizeTerminalSourceMaterializationsInput
  ): Promise<TerminalSourceMaterializationSummary> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Terminal source summary project id")
      const summary = this.db
        .query(
          `
            SELECT COUNT(*) AS terminal_count, MIN(terminal_at) AS oldest_terminal_at
            FROM ontology_sources
            WHERE project_id = ? AND status IN ('superseded', 'abandoned')
          `
        )
        .get(input.projectId) as {
        readonly terminal_count: number
        readonly oldest_terminal_at: string | null
      }
      return {
        count: summary.terminal_count,
        oldestTerminalAt: summary.oldest_terminal_at,
      }
    })
  }

  private abandonCandidate(
    input: AbandonSourceMaterializationCandidateInput
  ): OntologySourceRecord {
    const manifest = this.requireManifest(
      input.projectId,
      input.source.projectionId,
      input.materializationId
    )
    if (manifest.status === "abandoned") {
      if (
        manifest.projection_run_id === input.execution.projectionRunId &&
        manifest.terminal_at === input.abandonedAt
      ) {
        return sourceRecord(manifest)
      }
      throw sourceConflict(
        `Source materialization '${input.materializationId}' was abandoned by another execution or at another time.`
      )
    }
    assertSourceCandidateOwner(sourceRecord(manifest), input.execution)
    return this.transitionToAbandoned(manifest, input.abandonedAt)
  }

  private abandonForReclaim(input: ReclaimSourceMaterializationInput): OntologySourceRecord | null {
    const candidates = this.db
      .query(
        `
          SELECT * FROM ontology_sources
          WHERE project_id = ? AND source_id = ? AND projection_run_id = ?
            AND status IN ('staging', 'ready')
        `
      )
      .all(
        input.projectId,
        input.source.projectionId,
        input.execution.projectionRunId
      ) as SqliteOntologySourceRow[]
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
    return candidates[0] ? this.transitionToAbandoned(candidates[0], input.abandonedAt) : null
  }

  private transitionToAbandoned(
    manifest: SqliteOntologySourceRow,
    abandonedAt: string
  ): OntologySourceRecord {
    if (
      abandonedAt < manifest.created_at ||
      (manifest.ready_at !== null && abandonedAt < manifest.ready_at)
    ) {
      throw new MaterializationValidationError(
        "Source abandonedAt cannot precede source creation or readiness."
      )
    }
    const changed = this.db
      .query(
        `
          UPDATE ontology_sources
          SET status = 'abandoned', execution_token = NULL, terminal_at = ?, updated_at = ?
          WHERE project_id = ? AND source_id = ? AND materialization_id = ?
            AND status IN ('staging', 'ready')
        `
      )
      .run(
        abandonedAt,
        abandonedAt,
        manifest.project_id,
        manifest.source_id,
        manifest.materialization_id
      ).changes
    if (changed !== 1) {
      throw sourceConflict(
        `Source materialization '${manifest.materialization_id}' cannot transition to 'abandoned'.`
      )
    }
    return sourceRecord(
      this.requireManifest(manifest.project_id, manifest.source_id, manifest.materialization_id)
    )
  }

  private assertReadyState(
    manifest: SqliteOntologySourceRow,
    rootCount: number,
    assertionCount: number
  ): void {
    const counts = this.db
      .query(
        `
          SELECT COUNT(*) AS assertions, COUNT(DISTINCT root_key) AS roots,
            COUNT(DISTINCT staging_ordinal) AS ordinals,
            MIN(staging_ordinal) AS min_ordinal, MAX(staging_ordinal) AS max_ordinal
          FROM ontology_source_rows
          WHERE project_id = ? AND source_id = ? AND materialization_id = ?
        `
      )
      .get(manifest.project_id, manifest.source_id, manifest.materialization_id) as {
      assertions: number
      roots: number
      ordinals: number
      min_ordinal: number | null
      max_ordinal: number | null
    }
    if (
      counts.assertions !== assertionCount ||
      counts.roots !== rootCount ||
      counts.ordinals !== rootCount ||
      (rootCount > 0 && (counts.min_ordinal !== 0 || counts.max_ordinal !== rootCount - 1))
    ) {
      throw new MaterializationValidationError(
        "Source ready counts do not match the staged roots and assertions."
      )
    }
    const invalid = this.db
      .query(
        manifest.projection_kind === "link"
          ? `
              SELECT root_key
              FROM ontology_source_rows
              WHERE project_id = ? AND source_id = ? AND materialization_id = ?
              GROUP BY root_key
              HAVING COUNT(*) <> 1 OR MIN(root_kind) <> 'link' OR MIN(entity_kind) <> 'link'
                OR MIN(root_key) <> MIN(entity_key)
              LIMIT 1
            `
          : `
              SELECT root_key
              FROM ontology_source_rows
              WHERE project_id = ? AND source_id = ? AND materialization_id = ?
              GROUP BY root_key
              HAVING MIN(root_kind) <> 'object'
                OR SUM(CASE WHEN entity_kind = 'object' AND entity_key = root_key THEN 1 ELSE 0 END) <> 1
                OR SUM(CASE
                  WHEN entity_kind = 'object' AND entity_key <> root_key THEN 1
                  WHEN entity_kind = 'link' AND (
                    source_type_id <> root_object_type_id OR source_primary_id <> root_primary_id
                  ) THEN 1
                  ELSE 0
                END) <> 0
              LIMIT 1
            `
      )
      .get(manifest.project_id, manifest.source_id, manifest.materialization_id)
    if (invalid) {
      throw new MaterializationValidationError(
        manifest.projection_kind === "link"
          ? "Link projection roots must contain exactly their matching link assertion."
          : "Object projection roots must contain exactly their matching object assertion plus links sourced from that root."
      )
    }
  }

  private findStageRows(
    input: StageSourceRowsInput,
    rows: readonly SourceStageRow[]
  ): readonly SourceStageRow[] {
    if (rows.length === 0) return []
    const rootSortKeys = [...new Set(rows.map((row) => utf8SortKey(row.rootKey)))]
    const ordinals = [...new Set(rows.map((row) => row.row.stagingOrdinal))]
    const entitySortKeys = [...new Set(rows.map((row) => utf8SortKey(row.entityKey)))]
    const existing = this.db
      .query(
        `
          SELECT * FROM ontology_source_rows
          WHERE project_id = ? AND source_id = ? AND materialization_id = ?
            AND (
              root_sort_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))
              OR staging_ordinal IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
              OR entity_sort_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))
            )
        `
      )
      .all(
        input.projectId,
        input.source.projectionId,
        input.materializationId,
        JSON.stringify(rootSortKeys),
        JSON.stringify(ordinals),
        JSON.stringify(entitySortKeys)
      ) as SqliteOntologySourceAssertionRow[]
    return existing.map((row) => sourceStageRow(sourceAssertion(row)))
  }

  private insertStageRows(input: StageSourceRowsInput, rows: readonly SourceStageRow[]): void {
    if (rows.length === 0) return
    const payload = rows.map(({ entityKey, rootKey, row }) => {
      const entity = entityColumns(row.assertion)
      const root = entityColumns(row.root)
      return {
        entityKind: row.assertion.kind,
        entityKey,
        entitySortKey: utf8SortKey(entityKey),
        rootKind: row.root.kind,
        rootKey,
        rootSortKey: utf8SortKey(rootKey),
        stagingOrdinal: row.stagingOrdinal,
        root: row.root,
        assertion: row.assertion,
        objectTypeId: entity.objectTypeId,
        primaryId: entity.primaryId,
        sourceTypeId: entity.sourceTypeId,
        sourcePrimaryId: entity.sourcePrimaryId,
        linkId: entity.linkId,
        targetTypeId: entity.targetTypeId,
        targetPrimaryId: entity.targetPrimaryId,
        rootObjectTypeId: root.objectTypeId,
        rootPrimaryId: root.primaryId,
        rootSourceTypeId: root.sourceTypeId,
        rootSourcePrimaryId: root.sourcePrimaryId,
        rootLinkId: root.linkId,
        rootTargetTypeId: root.targetTypeId,
        rootTargetPrimaryId: root.targetPrimaryId,
      }
    })
    this.db
      .query(
        `
          WITH staged(value) AS (SELECT value FROM json_each(?))
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
          )
          SELECT
            ?, ?, ?,
            json_extract(value, '$.entityKind'), json_extract(value, '$.entityKey'),
            json_extract(value, '$.entitySortKey'),
            json_extract(value, '$.rootKind'), json_extract(value, '$.rootKey'),
            json_extract(value, '$.rootSortKey'), json_extract(value, '$.stagingOrdinal'),
            json(json_extract(value, '$.root')), json(json_extract(value, '$.assertion')),
            json_extract(value, '$.objectTypeId'), json_extract(value, '$.primaryId'),
            json_extract(value, '$.sourceTypeId'), json_extract(value, '$.sourcePrimaryId'),
            json_extract(value, '$.linkId'), json_extract(value, '$.targetTypeId'),
            json_extract(value, '$.targetPrimaryId'),
            json_extract(value, '$.rootObjectTypeId'), json_extract(value, '$.rootPrimaryId'),
            json_extract(value, '$.rootSourceTypeId'),
            json_extract(value, '$.rootSourcePrimaryId'), json_extract(value, '$.rootLinkId'),
            json_extract(value, '$.rootTargetTypeId'), json_extract(value, '$.rootTargetPrimaryId')
          FROM staged
        `
      )
      .run(
        canonicalJson(payload),
        input.projectId,
        input.source.projectionId,
        input.materializationId
      )
  }

  private assertExecution(
    input: {
      readonly projectId: string
      readonly source: { readonly projectionId: string }
      readonly execution: { readonly projectionRunId: string; readonly executionToken: string }
    },
    identity?: AssertSourceMaterializationExecutionInput["identity"]
  ): void {
    assertProjectionExecution(this.db, {
      projectId: input.projectId,
      sourceId: input.source.projectionId,
      projectionRunId: input.execution.projectionRunId,
      executionToken: input.execution.executionToken,
      ...(identity ? { identity } : {}),
    })
  }

  private getManifest(
    projectId: string,
    sourceId: string,
    materializationId: string
  ): SqliteOntologySourceRow | null {
    return this.db
      .query(
        `
          SELECT * FROM ontology_sources
          WHERE project_id = ? AND source_id = ? AND materialization_id = ?
        `
      )
      .get(projectId, sourceId, materializationId) as SqliteOntologySourceRow | null
  }

  private requireManifest(
    projectId: string,
    sourceId: string,
    materializationId: string
  ): SqliteOntologySourceRow {
    const row = this.getManifest(projectId, sourceId, materializationId)
    if (!row) throw sourceConflict(`Source materialization '${materializationId}' does not exist.`)
    return row
  }
}
