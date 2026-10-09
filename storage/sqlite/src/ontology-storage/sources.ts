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
import { yieldSqliteEventLoop } from "../transactions"
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
import { cleanupSourceVersions, purgeAbandonedSourceVersions } from "./source-cleanup"
import {
  assertSourceRootCoverage,
  SOURCE_ASSERTION_COLUMNS,
  stageSourceRoots,
} from "./source-roots"

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
          `Projection run '${input.execution.projectionRunId}' already has a nonterminal source materialization; adopt it before beginning another.`
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
              terminal_at, last_commit_id, updated_at, base_materialization_id, base_commit_id
            ) VALUES (?, ?, ?, ?, ?, 'replacement', 'staging', ?, ?, ?, ?, ?, ?, ?,
              NULL, NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
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
          input.createdAt,
          input.base?.materializationId ?? null,
          input.base?.lastCommitId ?? null
        )
      return sourceRecord(
        this.requireManifest(input.projectId, input.source.projectionId, input.materializationId)
      )
    })
  }

  async stageRows(input: StageSourceRowsInput): Promise<StageSourceRowsResult> {
    const result = await this.runRootOperation(() => {
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
      const existing = this.findStageRows(manifest, rows)
      const { pending, unchanged } = reconcileSourceStageRows(rows, existing)
      stageSourceRoots(this.db, manifest, input)
      this.insertStageRows(manifest, pending)
      return { inserted: pending.length, unchanged }
    })
    await yieldSqliteEventLoop()
    return result
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

  async adopt(
    input: AdoptSourceMaterializationInput
  ): Promise<AdoptedSourceMaterialization | null> {
    return this.runRootOperation(() => {
      assertProjectAndSource(input)
      assertExecutionIdentity(input.execution.projectionRunId, input.execution.executionToken)
      assertTimestamp(input.adoptedAt, "Source adoptedAt", true)
      this.assertExecution(input)
      const candidate = this.findRunCandidate(input)
      if (!candidate) return null
      // Workers' clocks differ; adoption never moves the record back in time.
      const changed = this.db
        .query(
          `
            UPDATE ontology_sources SET execution_token = ?, updated_at = MAX(updated_at, ?)
            WHERE project_id = ? AND source_id = ? AND materialization_id = ?
              AND status IN ('staging', 'ready')
          `
        )
        .run(
          input.execution.executionToken,
          input.adoptedAt,
          candidate.project_id,
          candidate.source_id,
          candidate.materialization_id
        ).changes
      if (changed !== 1) {
        throw sourceConflict(`Source materialization '${candidate.materialization_id}' changed.`)
      }
      const adopted = this.requireManifest(
        candidate.project_id,
        candidate.source_id,
        candidate.materialization_id
      )
      return {
        record: sourceRecord(adopted),
        resumeStagingOrdinal:
          adopted.status === "ready" ? Number(adopted.root_count) : this.lastStagedOrdinal(adopted),
      }
    })
  }

  async abandon(input: AbandonSourceMaterializationCandidateInput): Promise<OntologySourceRecord>
  async abandon(input: AbandonRunSourceMaterializationInput): Promise<OntologySourceRecord | null>
  async abandon(input: AbandonSourceMaterializationInput): Promise<OntologySourceRecord | null> {
    return this.runRootOperation(() => {
      assertProjectAndSource(input)
      assertExecutionIdentity(input.execution.projectionRunId, input.execution.executionToken)
      assertTimestamp(input.abandonedAt, "Source abandonedAt", true)
      this.assertExecution(input)
      if (input.kind === "candidate") return this.abandonCandidate(input)
      const candidate = this.findRunCandidate(input)
      return candidate ? this.transitionToAbandoned(candidate, input.abandonedAt) : null
    })
  }

  async cleanupTerminal(
    input: CleanupTerminalSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Terminal source cleanup project id")
      assertTimestamp(input.terminalBefore, "Terminal source cleanup cutoff", true)
      assertPositiveInteger(input.limit, "Terminal source cleanup limit")
      return cleanupSourceVersions(this.db, input)
    })
  }

  async purgeAbandoned(
    input: PurgeAbandonedSourceMaterializationsInput
  ): Promise<CleanupTerminalSourceMaterializationsResult> {
    return this.runRootOperation(() => {
      assertNonblank(input.projectId, "Abandoned source purge project id")
      assertPositiveInteger(input.limit, "Abandoned source purge limit")
      return purgeAbandonedSourceVersions(this.db, input)
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

  /** The run's one staging or ready candidate, whichever execution staged it. */
  private findRunCandidate(input: {
    readonly projectId: string
    readonly source: { readonly projectionId: string }
    readonly execution: { readonly projectionRunId: string }
  }): SqliteOntologySourceRow | null {
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
    if (candidates.length > 1) {
      throw sourceConflict(
        `Projection run '${input.execution.projectionRunId}' has multiple nonterminal source materializations.`
      )
    }
    return candidates[0] ?? null
  }

  private lastStagedOrdinal(manifest: SqliteOntologySourceRow): number {
    const last = this.db
      .query(
        "SELECT MAX(staging_ordinal) AS ordinal FROM ontology_source_roots WHERE version_id = ?"
      )
      .get(manifest.version_id) as {
      readonly ordinal: number | null
    } | null
    return last?.ordinal ?? 0
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
    // Its roots were never live and stay unpublished; purging removes them with the version.
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
          SELECT (SELECT COUNT(*) FROM ontology_source_roots AS roots
              JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
              WHERE roots.version_id = ?1) AS assertions,
            COUNT(*) AS roots, COUNT(DISTINCT staging_ordinal) AS ordinals,
            MIN(staging_ordinal) AS min_ordinal, MAX(staging_ordinal) AS max_ordinal
          FROM ontology_source_roots
          WHERE version_id = ?1
        `
      )
      .get(manifest.version_id) as {
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
    assertSourceRootCoverage(this.db, manifest)
    // Roots store only their canonical key; compare its parts with each row's typed identity.
    const invalid = this.db
      .query(
        manifest.projection_kind === "link"
          ? `
              SELECT roots.root_key
              FROM ontology_source_roots AS roots
              JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
              WHERE roots.version_id = ?
              GROUP BY roots.id
              HAVING COUNT(*) <> 1
                OR MAX(json_extract(roots.root_key, '$[0]') <> 'link')
                OR MAX(rows.entity_kind <> 'link')
                OR MAX(rows.source_type_id <> json_extract(roots.root_key, '$[1]')
                  OR rows.source_primary_id <> json_extract(roots.root_key, '$[2]')
                  OR rows.link_id <> json_extract(roots.root_key, '$[3]')
                  OR rows.target_type_id <> json_extract(roots.root_key, '$[4]')
                  OR rows.target_primary_id <> json_extract(roots.root_key, '$[5]'))
              LIMIT 1
            `
          : `
              SELECT roots.root_key
              FROM ontology_source_roots AS roots
              JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
              WHERE roots.version_id = ?
              GROUP BY roots.id
              HAVING MAX(json_extract(roots.root_key, '$[0]') <> 'object')
                OR SUM(rows.entity_kind = 'object'
                  AND rows.object_type_id = json_extract(roots.root_key, '$[1]')
                  AND rows.primary_id = json_extract(roots.root_key, '$[2]')) <> 1
                OR SUM(
                  (rows.entity_kind = 'object' AND (
                    rows.object_type_id <> json_extract(roots.root_key, '$[1]')
                    OR rows.primary_id <> json_extract(roots.root_key, '$[2]')))
                  OR (rows.entity_kind = 'link' AND (
                    rows.source_type_id <> json_extract(roots.root_key, '$[1]')
                    OR rows.source_primary_id <> json_extract(roots.root_key, '$[2]')))
                ) <> 0
                OR SUM(rows.entity_kind = 'link') <> COUNT(DISTINCT CASE
                  WHEN rows.entity_kind = 'link'
                  THEN json_array(rows.link_id, rows.target_type_id, rows.target_primary_id)
                END)
              LIMIT 1
            `
      )
      .get(manifest.version_id)
    if (invalid) {
      throw new MaterializationValidationError(
        manifest.projection_kind === "link"
          ? "Link projection roots must contain exactly their matching link assertion."
          : "Object projection roots must contain exactly their matching object assertion plus links sourced from that root."
      )
    }
  }

  /** Already staged assertions sharing a root or an ordinal with `rows`. */
  private findStageRows(
    manifest: SqliteOntologySourceRow,
    rows: readonly SourceStageRow[]
  ): readonly SourceStageRow[] {
    if (rows.length === 0) return []
    const rootKeys = [...new Set(rows.map((row) => row.rootKey))]
    const ordinals = [...new Set(rows.map((row) => row.row.stagingOrdinal))]
    // Two keyed lookups: an OR over both columns scans every root of the version per batch.
    const existing = this.db
      .query(
        `
          WITH selected AS (
            SELECT roots.id FROM json_each(?2) AS requested
            CROSS JOIN ontology_source_roots AS roots
              ON roots.version_id = ?1 AND roots.root_key = CAST(requested.value AS TEXT)
            UNION
            SELECT roots.id FROM json_each(?3) AS requested
            CROSS JOIN ontology_source_roots AS roots
              ON roots.version_id = ?1 AND roots.staging_ordinal = CAST(requested.value AS INTEGER)
          )
          SELECT ${SOURCE_ASSERTION_COLUMNS} FROM selected
          CROSS JOIN ontology_source_roots AS roots ON roots.id = selected.id
          CROSS JOIN ontology_sources AS versions ON versions.version_id = roots.version_id
          CROSS JOIN ontology_source_rows AS rows ON rows.root_id = roots.id
        `
      )
      .all(
        manifest.version_id,
        JSON.stringify(rootKeys),
        JSON.stringify(ordinals)
      ) as SqliteOntologySourceAssertionRow[]
    return existing.map((row) => sourceStageRow(sourceAssertion(row)))
  }

  private insertStageRows(
    manifest: SqliteOntologySourceRow,
    rows: readonly SourceStageRow[]
  ): void {
    if (rows.length === 0) return
    const payload = rows.map(({ rootKey, row }) => {
      const entity = entityColumns(row.assertion)
      return {
        rootKey,
        entityKind: row.assertion.kind,
        objectTypeId: entity.objectTypeId,
        primaryId: entity.primaryId,
        sourceTypeId: entity.sourceTypeId,
        sourcePrimaryId: entity.sourcePrimaryId,
        linkId: entity.linkId,
        targetTypeId: entity.targetTypeId,
        targetPrimaryId: entity.targetPrimaryId,
        payload: sourceAssertionPayload(row.assertion),
      }
    })
    const inserted = this.db
      .query(
        `
          WITH staged(value) AS (SELECT value FROM json_each(?))
          INSERT INTO ontology_source_rows (
            root_id, entity_kind, object_type_id, primary_id,
            source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, payload
          )
          SELECT roots.id, json_extract(value, '$.entityKind'),
            json_extract(value, '$.objectTypeId'), json_extract(value, '$.primaryId'),
            json_extract(value, '$.sourceTypeId'), json_extract(value, '$.sourcePrimaryId'),
            json_extract(value, '$.linkId'), json_extract(value, '$.targetTypeId'),
            json_extract(value, '$.targetPrimaryId'), json_extract(value, '$.payload')
          FROM staged
          CROSS JOIN ontology_source_roots AS roots
            ON roots.version_id = ? AND roots.root_key = json_extract(value, '$.rootKey')
        `
      )
      .run(canonicalJson(payload), manifest.version_id).changes
    if (inserted !== rows.length) {
      throw sourceConflict("Staged source rows do not all belong to a staged root.")
    }
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
