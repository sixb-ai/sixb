import type { Database } from "bun:sqlite"
import { stableJsonStringify } from "@sixb/core"
import type {
  EffectiveChangeCounts,
  ExpectedLinkRevision,
  ExpectedObjectRevision,
  OntologyLinkRef,
  OntologyObjectRef,
} from "@sixb/core/internal/materializer"
import {
  assertPinnedDatasetWatermark,
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  MaterializationConflictError,
  objectRefKey,
  objectRefSortKey,
  projectionEntityKey,
  telemetryPointKey,
  telemetryPointSortKey,
} from "@sixb/core/internal/materializer"
import {
  assertMaterializationFinalizationCorrelation,
  assertMaterializationHeader,
  assertMaterializationLaneCompletion,
  assertPageRows,
  assertPlanChunkCorrelations,
  assertSourceActivationCorrelation,
  effectiveConflict,
  invalidCorrelation,
  type OverrideEntity,
  overrideEntityColumns as overrideColumns,
  sameNonnegativeCounts as sameCounts,
  uniqueSorted,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  ApplyMaterializationChunkInput,
  ApplyMaterializationResult,
  ExactEffectiveLinkWrite,
  ExactEffectiveObjectWrite,
  FinalizeMaterializationInput,
  MaterializationCardinalityOccupantWorkRecord,
  MaterializationClassificationWorkRecord,
  MaterializationObjectExistence,
  MaterializationPlanHeader,
  MaterializationPlanWorkRecord,
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
import {
  assertProjectionExecution,
  assertTimestamp,
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

  constructor(
    private readonly db: Database,
    context: SqliteOntologyTransactionContext | null
  ) {
    this.sessions = new SqliteMaterializationSessions(db, context)
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
        const page = objects
          .slice(offset, offset + input.pageRows)
          .map((ref) => reader.objectState(ref))
        yield { objects: page, links: [], linkScopes: [], points: [] }
      }
      const links = uniqueSorted(request.links, linkRefKey, linkRefSortKey)
      for (let offset = 0; offset < links.length; offset += input.pageRows) {
        const page = links
          .slice(offset, offset + input.pageRows)
          .map((ref) => reader.linkState(ref))
        yield { objects: [], links: page, linkScopes: [], points: [] }
      }
      for (const refs of reader.incidentLinks(request.incidentObjects, input.pageRows)) {
        this.sessions.require(input.session)
        yield {
          objects: [],
          links: refs.map((ref) => reader.linkState(ref)),
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
      for (const scope of scopes) {
        yield {
          objects: [],
          links: [],
          linkScopes: [reader.linkScope(scope.source, scope.linkId)],
          points: [],
        }
      }
      const points = uniqueSorted(
        request.points,
        (point) => telemetryPointKey(point.series, point.at),
        (point) => telemetryPointSortKey(point.series, point.at)
      )
      for (let offset = 0; offset < points.length; offset += input.pageRows) {
        const page = points.slice(offset, offset + input.pageRows).flatMap((point) => {
          const stored = reader.exactPoint(point.series, point.at)
          return stored ? [stored] : []
        })
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
        this.sessions.recordReplacementIdentities(session, identities)
        yield {
          objects: identities.map((identity) =>
            reader.replacementObjectState(
              replacement.sourceId,
              replacement.candidateMaterializationId,
              identity.ref as OntologyObjectRef
            )
          ),
          links: [],
        }
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
      this.sessions.recordReplacementIdentities(session, identities)
      yield {
        objects: [],
        links: identities.map((identity) => {
          const ref = identity.ref as OntologyLinkRef
          return reader.replacementLinkState(
            replacement.sourceId,
            replacement.candidateMaterializationId,
            ref,
            identity.diffRequired,
            reader.sourceOwnsEntity(
              replacement.sourceId,
              materializationIds,
              projectionEntityKey({ kind: "link", ref })
            )
          )
        }),
      }
    }
    this.sessions.require(input.session)
    replacement.linkStreamCompleted = true
  }

  async stageWork(input: StageMaterializationWorkInput): Promise<void> {
    this.sessions.stage(input)
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
      this.applyOverrides(commit.projectId, input.chunk)
      this.applyEffective(commit.projectId, input.chunk)
      this.applyTimeseries(commit.projectId, input.chunk)
      this.applyOutbox(commit.projectId, commit.id, input.chunk)
      this.db.run("RELEASE SAVEPOINT sixb_ontology_apply_chunk")
    } catch (error) {
      this.db.run("ROLLBACK TO SAVEPOINT sixb_ontology_apply_chunk")
      this.db.run("RELEASE SAVEPOINT sixb_ontology_apply_chunk")
      session.appliedPlanCount = planCount
      session.appliedOutboxCount = outboxCount
      throw error
    }
  }

  async finalize(input: FinalizeMaterializationInput): Promise<ApplyMaterializationResult> {
    const session = this.sessions.require(input.session)
    this.assertCommitAbsent(session.header)
    this.assertFinalization(session, input)
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

  private applyOverrides(projectId: string, chunk: ApplyMaterializationChunkInput["chunk"]): void {
    const upsert = (
      entity: OverrideEntity,
      item:
        | (typeof chunk.overrides.objectUpserts)[number]
        | (typeof chunk.overrides.linkUpserts)[number]
    ): void => {
      const kind = entity.kind
      const key = kind === "object" ? objectRefKey(entity.ref) : linkRefKey(entity.ref)
      const columns = overrideColumns(entity)
      if (item.expectedLastCommitId === null) {
        try {
          this.db
            .query(
              `
                INSERT INTO ontology_overrides (
                  project_id, entity_kind, entity_key, entity_sort_key,
                  object_type_id, primary_id, source_type_id, source_primary_id,
                  link_id, target_type_id, target_primary_id,
                  value, last_commit_id, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?), ?, ?)
              `
            )
            .run(
              projectId,
              kind,
              key,
              columns.sortKey,
              columns.objectTypeId,
              columns.primaryId,
              columns.sourceTypeId,
              columns.sourcePrimaryId,
              columns.linkId,
              columns.targetTypeId,
              columns.targetPrimaryId,
              canonicalJson(item.value),
              item.lastCommitId,
              item.updatedAt
            )
        } catch (error) {
          if (isSqliteConstraintError(error))
            throw effectiveConflict(`Expected ${kind} override changed.`)
          throw error
        }
      } else {
        requireChanges(
          this.db
            .query(
              `
                UPDATE ontology_overrides
                SET value = json(?), last_commit_id = ?, updated_at = ?
                WHERE project_id = ? AND entity_kind = ? AND entity_key = ?
                  AND last_commit_id = ?
              `
            )
            .run(
              canonicalJson(item.value),
              item.lastCommitId,
              item.updatedAt,
              projectId,
              kind,
              key,
              item.expectedLastCommitId
            ).changes,
          "effective-state",
          `Expected ${kind} override changed.`
        )
      }
    }
    for (const item of chunk.overrides.objectUpserts) {
      upsert({ kind: "object", ref: item.ref }, item)
    }
    for (const item of chunk.overrides.objectDeletes) {
      requireChanges(
        this.db
          .query(
            `DELETE FROM ontology_overrides
             WHERE project_id = ? AND entity_kind = 'object' AND entity_key = ? AND last_commit_id = ?`
          )
          .run(projectId, objectRefKey(item.ref), item.expectedLastCommitId).changes,
        "effective-state",
        "Expected object override changed."
      )
    }
    for (const item of chunk.overrides.linkUpserts) {
      upsert({ kind: "link", ref: item.ref }, item)
    }
    for (const item of chunk.overrides.linkDeletes) {
      requireChanges(
        this.db
          .query(
            `DELETE FROM ontology_overrides
             WHERE project_id = ? AND entity_kind = 'link' AND entity_key = ? AND last_commit_id = ?`
          )
          .run(projectId, linkRefKey(item.ref), item.expectedLastCommitId).changes,
        "effective-state",
        "Expected link override changed."
      )
    }
  }

  private applyEffective(projectId: string, chunk: ApplyMaterializationChunkInput["chunk"]): void {
    for (const item of chunk.effective.linkDeletes) {
      requireChanges(
        this.db
          .query(
            `
              DELETE FROM links
              WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?
                AND target_type_id = ? AND target_id = ? AND last_commit_id = ?
            `
          )
          .run(
            projectId,
            item.ref.source.objectTypeId,
            item.ref.source.primaryId,
            item.ref.linkId,
            item.ref.target.objectTypeId,
            item.ref.target.primaryId,
            item.expected.lastCommitId
          ).changes,
        "effective-state",
        `Expected link ${linkRefKey(item.ref)} changed.`
      )
    }
    for (const item of chunk.effective.objectDeletes) {
      requireChanges(
        this.db
          .query(
            `DELETE FROM objects
             WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
               AND version = ? AND last_commit_id = ?`
          )
          .run(
            projectId,
            item.ref.objectTypeId,
            item.ref.primaryId,
            item.expected.version,
            item.expected.lastCommitId
          ).changes,
        "effective-state",
        `Expected object ${objectRefKey(item.ref)} changed.`
      )
    }
    for (const item of chunk.effective.objectUpserts) this.applyObject(projectId, item)
    for (const item of chunk.effective.linkUpserts) this.applyLink(projectId, item)
  }

  private applyObject(projectId: string, item: ExactEffectiveObjectWrite): void {
    const { row, expected } = item
    if (!expected.exists) {
      try {
        this.db
          .query(
            `
              INSERT INTO objects (
                project_id, object_type_id, primary_id, properties, created_at,
                updated_at, version, source_event_id, last_commit_id
              ) VALUES (?, ?, ?, json(?), ?, ?, ?, NULL, ?)
            `
          )
          .run(
            projectId,
            row.ref.objectTypeId,
            row.ref.primaryId,
            canonicalJson(row.properties),
            row.createdAt,
            row.updatedAt,
            row.version,
            row.lastCommitId
          )
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw effectiveConflict(`Expected object ${objectRefKey(row.ref)} to be absent.`)
        }
        throw error
      }
      return
    }
    requireChanges(
      this.db
        .query(
          `
            UPDATE objects
            SET properties = json(?), created_at = ?, updated_at = ?, version = ?,
              source_event_id = NULL, last_commit_id = ?
            WHERE project_id = ? AND object_type_id = ? AND primary_id = ?
              AND version = ? AND last_commit_id = ?
          `
        )
        .run(
          canonicalJson(row.properties),
          row.createdAt,
          row.updatedAt,
          row.version,
          row.lastCommitId,
          projectId,
          row.ref.objectTypeId,
          row.ref.primaryId,
          expected.version,
          expected.lastCommitId
        ).changes,
      "effective-state",
      `Expected object ${objectRefKey(row.ref)} changed.`
    )
  }

  private applyLink(projectId: string, item: ExactEffectiveLinkWrite): void {
    const { row, expected } = item
    if (!expected.exists) {
      try {
        this.db
          .query(
            `
              INSERT INTO links (
                project_id, source_type_id, source_id, link_id, target_type_id, target_id,
                properties, created_at, updated_at, source_event_id, last_commit_id
              ) VALUES (?, ?, ?, ?, ?, ?, json(?), ?, ?, NULL, ?)
            `
          )
          .run(
            projectId,
            row.ref.source.objectTypeId,
            row.ref.source.primaryId,
            row.ref.linkId,
            row.ref.target.objectTypeId,
            row.ref.target.primaryId,
            row.properties === undefined ? null : canonicalJson(row.properties),
            row.createdAt,
            row.updatedAt,
            row.lastCommitId
          )
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw effectiveConflict(`Expected link ${linkRefKey(row.ref)} to be absent.`)
        }
        throw error
      }
      return
    }
    requireChanges(
      this.db
        .query(
          `
            UPDATE links
            SET properties = json(?), created_at = ?, updated_at = ?,
              source_event_id = NULL, last_commit_id = ?
            WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?
              AND target_type_id = ? AND target_id = ? AND last_commit_id = ?
          `
        )
        .run(
          row.properties === undefined ? null : canonicalJson(row.properties),
          row.createdAt,
          row.updatedAt,
          row.lastCommitId,
          projectId,
          row.ref.source.objectTypeId,
          row.ref.source.primaryId,
          row.ref.linkId,
          row.ref.target.objectTypeId,
          row.ref.target.primaryId,
          expected.lastCommitId
        ).changes,
      "effective-state",
      `Expected link ${linkRefKey(row.ref)} changed.`
    )
  }

  private applyTimeseries(projectId: string, chunk: ApplyMaterializationChunkInput["chunk"]): void {
    for (const item of chunk.timeseries.pointUpserts) {
      const { point, expected } = item
      if (expected.lastCommitId === null) {
        try {
          this.db
            .query(
              `
                INSERT INTO timeseries (
                  project_id, object_type_id, object_id, property_id,
                  value, unit, at, source_event_id, last_commit_id
                ) VALUES (?, ?, ?, ?, json(?), ?, ?, NULL, ?)
              `
            )
            .run(
              projectId,
              point.series.object.objectTypeId,
              point.series.object.primaryId,
              point.series.propertyId,
              canonicalJson(point.value),
              point.unit ?? null,
              point.at,
              point.lastCommitId
            )
        } catch (error) {
          if (isSqliteConstraintError(error)) {
            throw new MaterializationConflictError(
              "timeseries-point",
              `Telemetry point ${telemetryPointKey(point.series, point.at)} changed.`
            )
          }
          throw error
        }
      } else {
        requireChanges(
          this.db
            .query(
              `
                UPDATE timeseries
                SET value = json(?), unit = ?, source_event_id = NULL, last_commit_id = ?
                WHERE project_id = ? AND object_type_id = ? AND object_id = ?
                  AND property_id = ? AND at = ? AND last_commit_id = ?
              `
            )
            .run(
              canonicalJson(point.value),
              point.unit ?? null,
              point.lastCommitId,
              projectId,
              point.series.object.objectTypeId,
              point.series.object.primaryId,
              point.series.propertyId,
              point.at,
              expected.lastCommitId
            ).changes,
          "timeseries-point",
          `Telemetry point ${telemetryPointKey(point.series, point.at)} changed.`
        )
      }
    }
  }

  private applyOutbox(
    projectId: string,
    commitId: string,
    chunk: ApplyMaterializationChunkInput["chunk"]
  ): void {
    const insert = this.db.query(
      `
        INSERT INTO ontology_outbox (
          project_id, id, commit_id, commit_ordinal, envelope,
          available_at, attempts, lease_id, lease_expires_at,
          published_at, last_error, created_at
        ) VALUES (?, ?, ?, ?, json(?), ?, 0, NULL, NULL, NULL, NULL, ?)
      `
    )
    for (const item of chunk.outbox) {
      assertTimestamp(item.availableAt, "Outbox availableAt")
      assertTimestamp(item.createdAt, "Outbox createdAt")
      try {
        insert.run(
          projectId,
          item.envelope.id,
          commitId,
          item.envelope.commitOrdinal,
          canonicalJson(item.envelope),
          item.availableAt,
          item.createdAt
        )
      } catch (error) {
        if (isSqliteConstraintError(error)) {
          throw effectiveConflict(`Duplicate outbox event '${item.envelope.id}'.`)
        }
        throw error
      }
    }
  }

  private assertFinalization(
    session: SqliteMaterializationSessionState,
    input: FinalizeMaterializationInput
  ): void {
    const { commit } = session.header
    const { result } = input.finalization
    assertMaterializationFinalizationCorrelation(session, input)
    const laneCounts = this.sessions.laneCounts(session)
    assertMaterializationLaneCompletion(session, laneCounts)
    this.assertFinalCardinality(session)
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

    if (commit.intent.kind === "telemetry") {
      const classifiedPoints = this.db
        .query(
          `
            SELECT COUNT(*) AS count FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
            WHERE session_id = ? AND kind = 'classification'
              AND json_extract(payload, '$.entityKind') = 'point'
          `
        )
        .get(session.id) as { readonly count: number }
      if (classifiedPoints.count !== commit.intent.pointCount) {
        invalidCorrelation(
          "Telemetry point classification coverage does not match the commit intent."
        )
      }
      if (
        result.kind !== "telemetry" ||
        !sameCounts(result, this.telemetryCounts(session, commit.intent.pointCount))
      ) {
        invalidCorrelation("Telemetry result counts do not correlate with finalized work.")
      }
    }
    if (commit.intent.kind === "projection") {
      if (result.kind !== "projection") return
      this.sessions.assertClassificationCoverage(session)
      if (!sameCounts(result.counts, this.projectionCounts(session))) {
        invalidCorrelation("Projection result counts do not correlate with finalized work.")
      }
    }
  }

  private assertFinalCardinality(session: SqliteMaterializationSessionState): void {
    const duplicate = this.db
      .query(
        `
          SELECT json_extract(payload, '$.scopeSortKey') AS scope_key
          FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
          WHERE session_id = ? AND kind = 'cardinality'
            AND json_extract(payload, '$.occupied') = 1
          GROUP BY scope_key HAVING COUNT(*) > 1 LIMIT 1
        `
      )
      .get(session.id)
    if (duplicate) {
      invalidCorrelation("Materialization cardinality work violates cardinality-one.")
    }
    const records = this.sessions.records(
      session,
      "cardinality"
    ) as MaterializationCardinalityOccupantWorkRecord[]
    const scopes = new Map<string, MaterializationCardinalityOccupantWorkRecord>()
    for (const record of records) scopes.set(record.scopeSortKey, record)
    for (const record of scopes.values()) {
      const effective = this.db
        .query(
          `
            SELECT ${linkSortExpression()} AS sort_key FROM links
            WHERE project_id = ? AND source_type_id = ? AND source_id = ? AND link_id = ?
            ORDER BY sort_key
          `
        )
        .all(
          session.header.commit.projectId,
          record.ref.source.objectTypeId,
          record.ref.source.primaryId,
          record.ref.linkId
        ) as { readonly sort_key: string }[]
      const occupied = records
        .filter((candidate) => candidate.scopeSortKey === record.scopeSortKey && candidate.occupied)
        .map((candidate) => candidate.linkSortKey)
        .sort()
      if (
        stableJsonStringify(effective.map((row) => row.sort_key)) !== stableJsonStringify(occupied)
      ) {
        invalidCorrelation(
          "Materialization cardinality work does not match the final effective link scope."
        )
      }
    }
  }

  private projectionCounts(session: SqliteMaterializationSessionState): EffectiveChangeCounts {
    const classifications = this.sessions.records(
      session,
      "classification"
    ) as MaterializationClassificationWorkRecord[]
    const plans = this.sessions.records(session, "plan") as MaterializationPlanWorkRecord[]
    const counts: MutableEffectiveChangeCounts = {
      objectsCreated: 0,
      objectsUpdated: 0,
      objectsDeleted: 0,
      objectsUnchanged: classifications.filter((record) => record.entityKind === "object").length,
      linksCreated: 0,
      linksUpdated: 0,
      linksDeleted: 0,
      linksUnchanged: classifications.filter((record) => record.entityKind === "link").length,
    }
    for (const record of plans) {
      switch (record.item.kind) {
        case "object-upsert":
          if (record.item.value.expected.exists) counts.objectsUpdated += 1
          else counts.objectsCreated += 1
          counts.objectsUnchanged -= 1
          break
        case "object-delete":
          counts.objectsDeleted += 1
          counts.objectsUnchanged -= 1
          break
        case "link-upsert":
          if (record.item.value.expected.exists) counts.linksUpdated += 1
          else counts.linksCreated += 1
          counts.linksUnchanged -= 1
          break
        case "link-delete":
          counts.linksDeleted += 1
          counts.linksUnchanged -= 1
          break
      }
    }
    return counts
  }

  private telemetryCounts(session: SqliteMaterializationSessionState, pointCount: number) {
    let pointsCreated = 0
    let pointsUpdated = 0
    let latestObjectsChanged = 0
    for (const record of this.sessions.records(
      session,
      "plan"
    ) as MaterializationPlanWorkRecord[]) {
      if (record.item.kind === "point-upsert") {
        if (record.item.value.expected.lastCommitId === null) pointsCreated += 1
        else pointsUpdated += 1
      } else if (record.item.kind === "object-upsert") {
        latestObjectsChanged += 1
      }
    }
    return {
      pointsCreated,
      pointsUpdated,
      pointsUnchanged: pointCount - pointsCreated - pointsUpdated,
      latestObjectsChanged,
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

type MutableEffectiveChangeCounts = {
  -readonly [TKey in keyof EffectiveChangeCounts]: EffectiveChangeCounts[TKey]
}
