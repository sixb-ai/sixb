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
import type { SQLClient } from "../pg-client"
import { isUniqueViolation } from "../storage-errors"
import { lockAdvisoryKeys } from "../transactions"
import {
  type PgMaterializationSessionState,
  PgMaterializationSessions,
  type PgOntologyTransactionContext,
} from "./materialization-session"
import {
  linkSortExpression,
  PG_MATERIALIZATION_WORK_TABLE,
  PgMaterializationStateReader,
} from "./materialization-state"
import { PgMaterializationWriter } from "./materialization-writer"
import {
  assertProjectionExecution,
  commitRecord,
  jsonParameter,
  ontologyLockKey,
  originColumns,
  type PgOntologyCommitRow,
  type PgOntologySourceRow,
  toIsoString,
} from "./shared"

interface ProjectionCountsRow {
  readonly object_classifications: number | string
  readonly link_classifications: number | string
  readonly objects_created: number | string
  readonly objects_updated: number | string
  readonly objects_deleted: number | string
  readonly links_created: number | string
  readonly links_updated: number | string
  readonly links_deleted: number | string
}

interface TelemetrySummaryRow {
  readonly classified_points: number | string
  readonly points_created: number | string
  readonly points_updated: number | string
  readonly latest_objects_changed: number | string
}

export class PgOntologyMaterializationStorage implements OntologyMaterializationStorage {
  private readonly sessions: PgMaterializationSessions
  private readonly writer: PgMaterializationWriter

  constructor(
    private readonly sql: SQLClient,
    context: PgOntologyTransactionContext | null
  ) {
    this.sessions = new PgMaterializationSessions(sql, context)
    this.writer = new PgMaterializationWriter(sql)
  }

  async begin(input: MaterializationPlanHeader): Promise<MaterializationSession> {
    assertMaterializationHeader(input)
    const session = await this.sessions.create(input)
    try {
      await lockAdvisoryKeys(this.sql, materializationLockKeys(input))
      await this.assertCommitAbsent(input)
      const reader = new PgMaterializationStateReader(this.sql, input.commit.projectId)
      await this.assertSources(input.expected.sources, input.commit.projectId)
      const objectRevisions = await reader.effectiveObjectRevisions(
        input.expected.objects.map((expected) => expected.ref),
        true
      )
      for (const expected of input.expected.objects) {
        this.assertObject(objectRevisions.get(objectRefKey(expected.ref)) ?? null, expected)
      }
      const linkRevisions = await reader.effectiveLinkLastCommits(
        input.expected.links.map((expected) => expected.ref),
        true
      )
      for (const expected of input.expected.links) {
        this.assertLink(linkRevisions.get(linkRefKey(expected.ref)), expected)
      }
      const linkScopes = await reader.linkScopes(input.expected.linkScopes)
      for (const [index, expected] of input.expected.linkScopes.entries()) {
        if (linkScopes[index]?.fingerprint !== expected.fingerprint) {
          throw new MaterializationConflictError(
            "effective-state",
            `Expected link scope changed for ${expected.source.objectTypeId}:${expected.source.primaryId}.${expected.linkId}.`
          )
        }
      }
      const points = await reader.exactPoints(input.expected.points, true)
      const pointRevisions = new Map(
        points.map(
          (point) => [telemetryPointKey(point.series, point.at), point.lastCommitId] as const
        )
      )
      for (const expected of input.expected.points) {
        if (
          (pointRevisions.get(telemetryPointKey(expected.series, expected.at)) ?? null) !==
          expected.lastCommitId
        ) {
          throw new MaterializationConflictError(
            "timeseries-point",
            `Telemetry point ${telemetryPointKey(expected.series, expected.at)} changed.`
          )
        }
      }
      return session.publicSession()
    } catch (error) {
      await this.sessions.release(session)
      throw error
    }
  }

  async *streamState(
    input: StreamMaterializationStateInput
  ): AsyncIterable<MaterializationStatePage> {
    const session = this.sessions.require(input.session)
    assertPageRows(input.pageRows)
    const reader = new PgMaterializationStateReader(this.sql, session.header.commit.projectId)
    for await (const request of input.requests) {
      this.sessions.require(input.session)
      const objects = uniqueSorted(request.objects, objectRefKey, objectRefSortKey)
      for (let offset = 0; offset < objects.length; offset += input.pageRows) {
        const states = await reader.objectStates(objects.slice(offset, offset + input.pageRows))
        yield { objects: states, links: [], linkScopes: [], points: [] }
      }
      const links = uniqueSorted(request.links, linkRefKey, linkRefSortKey)
      for (let offset = 0; offset < links.length; offset += input.pageRows) {
        const states = await reader.linkStates(links.slice(offset, offset + input.pageRows))
        yield { objects: [], links: states, linkScopes: [], points: [] }
      }
      for await (const refs of reader.incidentLinks(request.incidentObjects, input.pageRows)) {
        this.sessions.require(input.session)
        yield {
          objects: [],
          links: await reader.linkStates(refs),
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
          linkScopes: await reader.linkScopes(scopes.slice(offset, offset + input.pageRows)),
          points: [],
        }
      }
      const points = uniqueSorted(
        request.points,
        (point) => telemetryPointKey(point.series, point.at),
        (point) => telemetryPointSortKey(point.series, point.at)
      )
      for (let offset = 0; offset < points.length; offset += input.pageRows) {
        const stored = await reader.exactPoints(points.slice(offset, offset + input.pageRows))
        if (stored.length > 0) {
          yield { objects: [], links: [], linkScopes: [], points: stored }
        }
      }
    }
  }

  async *streamSourceReplacementState(
    input: StreamSourceReplacementStateInput
  ): AsyncIterable<SourceReplacementStatePage> {
    const session = this.sessions.require(input.session)
    assertPageRows(input.pageRows)
    const replacement = await this.requireReplacement(session, input)
    const reader = new PgMaterializationStateReader(this.sql, session.header.commit.projectId)
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
      for await (const identities of reader.replacementIdentities({
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
        const objects = await reader.replacementObjectStates(
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
    for await (const identities of reader.replacementIdentities({
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
      const links = await reader.replacementLinkStates(
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
    await this.sessions.stage(input)
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
    const progress = await this.sessions.prepareChunkSequence(session, input.chunk)
    await this.writer.apply(commit.projectId, commit.id, input.chunk)
    this.sessions.commitChunkSequence(session, progress)
  }

  async finalize(input: FinalizeMaterializationInput): Promise<ApplyMaterializationResult> {
    const session = this.sessions.require(input.session)
    await this.assertCommitAbsent(session.header)
    await this.assertFinalization(session, input)
    for (const activation of input.finalization.sourceActivations) {
      await this.activateSource(session, activation)
    }
    const record = await this.insertCommit(session.header, input)
    await this.sessions.release(session)
    return { commit: record }
  }

  deactivateSessions(): void {
    this.sessions.deactivateAll()
  }

  private async requireReplacement(
    session: PgMaterializationSessionState,
    input: StreamSourceReplacementStateInput
  ): Promise<NonNullable<PgMaterializationSessionState["replacement"]>> {
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
    const candidate = await this.getSource(
      projectId,
      input.source.projectionId,
      input.candidateMaterializationId,
      true
    )
    if (!candidate || candidate.status !== "ready" || candidate.execution_token === null) {
      throw new MaterializationConflictError(
        "source-materialization",
        `Candidate source materialization '${input.candidateMaterializationId}' is missing or is not ready.`
      )
    }
    await assertProjectionExecution(this.sql, {
      projectId,
      sourceId: input.source.projectionId,
      projectionRunId: candidate.projection_run_id,
      executionToken: candidate.execution_token,
    })
    const previous = await this.getActiveSource(projectId, input.source.projectionId, true)
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

  private async assertCommitAbsent(header: MaterializationPlanHeader): Promise<void> {
    const [duplicateIdentity] = await this.sql<
      { readonly id: string; readonly idempotency_key: string }[]
    >`
      SELECT id, idempotency_key
      FROM ontology_commits
      WHERE project_id = ${header.commit.projectId}
        AND (id = ${header.commit.id} OR idempotency_key = ${header.commit.idempotencyKey})
      ORDER BY CASE WHEN id = ${header.commit.id} THEN 0 ELSE 1 END
      LIMIT 1
      FOR UPDATE
    `
    if (duplicateIdentity) {
      throw new MaterializationConflictError(
        "idempotency",
        duplicateIdentity.id === header.commit.id
          ? `Ontology commit '${header.commit.id}' already exists.`
          : "Ontology idempotency key already exists."
      )
    }

    const origin = originColumns(header.commit.origin)
    if (origin.runId === null) return
    const [duplicateOrigin] =
      origin.batchOrdinal === null
        ? await this.sql<{ readonly id: string }[]>`
            SELECT id FROM ontology_commits
            WHERE project_id = ${header.commit.projectId}
              AND origin_kind = ${origin.kind}
              AND origin_run_id = ${origin.runId}
              AND origin_batch_ordinal IS NULL
            LIMIT 1
            FOR UPDATE
          `
        : await this.sql<{ readonly id: string }[]>`
            SELECT id FROM ontology_commits
            WHERE project_id = ${header.commit.projectId}
              AND origin_kind = ${origin.kind}
              AND origin_run_id = ${origin.runId}
              AND origin_batch_ordinal = ${origin.batchOrdinal}
            LIMIT 1
            FOR UPDATE
          `
    if (duplicateOrigin) {
      throw new MaterializationConflictError(
        "run-correlation",
        "Ontology commit origin already has an authoritative commit."
      )
    }
  }

  private async assertSources(
    expectedSources: MaterializationPlanHeader["expected"]["sources"],
    projectId: string
  ): Promise<void> {
    if (expectedSources.length === 0) return
    const rows = await this.sql<PgOntologySourceRow[]>`
      SELECT * FROM ontology_sources
      WHERE project_id = ${projectId}
        AND source_id = ANY(
          ${this.sql.array(expectedSources.map((expected) => expected.source.projectionId))}::text[]
        )
        AND status = 'active'
      FOR UPDATE
    `
    const active = new Map(rows.map((row) => [row.source_id, row] as const))
    for (const expected of expectedSources) {
      this.assertSourceRow(expected, active.get(expected.source.projectionId) ?? null)
    }
  }

  private assertSourceRow(
    expected: MaterializationPlanHeader["expected"]["sources"][number],
    active: PgOntologySourceRow | null
  ): void {
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
    row: { readonly version: number; readonly lastCommitId: string | null } | null,
    expected: ExpectedObjectRevision
  ): void {
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
    lastCommitId: string | null | undefined,
    expected: ExpectedLinkRevision
  ): void {
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
    session: PgMaterializationSessionState,
    input: FinalizeMaterializationInput
  ): Promise<void> {
    const { commit } = session.header
    const { result } = input.finalization
    assertMaterializationFinalizationCorrelation(session, input)
    const laneCounts = await this.sessions.laneCounts(session)
    assertMaterializationLaneCompletion(session, laneCounts)
    await this.assertFinalCardinality(session)
    const eventCount = laneCounts.event
    const [outbox] = await this.sql<
      {
        readonly count: number | string
        readonly minimum: number | string | null
        readonly maximum: number | string | null
      }[]
    >`
      SELECT COUNT(*) AS count, MIN(commit_ordinal) AS minimum,
        MAX(commit_ordinal) AS maximum
      FROM ontology_outbox
      WHERE project_id = ${commit.projectId} AND commit_id = ${commit.id}
    `
    const outboxCount = Number(outbox?.count ?? 0)
    const minimum = outbox?.minimum === null ? null : Number(outbox?.minimum)
    const maximum = outbox?.maximum === null ? null : Number(outbox?.maximum)
    if (
      outboxCount !== eventCount ||
      (eventCount > 0 && (minimum !== 0 || maximum !== eventCount - 1))
    ) {
      invalidCorrelation("Outbox event ordinals must be contiguous from zero.")
    }

    if (commit.intent.kind === "telemetry") {
      const summary = await this.telemetrySummary(session, commit.intent.pointCount)
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
      await this.sessions.assertClassificationCoverage(session)
      if (!sameCounts(result.counts, await this.projectionCounts(session))) {
        invalidCorrelation("Projection result counts do not correlate with finalized work.")
      }
    }
  }

  private async assertFinalCardinality(session: PgMaterializationSessionState): Promise<void> {
    const [violation] = await this.sql<{ readonly reason: "duplicate" | "mismatch" }[]>`
      WITH work AS (
        SELECT payload->>'scopeSortKey' AS scope_sort_key,
          payload->>'linkSortKey' AS link_sort_key,
          (payload->>'occupied')::boolean AS occupied,
          payload->'ref'->'source'->>'objectTypeId' AS source_type_id,
          payload->'ref'->'source'->>'primaryId' AS source_id,
          payload->'ref'->>'linkId' AS link_id
        FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
        WHERE session_id = ${session.id} AND kind = 'cardinality'
      ), duplicate AS (
        SELECT scope_sort_key FROM work WHERE occupied
        GROUP BY scope_sort_key HAVING COUNT(*) > 1
      ), scopes AS (
        SELECT DISTINCT scope_sort_key, source_type_id, source_id, link_id FROM work
      ), expected AS (
        SELECT scope_sort_key, link_sort_key FROM work WHERE occupied
      ), actual AS (
        SELECT scopes.scope_sort_key,
          ${this.sql.unsafe(linkSortExpression("links"))} AS link_sort_key
        FROM scopes
        JOIN links USING (source_type_id, source_id, link_id)
        WHERE links.project_id = ${session.header.commit.projectId}
      ), differences AS (
        (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        UNION ALL
        (SELECT * FROM actual EXCEPT SELECT * FROM expected)
      )
      SELECT 'duplicate'::text AS reason FROM duplicate
      UNION ALL
      SELECT 'mismatch'::text AS reason FROM differences
      LIMIT 1
    `
    if (violation?.reason === "duplicate") {
      invalidCorrelation("Materialization cardinality work violates cardinality-one.")
    }
    if (violation) {
      invalidCorrelation(
        "Materialization cardinality work does not match the final effective link scope."
      )
    }
  }

  private async projectionCounts(
    session: PgMaterializationSessionState
  ): Promise<EffectiveChangeCounts> {
    const [row] = await this.sql<ProjectionCountsRow[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE kind = 'classification' AND payload->>'entityKind' = 'object'
        ) AS object_classifications,
        COUNT(*) FILTER (
          WHERE kind = 'classification' AND payload->>'entityKind' = 'link'
        ) AS link_classifications,
        COUNT(*) FILTER (
          WHERE kind = 'plan' AND payload->'item'->>'kind' = 'object-upsert'
            AND NOT (payload->'item'->'value'->'expected'->>'exists')::boolean
        ) AS objects_created,
        COUNT(*) FILTER (
          WHERE kind = 'plan' AND payload->'item'->>'kind' = 'object-upsert'
            AND (payload->'item'->'value'->'expected'->>'exists')::boolean
        ) AS objects_updated,
        COUNT(*) FILTER (
          WHERE kind = 'plan' AND payload->'item'->>'kind' = 'object-delete'
        ) AS objects_deleted,
        COUNT(*) FILTER (
          WHERE kind = 'plan' AND payload->'item'->>'kind' = 'link-upsert'
            AND NOT (payload->'item'->'value'->'expected'->>'exists')::boolean
        ) AS links_created,
        COUNT(*) FILTER (
          WHERE kind = 'plan' AND payload->'item'->>'kind' = 'link-upsert'
            AND (payload->'item'->'value'->'expected'->>'exists')::boolean
        ) AS links_updated,
        COUNT(*) FILTER (
          WHERE kind = 'plan' AND payload->'item'->>'kind' = 'link-delete'
        ) AS links_deleted
      FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id}
    `
    const objectsCreated = databaseCount(row?.objects_created)
    const objectsUpdated = databaseCount(row?.objects_updated)
    const objectsDeleted = databaseCount(row?.objects_deleted)
    const linksCreated = databaseCount(row?.links_created)
    const linksUpdated = databaseCount(row?.links_updated)
    const linksDeleted = databaseCount(row?.links_deleted)
    return {
      objectsCreated,
      objectsUpdated,
      objectsDeleted,
      objectsUnchanged:
        databaseCount(row?.object_classifications) -
        objectsCreated -
        objectsUpdated -
        objectsDeleted,
      linksCreated,
      linksUpdated,
      linksDeleted,
      linksUnchanged:
        databaseCount(row?.link_classifications) - linksCreated - linksUpdated - linksDeleted,
    }
  }

  private async telemetrySummary(session: PgMaterializationSessionState, pointCount: number) {
    const [row] = await this.sql<TelemetrySummaryRow[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE kind = 'classification' AND payload->>'entityKind' = 'point'
        ) AS classified_points,
        COUNT(*) FILTER (
          WHERE kind = 'plan' AND payload->'item'->>'kind' = 'point-upsert'
            AND payload->'item'->'value'->'expected'->>'lastCommitId' IS NULL
        ) AS points_created,
        COUNT(*) FILTER (
          WHERE kind = 'plan' AND payload->'item'->>'kind' = 'point-upsert'
            AND payload->'item'->'value'->'expected'->>'lastCommitId' IS NOT NULL
        ) AS points_updated,
        COUNT(*) FILTER (
          WHERE kind = 'plan' AND payload->'item'->>'kind' = 'object-upsert'
        ) AS latest_objects_changed
      FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id}
    `
    const pointsCreated = databaseCount(row?.points_created)
    const pointsUpdated = databaseCount(row?.points_updated)
    return {
      classifiedPoints: databaseCount(row?.classified_points),
      counts: {
        pointsCreated,
        pointsUpdated,
        pointsUnchanged: pointCount - pointsCreated - pointsUpdated,
        latestObjectsChanged: databaseCount(row?.latest_objects_changed),
      },
    }
  }

  private async activateSource(
    session: PgMaterializationSessionState,
    activation: SourceActivationWrite
  ): Promise<void> {
    const { commit } = session.header
    assertSourceActivationCorrelation(session, activation)
    const candidate = await this.getSource(
      commit.projectId,
      activation.source.projectionId,
      activation.materializationId,
      true
    )
    if (!candidate || candidate.status !== "ready" || candidate.execution_token === null) {
      throw new MaterializationConflictError(
        "source-materialization",
        "Source activation candidate is missing or is not ready."
      )
    }
    await assertProjectionExecution(this.sql, {
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
      toIsoString(candidate.dataset_version_created_at) !== activation.datasetVersion.createdAt ||
      candidate.projection_revision !== activation.projectionRevision ||
      candidate.ownership_hash !== activation.ownershipHash ||
      candidate.ontology_revision !== activation.ontologyRevision ||
      candidate.ready_at === null ||
      activation.updatedAt < toIsoString(candidate.ready_at)
    ) {
      invalidCorrelation("Source activation does not match its ready candidate identity.")
    }
    const previous = await this.getActiveSource(
      commit.projectId,
      activation.source.projectionId,
      true
    )
    this.assertSourceRow(activation.expected, previous)
    if (previous) {
      assertPinnedDatasetWatermark(
        {
          datasetId: previous.dataset_id,
          versionId: previous.dataset_version_id,
          createdAt: toIsoString(previous.dataset_version_created_at),
        },
        activation.datasetVersion,
        "Source activation"
      )
      if (activation.updatedAt < toIsoString(previous.updated_at)) {
        invalidCorrelation("Source activation cannot precede the active materialization update.")
      }
      const superseded = await this.sql<{ readonly materialization_id: string }[]>`
        UPDATE ontology_sources
        SET status = 'superseded', execution_token = NULL,
          terminal_at = ${activation.updatedAt}, updated_at = ${activation.updatedAt}
        WHERE project_id = ${commit.projectId}
          AND source_id = ${activation.source.projectionId}
          AND materialization_id = ${previous.materialization_id}
          AND status = 'active'
          AND last_commit_id IS NOT DISTINCT FROM ${activation.expected.lastCommitId}
        RETURNING materialization_id
      `
      if (superseded.length !== 1) {
        throw new MaterializationConflictError(
          "projection-fence",
          `Source '${activation.source.projectionId}' changed.`
        )
      }
    }
    let activated: readonly { readonly materialization_id: string }[]
    try {
      activated = await this.sql<{ readonly materialization_id: string }[]>`
        UPDATE ontology_sources
        SET status = 'active', execution_token = NULL,
          activated_at = ${activation.updatedAt}, last_commit_id = ${activation.lastCommitId},
          updated_at = ${activation.updatedAt}
        WHERE project_id = ${commit.projectId}
          AND source_id = ${activation.source.projectionId}
          AND materialization_id = ${activation.materializationId}
          AND status = 'ready'
          AND execution_token = ${activation.execution.executionToken}
        RETURNING materialization_id
      `
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new MaterializationConflictError(
          "projection-fence",
          `Source '${activation.source.projectionId}' changed.`
        )
      }
      throw error
    }
    if (activated.length !== 1) {
      throw new MaterializationConflictError(
        "source-materialization",
        "Source activation candidate changed."
      )
    }
  }

  private async insertCommit(
    header: MaterializationPlanHeader,
    input: FinalizeMaterializationInput
  ): Promise<OntologyCommitRecord> {
    const { commit } = header
    const origin = originColumns(commit.origin)
    const actor = commit.actor === undefined ? null : jsonParameter(this.sql, commit.actor)
    const rows = await this.sql<PgOntologyCommitRow[]>`
      INSERT INTO ontology_commits (
        project_id, id, idempotency_key, request_hash,
        origin_kind, origin_run_id, origin_batch_ordinal, origin, actor,
        ontology_revision, projection_revision, ownership_hash,
        intent, result, committed_at
      ) VALUES (
        ${commit.projectId}, ${commit.id}, ${commit.idempotencyKey}, ${commit.requestHash},
        ${origin.kind}, ${origin.runId}, ${origin.batchOrdinal},
        ${jsonParameter(this.sql, commit.origin)}, ${actor}, ${commit.ontologyRevision},
        ${commit.projectionRevision ?? null}, ${commit.ownershipHash ?? null},
        ${jsonParameter(this.sql, commit.intent)},
        ${jsonParameter(this.sql, input.finalization.result)}, ${commit.committedAt}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `
    if (!rows[0]) {
      await this.assertCommitAbsent(header)
      throw new MaterializationConflictError(
        "idempotency",
        "Ontology commit identity already exists."
      )
    }
    return commitRecord(rows[0])
  }

  private async getActiveSource(
    projectId: string,
    sourceId: string,
    lock = false
  ): Promise<PgOntologySourceRow | null> {
    const lockFragment = lock ? this.sql`FOR UPDATE` : this.sql``
    const [row] = await this.sql<PgOntologySourceRow[]>`
      SELECT * FROM ontology_sources
      WHERE project_id = ${projectId} AND source_id = ${sourceId} AND status = 'active'
      ${lockFragment}
    `
    return row ?? null
  }

  private async getSource(
    projectId: string,
    sourceId: string,
    materializationId: string,
    lock = false
  ): Promise<PgOntologySourceRow | null> {
    const lockFragment = lock ? this.sql`FOR UPDATE` : this.sql``
    const [row] = await this.sql<PgOntologySourceRow[]>`
      SELECT * FROM ontology_sources
      WHERE project_id = ${projectId}
        AND source_id = ${sourceId}
        AND materialization_id = ${materializationId}
      ${lockFragment}
    `
    return row ?? null
  }
}

function materializationLockKeys(header: MaterializationPlanHeader): string[] {
  const { commit, expected } = header
  const origin = originColumns(commit.origin)
  return [
    ontologyLockKey("commit-id", commit.projectId, commit.id),
    ontologyLockKey("commit-idempotency", commit.projectId, commit.idempotencyKey),
    ...(origin.runId === null
      ? []
      : [
          ontologyLockKey(
            "commit-origin",
            commit.projectId,
            origin.kind,
            origin.runId,
            origin.batchOrdinal === null ? "" : String(origin.batchOrdinal)
          ),
        ]),
    ...expected.sources.map((value) =>
      ontologyLockKey("source", commit.projectId, value.source.projectionId)
    ),
    ...expected.objects.map((value) =>
      ontologyLockKey("object", commit.projectId, objectRefKey(value.ref))
    ),
    ...expected.links.map((value) =>
      ontologyLockKey("link", commit.projectId, linkRefKey(value.ref))
    ),
    ...expected.linkScopes.map((value) =>
      ontologyLockKey(
        "link-scope",
        commit.projectId,
        value.source.objectTypeId,
        value.source.primaryId,
        value.linkId
      )
    ),
    ...expected.points.map((value) =>
      ontologyLockKey("point", commit.projectId, telemetryPointKey(value.series, value.at))
    ),
  ]
}

function databaseCount(value: number | string | undefined): number {
  return Number(value ?? 0)
}
