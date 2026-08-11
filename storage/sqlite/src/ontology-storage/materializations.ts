import type { Database } from "bun:sqlite"
import type {
  EffectiveChangeCounts,
  ExpectedLinkRevision,
  ExpectedObjectRevision,
} from "@sixb/core/internal/materialization"
import {
  assertPinnedDatasetWatermark,
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  MaterializationConflictError,
  objectRefKey,
  objectRefSortKey,
  telemetryPointKey,
  telemetryPointSortKey,
} from "@sixb/core/internal/materialization"
import {
  assertMaterializationFinalizationCorrelation,
  assertMaterializationHeader,
  assertMaterializationLaneCompletion,
  assertPageRows,
  assertPlanChunkCorrelations,
  assertSourceActivationCorrelation,
  invalidCorrelation,
  sameNonnegativeCounts as sameCounts,
  uniqueSorted,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  ApplyMaterializationChunkInput,
  ApplyMaterializationResult,
  FinalizeMaterializationInput,
  MaterializationObjectExistence,
  MaterializationPlanHeader,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationWorkPage,
  OntologyCommitRecord,
  OntologyMaterializationStorage,
  ReadMaterializationObjectExistenceInput,
  SourceActivationWrite,
  SourceReplacementStatePage,
  StageMaterializationWorkInput,
  StreamMaterializationStateInput,
  StreamMaterializationWorkInput,
  StreamSourceReplacementStateInput,
} from "@sixb/core/storage"
import { yieldSqliteEventLoop } from "../transactions"
import {
  type SqliteMaterializationSessionState,
  SqliteMaterializationSessions,
  type SqliteOntologyTransactionContext,
} from "./materialization-session"
import {
  linkSortExpression,
  SQLITE_MATERIALIZATION_WORK_TABLE,
  SqliteMaterializationStateReader,
} from "./materialization-state"
import { SqliteMaterializationWriter } from "./materialization-writer"
import {
  assertProjectionExecution,
  canonicalJson,
  commitRecord,
  isSqliteConstraintError,
  originColumns,
  requireChanges,
  type SqliteOntologyCommitRow,
  type SqliteOntologySourceRow,
} from "./shared"

export class SqliteOntologyMaterializationStorage implements OntologyMaterializationStorage {
  private readonly sessions: SqliteMaterializationSessions
  private readonly writer: SqliteMaterializationWriter

  constructor(
    private readonly db: Database,
    context: SqliteOntologyTransactionContext | null
  ) {
    this.sessions = new SqliteMaterializationSessions(db, context)
    this.writer = new SqliteMaterializationWriter(db)
  }

  async begin(input: MaterializationPlanHeader): Promise<MaterializationSession> {
    assertMaterializationHeader(input)
    const session = this.sessions.create(input)
    try {
      this.assertCommitAbsent(input)
      const reader = new SqliteMaterializationStateReader(this.db, input.commit.projectId)
      for (const expected of input.expected.sources)
        this.assertSource(expected, input.commit.projectId)
      for (const expected of input.expected.objects) this.assertObject(reader, expected)
      for (const expected of input.expected.links) this.assertLink(reader, expected)
      for (const expected of input.expected.linkScopes) {
        if (
          reader.linkScope(expected.source, expected.linkId).fingerprint !== expected.fingerprint
        ) {
          throw new MaterializationConflictError(
            "effective-state",
            `Expected link scope changed for ${expected.source.objectTypeId}:${expected.source.primaryId}.${expected.linkId}.`
          )
        }
      }
      for (const expected of input.expected.points) {
        const point = reader.exactPoint(expected.series, expected.at)
        if ((point?.lastCommitId ?? null) !== expected.lastCommitId) {
          throw new MaterializationConflictError(
            "timeseries-point",
            `Telemetry point ${telemetryPointKey(expected.series, expected.at)} changed.`
          )
        }
      }
      return session.publicSession()
    } catch (error) {
      this.sessions.release(session)
      throw error
    }
  }

  async *streamState(
    input: StreamMaterializationStateInput
  ): AsyncIterable<MaterializationStatePage> {
    const session = this.sessions.require(input.session)
    assertPageRows(input.pageRows)
    const reader = new SqliteMaterializationStateReader(this.db, session.header.commit.projectId)
    for await (const request of input.requests) {
      this.sessions.require(input.session)
      const objects = uniqueSorted(request.objects, objectRefKey, objectRefSortKey)
      for (let offset = 0; offset < objects.length; offset += input.pageRows) {
        const page = reader.objectStates(objects.slice(offset, offset + input.pageRows))
        yield { objects: page, links: [], linkScopes: [], points: [] }
      }
      const links = uniqueSorted(request.links, linkRefKey, linkRefSortKey)
      for (let offset = 0; offset < links.length; offset += input.pageRows) {
        const page = reader.linkStates(links.slice(offset, offset + input.pageRows))
        yield { objects: [], links: page, linkScopes: [], points: [] }
      }
      for (const refs of reader.incidentLinks(request.incidentObjects, input.pageRows)) {
        this.sessions.require(input.session)
        yield {
          objects: [],
          links: reader.linkStates(refs),
          linkScopes: [],
          points: [],
        }
      }
      const scopes = uniqueSorted(
        request.linkScopes,
        (scope) =>
          JSON.stringify([scope.source.objectTypeId, scope.source.primaryId, scope.linkId]),
        (scope) => linkScopeSortKey(scope.source, scope.linkId)
      )
      for (let offset = 0; offset < scopes.length; offset += input.pageRows) {
        yield {
          objects: [],
          links: [],
          linkScopes: reader.linkScopes(scopes.slice(offset, offset + input.pageRows)),
          points: [],
        }
      }
      const points = uniqueSorted(
        request.points,
        (point) => telemetryPointKey(point.series, point.at),
        (point) => telemetryPointSortKey(point.series, point.at)
      )
      for (let offset = 0; offset < points.length; offset += input.pageRows) {
        const page = reader.exactPoints(points.slice(offset, offset + input.pageRows))
        if (page.length > 0) yield { objects: [], links: [], linkScopes: [], points: page }
      }
    }
  }

  async *streamSourceReplacementState(
    input: StreamSourceReplacementStateInput
  ): AsyncIterable<SourceReplacementStatePage> {
    const session = this.sessions.require(input.session)
    assertPageRows(input.pageRows)
    const replacement = this.requireReplacement(session, input)
    const reader = new SqliteMaterializationStateReader(this.db, session.header.commit.projectId)
    if (input.entityKind === "object") {
      if (replacement.projectionKind !== "object") {
        throw new MaterializationConflictError(
          "source-materialization",
          "Link projection replacement cannot stream object state."
        )
      }
      if (replacement.objectStreamStarted) {
        throw new MaterializationConflictError(
          "effective-state",
          "Replacement object state may only be streamed once per session."
        )
      }
      replacement.objectStreamStarted = true
      for (const identities of reader.replacementIdentities({
        sessionId: session.id,
        sourceId: replacement.sourceId,
        candidateMaterializationId: replacement.candidateMaterializationId,
        previousMaterializationId: replacement.previousMaterializationId,
        kind: "object",
        pageRows: input.pageRows,
      })) {
        this.sessions.require(input.session)
        const refs = identities.map((identity) => {
          if (identity.kind !== "object") {
            invalidCorrelation("Object replacement returned a link identity.")
          }
          return identity.ref
        })
        const objects = reader.replacementObjectStates(
          replacement.sourceId,
          replacement.candidateMaterializationId,
          refs
        )
        yield { objects, links: [] }
      }
      this.sessions.require(input.session)
      replacement.objectStreamCompleted = true
      return
    }

    if (replacement.projectionKind === "object" && !replacement.objectStreamCompleted) {
      throw new MaterializationConflictError(
        "effective-state",
        "Object projection replacement must fully stream object state before link state."
      )
    }
    if (replacement.linkStreamStarted) {
      throw new MaterializationConflictError(
        "effective-state",
        "Replacement link state may only be streamed once per session."
      )
    }
    replacement.linkStreamStarted = true
    const materializationIds = [
      replacement.candidateMaterializationId,
      ...(replacement.previousMaterializationId ? [replacement.previousMaterializationId] : []),
    ]
    for (const identities of reader.replacementIdentities({
      sessionId: session.id,
      sourceId: replacement.sourceId,
      candidateMaterializationId: replacement.candidateMaterializationId,
      previousMaterializationId: replacement.previousMaterializationId,
      kind: "link",
      pageRows: input.pageRows,
    })) {
      this.sessions.require(input.session)
      const linkIdentities = identities.map((identity) => {
        if (identity.kind !== "link") {
          invalidCorrelation("Link replacement returned an object identity.")
        }
        return identity
      })
      const links = reader.replacementLinkStates(
        replacement.sourceId,
        replacement.candidateMaterializationId,
        materializationIds,
        linkIdentities
      )
      yield { objects: [], links }
    }
    this.sessions.require(input.session)
    replacement.linkStreamCompleted = true
  }

  async stageWork(input: StageMaterializationWorkInput): Promise<void> {
    this.sessions.stage(input)
    await yieldSqliteEventLoop()
  }

  streamWork(input: StreamMaterializationWorkInput): AsyncIterable<MaterializationWorkPage> {
    assertPageRows(input.pageRows)
    return this.sessions.stream(input)
  }

  async readObjectExistence(
    input: ReadMaterializationObjectExistenceInput
  ): Promise<readonly MaterializationObjectExistence[]> {
    const session = this.sessions.require(input.session)
    return this.sessions.readObjectExistence(session, input.refs)
  }

  async applyChunk(input: ApplyMaterializationChunkInput): Promise<void> {
    const session = this.sessions.require(input.session)
    const { commit } = session.header
    assertPlanChunkCorrelations(input.chunk, commit)
    const planCount = session.appliedPlanCount
    const outboxCount = session.appliedOutboxCount
    this.sessions.assertChunkSequence(session, input.chunk)
    this.db.run("SAVEPOINT sixb_ontology_apply_chunk")
    try {
      this.writer.apply(commit.projectId, commit.id, input.chunk)
      this.db.run("RELEASE SAVEPOINT sixb_ontology_apply_chunk")
    } catch (error) {
      this.db.run("ROLLBACK TO SAVEPOINT sixb_ontology_apply_chunk")
      this.db.run("RELEASE SAVEPOINT sixb_ontology_apply_chunk")
      session.appliedPlanCount = planCount
      session.appliedOutboxCount = outboxCount
      throw error
    }
    await yieldSqliteEventLoop()
  }

  async finalize(input: FinalizeMaterializationInput): Promise<ApplyMaterializationResult> {
    const session = this.sessions.require(input.session)
    this.assertCommitAbsent(session.header)
    await this.assertFinalization(session, input)
    for (const activation of input.finalization.sourceActivations) {
      this.activateSource(session, activation)
    }
    const record = this.insertCommit(session.header, input)
    this.sessions.release(session)
    return { commit: record }
  }

  deactivateSessions(): void {
    this.sessions.deactivateAll()
  }

  private requireReplacement(
    session: SqliteMaterializationSessionState,
    input: StreamSourceReplacementStateInput
  ): NonNullable<SqliteMaterializationSessionState["replacement"]> {
    if (session.replacement) {
      if (
        session.replacement.sourceId !== input.source.projectionId ||
        session.replacement.candidateMaterializationId !== input.candidateMaterializationId
      ) {
        throw new MaterializationConflictError(
          "source-materialization",
          "Materialization session already owns another replacement union."
        )
      }
      return session.replacement
    }
    const projectId = session.header.commit.projectId
    const candidate = this.getSource(
      projectId,
      input.source.projectionId,
      input.candidateMaterializationId
    )
    if (!candidate || candidate.status !== "ready" || candidate.execution_token === null) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Candidate source materialization '${input.candidateMaterializationId}' is missing or is not ready.`
      )
    }
    assertProjectionExecution(this.db, {
      projectId,
      sourceId: input.source.projectionId,
      projectionRunId: candidate.projection_run_id,
      executionToken: candidate.execution_token,
    })
    const previous = this.getActiveSource(projectId, input.source.projectionId)
    if (
      candidate.protocol !== "replacement" ||
      (previous &&
        (previous.protocol !== candidate.protocol ||
          previous.projection_kind !== candidate.projection_kind))
    ) {
      throw new MaterializationConflictError(
        "source-materialization",
        "Source replacement kind or protocol does not match its active materialization."
      )
    }
    session.replacement = {
      sourceId: input.source.projectionId,
      candidateMaterializationId: input.candidateMaterializationId,
      previousMaterializationId: previous?.materialization_id ?? null,
      projectionKind: candidate.projection_kind,
      objectStreamStarted: false,
      objectStreamCompleted: false,
      linkStreamStarted: false,
      linkStreamCompleted: false,
    }
    return session.replacement
  }

  private assertCommitAbsent(header: MaterializationPlanHeader): void {
    const origin = originColumns(header.commit.origin)
    const duplicate = this.db
      .query(
        `
          SELECT CASE
            WHEN id = ? THEN 'id'
            WHEN idempotency_key = ? THEN 'idempotency'
            ELSE 'origin'
          END AS duplicate
          FROM ontology_commits
          WHERE project_id = ? AND (
            id = ? OR idempotency_key = ? OR (
              ? IS NOT NULL AND origin_kind = ? AND origin_run_id = ?
              AND (origin_batch_ordinal IS ? OR origin_batch_ordinal = ?)
            )
          )
          LIMIT 1
        `
      )
      .get(
        header.commit.id,
        header.commit.idempotencyKey,
        header.commit.projectId,
        header.commit.id,
        header.commit.idempotencyKey,
        origin.runId,
        origin.kind,
        origin.runId,
        origin.batchOrdinal,
        origin.batchOrdinal
      ) as { readonly duplicate: "id" | "idempotency" | "origin" } | null
    if (!duplicate) return
    if (duplicate.duplicate === "origin") {
      throw new MaterializationConflictError(
        "run-correlation",
        "Ontology commit origin already has an authoritative commit."
      )
    }
    throw new MaterializationConflictError(
      "idempotency",
      duplicate.duplicate === "id"
        ? `Ontology commit '${header.commit.id}' already exists.`
        : "Ontology idempotency key already exists."
    )
  }

  private assertSource(
    expected: MaterializationPlanHeader["expected"]["sources"][number],
    projectId: string
  ): void {
    const active = this.getActiveSource(projectId, expected.source.projectionId)
    if (
      (active?.materialization_id ?? null) !== expected.activeMaterializationId ||
      (active?.last_commit_id ?? null) !== expected.lastCommitId
    ) {
      throw new MaterializationConflictError(
        "projection-fence",
        `Source '${expected.source.projectionId}' changed.`
      )
    }
  }

  private assertObject(
    reader: SqliteMaterializationStateReader,
    expected: ExpectedObjectRevision
  ): void {
    const row = reader.effectiveObjectRevision(expected.ref)
    if (!expected.exists) {
      if (row) {
        throw new MaterializationConflictError(
          "effective-state",
          `Expected object ${objectRefKey(expected.ref)} to be absent.`
        )
      }
      return
    }
    if (!row || row.version !== expected.version || row.lastCommitId !== expected.lastCommitId) {
      throw new MaterializationConflictError(
        "effective-state",
        `Expected object ${objectRefKey(expected.ref)} changed.`
      )
    }
  }

  private assertLink(
    reader: SqliteMaterializationStateReader,
    expected: ExpectedLinkRevision
  ): void {
    const lastCommitId = reader.effectiveLinkLastCommit(expected.ref)
    if (!expected.exists) {
      if (lastCommitId !== undefined) {
        throw new MaterializationConflictError(
          "effective-state",
          `Expected link ${linkRefKey(expected.ref)} to be absent.`
        )
      }
      return
    }
    if (lastCommitId === undefined || lastCommitId !== expected.lastCommitId) {
      throw new MaterializationConflictError(
        "effective-state",
        `Expected link ${linkRefKey(expected.ref)} changed.`
      )
    }
  }

  private async assertFinalization(
    session: SqliteMaterializationSessionState,
    input: FinalizeMaterializationInput
  ): Promise<void> {
    const { commit } = session.header
    const { result } = input.finalization
    assertMaterializationFinalizationCorrelation(session, input)
    const laneCounts = this.sessions.laneCounts(session)
    assertMaterializationLaneCompletion(session, laneCounts)
    this.assertFinalCardinality(session)
    await yieldSqliteEventLoop()
    const eventCount = laneCounts.event
    const outbox = this.db
      .query(
        `
          SELECT COUNT(*) AS count, MIN(commit_ordinal) AS minimum, MAX(commit_ordinal) AS maximum
          FROM ontology_outbox WHERE project_id = ? AND commit_id = ?
        `
      )
      .get(commit.projectId, commit.id) as {
      readonly count: number
      readonly minimum: number | null
      readonly maximum: number | null
    }
    if (
      outbox.count !== eventCount ||
      (eventCount > 0 && (outbox.minimum !== 0 || outbox.maximum !== eventCount - 1))
    ) {
      invalidCorrelation("Outbox event ordinals must be contiguous from zero.")
    }
    await yieldSqliteEventLoop()

    if (commit.intent.kind === "telemetry") {
      const summary = this.telemetrySummary(session, commit.intent.pointCount)
      await yieldSqliteEventLoop()
      if (summary.classifiedPoints !== commit.intent.pointCount) {
        invalidCorrelation(
          "Telemetry point classification coverage does not match the commit intent."
        )
      }
      if (result.kind !== "telemetry" || !sameCounts(result, summary.counts)) {
        invalidCorrelation("Telemetry result counts do not correlate with finalized work.")
      }
    }
    if (commit.intent.kind === "projection") {
      if (result.kind !== "projection") return
      this.sessions.assertClassificationCoverage(session)
      await yieldSqliteEventLoop()
      const counts = this.projectionCounts(session)
      await yieldSqliteEventLoop()
      if (!sameCounts(result.counts, counts)) {
        invalidCorrelation("Projection result counts do not correlate with finalized work.")
      }
    }
  }

  private assertFinalCardinality(session: SqliteMaterializationSessionState): void {
    const violation = this.db
      .query(
        `
          WITH work AS (
            SELECT json_extract(payload, '$.scopeSortKey') AS scope_sort_key,
              json_extract(payload, '$.linkSortKey') AS link_sort_key,
              json_extract(payload, '$.occupied') AS occupied,
              json_extract(payload, '$.ref.source.objectTypeId') AS source_type_id,
              json_extract(payload, '$.ref.source.primaryId') AS source_id,
              json_extract(payload, '$.ref.linkId') AS link_id
            FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
            WHERE session_id = ? AND kind = 'cardinality'
          ), duplicate AS (
            SELECT scope_sort_key FROM work WHERE occupied = 1
            GROUP BY scope_sort_key HAVING COUNT(*) > 1
          ), scopes AS (
            SELECT DISTINCT scope_sort_key, source_type_id, source_id, link_id FROM work
          ), expected AS (
            SELECT scope_sort_key, link_sort_key FROM work WHERE occupied = 1
          ), actual AS (
            SELECT scopes.scope_sort_key,
              ${linkSortExpression("links")} AS link_sort_key
            FROM scopes
            -- json-derived temp scopes have no useful cardinality estimate. Fixing them on the
            -- outer side keeps each lookup on the complete links primary-key prefix.
            CROSS JOIN links
              ON links.project_id = ?
             AND links.source_type_id = scopes.source_type_id
             AND links.source_id = scopes.source_id
             AND links.link_id = scopes.link_id
          ), differences AS (
            SELECT * FROM expected EXCEPT SELECT * FROM actual
            UNION ALL
            SELECT * FROM actual EXCEPT SELECT * FROM expected
          )
          SELECT 'duplicate' AS reason FROM duplicate
          UNION ALL
          SELECT 'mismatch' AS reason FROM differences
          LIMIT 1
        `
      )
      .get(session.id, session.header.commit.projectId) as {
      readonly reason: "duplicate" | "mismatch"
    } | null
    if (violation?.reason === "duplicate") {
      invalidCorrelation("Materialization cardinality work violates cardinality-one.")
    }
    if (violation) {
      invalidCorrelation(
        "Materialization cardinality work does not match the final effective link scope."
      )
    }
  }

  private projectionCounts(session: SqliteMaterializationSessionState): EffectiveChangeCounts {
    const row = this.db
      .query(
        `
          SELECT
            COUNT(*) FILTER (
              WHERE kind = 'classification'
                AND unique_key LIKE 'classification:object:%'
            ) AS object_classifications,
            COUNT(*) FILTER (
              WHERE kind = 'classification'
                AND unique_key LIKE 'classification:link:%'
            ) AS link_classifications,
            COUNT(*) FILTER (
              WHERE kind = 'plan'
                AND json_extract(payload, '$.item.kind') = 'object-upsert'
                AND json_extract(payload, '$.item.value.expected.exists') = 0
            ) AS objects_created,
            COUNT(*) FILTER (
              WHERE kind = 'plan'
                AND json_extract(payload, '$.item.kind') = 'object-upsert'
                AND json_extract(payload, '$.item.value.expected.exists') = 1
            ) AS objects_updated,
            COUNT(*) FILTER (
              WHERE kind = 'plan'
                AND json_extract(payload, '$.item.kind') = 'object-delete'
            ) AS objects_deleted,
            COUNT(*) FILTER (
              WHERE kind = 'plan'
                AND json_extract(payload, '$.item.kind') = 'link-upsert'
                AND json_extract(payload, '$.item.value.expected.exists') = 0
            ) AS links_created,
            COUNT(*) FILTER (
              WHERE kind = 'plan'
                AND json_extract(payload, '$.item.kind') = 'link-upsert'
                AND json_extract(payload, '$.item.value.expected.exists') = 1
            ) AS links_updated,
            COUNT(*) FILTER (
              WHERE kind = 'plan'
                AND json_extract(payload, '$.item.kind') = 'link-delete'
            ) AS links_deleted
          FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
          WHERE session_id = ?
        `
      )
      .get(session.id) as ProjectionCountsRow
    const objectsChanged = row.objects_created + row.objects_updated + row.objects_deleted
    const linksChanged = row.links_created + row.links_updated + row.links_deleted
    return {
      objectsCreated: row.objects_created,
      objectsUpdated: row.objects_updated,
      objectsDeleted: row.objects_deleted,
      objectsUnchanged: row.object_classifications - objectsChanged,
      linksCreated: row.links_created,
      linksUpdated: row.links_updated,
      linksDeleted: row.links_deleted,
      linksUnchanged: row.link_classifications - linksChanged,
    }
  }

  private telemetrySummary(session: SqliteMaterializationSessionState, pointCount: number) {
    const row = this.db
      .query(
        `
          SELECT
            COUNT(*) FILTER (
              WHERE kind = 'classification'
                AND unique_key LIKE 'classification:point:%'
            ) AS classified_points,
            COUNT(*) FILTER (
              WHERE kind = 'plan'
                AND json_extract(payload, '$.item.kind') = 'point-upsert'
                AND json_extract(payload, '$.item.value.expected.lastCommitId') IS NULL
            ) AS points_created,
            COUNT(*) FILTER (
              WHERE kind = 'plan'
                AND json_extract(payload, '$.item.kind') = 'point-upsert'
                AND json_extract(payload, '$.item.value.expected.lastCommitId') IS NOT NULL
            ) AS points_updated,
            COUNT(*) FILTER (
              WHERE kind = 'plan'
                AND json_extract(payload, '$.item.kind') = 'object-upsert'
            ) AS latest_objects_changed
          FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
          WHERE session_id = ?
        `
      )
      .get(session.id) as TelemetrySummaryRow
    return {
      classifiedPoints: row.classified_points,
      counts: {
        pointsCreated: row.points_created,
        pointsUpdated: row.points_updated,
        pointsUnchanged: pointCount - row.points_created - row.points_updated,
        latestObjectsChanged: row.latest_objects_changed,
      },
    }
  }

  private activateSource(
    session: SqliteMaterializationSessionState,
    activation: SourceActivationWrite
  ): void {
    const { commit } = session.header
    assertSourceActivationCorrelation(session, activation)
    const candidate = this.getSource(
      commit.projectId,
      activation.source.projectionId,
      activation.materializationId
    )
    if (!candidate || candidate.status !== "ready" || candidate.execution_token === null) {
      throw new MaterializationConflictError(
        "source-materialization",
        "Source activation candidate is missing or is not ready."
      )
    }
    assertProjectionExecution(this.db, {
      projectId: commit.projectId,
      sourceId: activation.source.projectionId,
      projectionRunId: activation.execution.projectionRunId,
      executionToken: activation.execution.executionToken,
    })
    if (
      candidate.projection_run_id !== activation.execution.projectionRunId ||
      candidate.execution_token !== activation.execution.executionToken ||
      candidate.projection_kind !== activation.projectionKind ||
      candidate.protocol !== activation.protocol ||
      candidate.dataset_id !== activation.datasetVersion.datasetId ||
      candidate.dataset_version_id !== activation.datasetVersion.versionId ||
      candidate.dataset_version_created_at !== activation.datasetVersion.createdAt ||
      candidate.projection_revision !== activation.projectionRevision ||
      candidate.ownership_hash !== activation.ownershipHash ||
      candidate.ontology_revision !== activation.ontologyRevision ||
      candidate.ready_at === null ||
      activation.updatedAt < candidate.ready_at
    ) {
      invalidCorrelation("Source activation does not match its ready candidate identity.")
    }
    this.assertSource(activation.expected, commit.projectId)
    const previous = this.getActiveSource(commit.projectId, activation.source.projectionId)
    if (previous) {
      assertPinnedDatasetWatermark(
        {
          datasetId: previous.dataset_id,
          versionId: previous.dataset_version_id,
          createdAt: previous.dataset_version_created_at,
        },
        activation.datasetVersion,
        "Source activation"
      )
      if (activation.updatedAt < previous.updated_at) {
        invalidCorrelation("Source activation cannot precede the active materialization update.")
      }
      requireChanges(
        this.db
          .query(
            `
              UPDATE ontology_sources
              SET status = 'superseded', execution_token = NULL, terminal_at = ?, updated_at = ?
              WHERE project_id = ? AND source_id = ? AND materialization_id = ?
                AND status = 'active' AND last_commit_id = ?
            `
          )
          .run(
            activation.updatedAt,
            activation.updatedAt,
            commit.projectId,
            activation.source.projectionId,
            previous.materialization_id,
            activation.expected.lastCommitId
          ).changes,
        "projection-fence",
        `Source '${activation.source.projectionId}' changed.`
      )
    }
    requireChanges(
      this.db
        .query(
          `
            UPDATE ontology_sources
            SET status = 'active', execution_token = NULL, activated_at = ?,
              last_commit_id = ?, updated_at = ?
            WHERE project_id = ? AND source_id = ? AND materialization_id = ?
              AND status = 'ready' AND execution_token = ?
          `
        )
        .run(
          activation.updatedAt,
          activation.lastCommitId,
          activation.updatedAt,
          commit.projectId,
          activation.source.projectionId,
          activation.materializationId,
          activation.execution.executionToken
        ).changes,
      "source-materialization",
      "Source activation candidate changed."
    )
  }

  private insertCommit(
    header: MaterializationPlanHeader,
    input: FinalizeMaterializationInput
  ): OntologyCommitRecord {
    const { commit } = header
    const origin = originColumns(commit.origin)
    try {
      this.db
        .query(
          `
            INSERT INTO ontology_commits (
              project_id, id, idempotency_key, request_hash,
              origin_kind, origin_run_id, origin_batch_ordinal, origin, actor,
              ontology_revision, projection_revision, ownership_hash,
              intent, result, committed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, json(?), json(?), ?, ?, ?, json(?), json(?), ?)
          `
        )
        .run(
          commit.projectId,
          commit.id,
          commit.idempotencyKey,
          commit.requestHash,
          origin.kind,
          origin.runId,
          origin.batchOrdinal,
          canonicalJson(commit.origin),
          commit.actor === undefined ? null : canonicalJson(commit.actor),
          commit.ontologyRevision,
          commit.projectionRevision ?? null,
          commit.ownershipHash ?? null,
          canonicalJson(commit.intent),
          canonicalJson(input.finalization.result),
          commit.committedAt
        )
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw new MaterializationConflictError(
          "idempotency",
          "Ontology commit identity already exists."
        )
      }
      throw error
    }
    const row = this.db
      .query("SELECT * FROM ontology_commits WHERE project_id = ? AND id = ?")
      .get(commit.projectId, commit.id) as SqliteOntologyCommitRow
    return commitRecord(row)
  }

  private getActiveSource(projectId: string, sourceId: string): SqliteOntologySourceRow | null {
    return this.db
      .query(
        `SELECT * FROM ontology_sources
         WHERE project_id = ? AND source_id = ? AND status = 'active'`
      )
      .get(projectId, sourceId) as SqliteOntologySourceRow | null
  }

  private getSource(
    projectId: string,
    sourceId: string,
    materializationId: string
  ): SqliteOntologySourceRow | null {
    return this.db
      .query(
        `SELECT * FROM ontology_sources
         WHERE project_id = ? AND source_id = ? AND materialization_id = ?`
      )
      .get(projectId, sourceId, materializationId) as SqliteOntologySourceRow | null
  }
}

interface ProjectionCountsRow {
  readonly object_classifications: number
  readonly link_classifications: number
  readonly objects_created: number
  readonly objects_updated: number
  readonly objects_deleted: number
  readonly links_created: number
  readonly links_updated: number
  readonly links_deleted: number
}

interface TelemetrySummaryRow {
  readonly classified_points: number
  readonly points_created: number
  readonly points_updated: number
  readonly latest_objects_changed: number
}
