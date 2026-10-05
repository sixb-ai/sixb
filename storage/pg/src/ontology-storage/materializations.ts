import {
  assertPinnedDatasetWatermark,
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  MaterializationConflictError,
  MaterializationValidationError,
  objectRefKey,
  objectRefSortKey,
  telemetryPointKey,
  telemetryPointSortKey,
} from "@sixb/core/internal/materialization"
import {
  assertExpectedLinkRevision,
  assertExpectedLinkScopeRevision,
  assertExpectedObjectRevision,
  assertMaterializationFinalizationCorrelation,
  assertMaterializationHeader,
  assertPageRows,
  assertSourceActivationCorrelation,
  beginMaterializationApply,
  beginMaterializationVectorChanges,
  cardinalityViolation,
  invalidCorrelation,
  sameNonnegativeCounts as sameCounts,
  uniqueSorted,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  AppliedMaterialization,
  ApplyMaterializationInput,
  ApplyMaterializationResult,
  FinalizeMaterializationInput,
  MaterializationPlanHeader,
  MaterializationSession,
  MaterializationStatePage,
  MaterializationVectorChangePage,
  OntologyCommitRecord,
  OntologyMaterializationStorage,
  SourceActivationWrite,
  StageMaterializationWorkInput,
  StreamMaterializationStateInput,
  StreamMaterializationVectorChangesInput,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { isUniqueViolation } from "../storage-errors"
import { lockAdvisoryKeys } from "../transactions"
import {
  type PgMaterializationSessionState,
  PgMaterializationSessions,
  type PgOntologyTransactionContext,
} from "./materialization-session"
import { linkSortExpression, PgMaterializationStateReader } from "./materialization-state"
import { PgMaterializationWriter } from "./materialization-writer"
import { boundReplacementPlan } from "./replacement-plans"
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
import { activateSourceRoots } from "./source-roots"

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

  assertVectorSession(session: MaterializationSession, projectId: string, commitId?: string): void {
    const active = this.sessions.require(session)
    if (
      active.header.commit.projectId !== projectId ||
      (commitId !== undefined && active.header.commit.id !== commitId)
    ) {
      throw new MaterializationValidationError(
        "Vector mutation does not belong to this materialization session."
      )
    }
  }

  async begin(input: MaterializationPlanHeader): Promise<MaterializationSession> {
    assertMaterializationHeader(input)
    const session = await this.sessions.create(
      input,
      input.plan ? await boundReplacementPlan(this.sql, input) : null
    )
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
        assertExpectedObjectRevision(
          objectRevisions.get(objectRefKey(expected.ref)) ?? null,
          expected
        )
      }
      const linkRevisions = await reader.effectiveLinkLastCommits(
        input.expected.links.map((expected) => expected.ref),
        true
      )
      for (const expected of input.expected.links) {
        assertExpectedLinkRevision(linkRevisions.get(linkRefKey(expected.ref)), expected)
      }
      const linkScopeRevisions = await reader.linkScopeRevisions(input.expected.linkScopes)
      for (const [index, expected] of input.expected.linkScopes.entries()) {
        assertExpectedLinkScopeRevision(linkScopeRevisions[index]?.fingerprint, expected)
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
          linkScopes: await reader.linkSlotStates(scopes.slice(offset, offset + input.pageRows)),
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

  async stageWork(input: StageMaterializationWorkInput): Promise<void> {
    await this.sessions.stage(input)
  }

  async *streamVectorChanges(
    input: StreamMaterializationVectorChangesInput
  ): AsyncIterable<MaterializationVectorChangePage> {
    const session = this.sessions.require(input.session)
    assertPageRows(input.pageRows)
    beginMaterializationVectorChanges(session)
    await this.sessions.analyzeSealedWork(session)
    for await (const items of this.sessions.vectorChangePages(
      session,
      input.objectTypeIds,
      input.pageRows
    )) {
      yield { items }
    }
  }

  async apply(input: ApplyMaterializationInput): Promise<AppliedMaterialization> {
    const session = this.sessions.require(input.session)
    beginMaterializationApply(session)
    await this.sessions.analyzeSealedWork(session)
    await this.assertStagedCardinality(session)
    const { commit } = session.header
    const applied = await this.writer.applyStaged({
      workTable: session.workTable,
      workId: session.workId,
      projectId: commit.projectId,
      commitId: commit.id,
      committedAt: commit.committedAt,
    })
    session.changedObjects = applied.objectWrites
    session.changedLinks = applied.linkWrites
    session.appliedEventCount = applied.eventCount
    return { eventCount: applied.eventCount }
  }

  async finalize(input: FinalizeMaterializationInput): Promise<ApplyMaterializationResult> {
    const session = this.sessions.require(input.session)
    await this.assertCommitAbsent(session.header)
    await this.assertFinalization(session, input)
    for (const activation of input.finalization.sourceActivations) {
      await this.activateSource(session, activation)
    }
    // The next sparse projection must see the distribution of a newly published bulk load.
    // With empty/stale statistics, a link lookup can scan every edge sharing its target.
    await refreshMaterializedStatistics(this.sql, "objects", session.changedObjects)
    await refreshMaterializedStatistics(this.sql, "links", session.changedLinks)
    const record = await this.insertCommit(session.header, input)
    await this.sessions.release(session)
    return { commit: record }
  }

  deactivateSessions(): void {
    this.sessions.deactivateAll()
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

  private async assertFinalization(
    session: PgMaterializationSessionState,
    input: FinalizeMaterializationInput
  ): Promise<void> {
    const { commit } = session.header
    const { result } = input.finalization
    assertMaterializationFinalizationCorrelation(session, input)
    if (await this.sessions.hasCardinalityWork(session)) await this.assertFinalCardinality(session)
    const eventCount = session.appliedEventCount
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
      const counts = await this.sessions.projectionCounts(session)
      if (!counts || !sameCounts(result.counts, counts)) {
        invalidCorrelation("Projection result counts do not correlate with finalized work.")
      }
    }
  }

  /** Rejects a cardinality-one scope that two staged occupants claim, effective view first. */
  private async assertStagedCardinality(session: PgMaterializationSessionState): Promise<void> {
    // Cardinality records are unique per view, scope and link: two occupied in one scope is the
    // violation, and only its scope needs reading back.
    const [violation] = await this.sql<
      { readonly major_order: number; readonly sort_one: string }[]
    >`
      SELECT major_order, sort_one
      FROM ${this.sql(session.workTable)}
      WHERE work_id = ${session.workId} AND lane = 'cardinality'
        AND cardinality_occupied
      GROUP BY major_order, sort_one
      HAVING COUNT(*) > 1
      ORDER BY major_order, sort_one
      LIMIT 1
    `
    if (!violation) return
    const [scope] = await this.sql<{ readonly source_type_id: string; readonly link_id: string }[]>`
      SELECT payload->'ref'->'source'->>'objectTypeId' AS source_type_id,
        payload->'ref'->>'linkId' AS link_id
      FROM ${this.sql(session.workTable)}
      WHERE work_id = ${session.workId} AND lane = 'cardinality'
        AND major_order = ${violation.major_order} AND sort_one = ${violation.sort_one}
      LIMIT 1
    `
    throw cardinalityViolation(
      violation.major_order === 0 ? "effective" : "candidate",
      scope?.source_type_id ?? "",
      scope?.link_id ?? ""
    )
  }

  private async assertFinalCardinality(session: PgMaterializationSessionState): Promise<void> {
    // A mixed work table can hide a few occupied scopes among millions of other records.
    // Even ANALYZE can miss that population. Isolate it before planning the final join so
    // the planner sees a relation of scopes, without JSON/session selectivity guesses.
    // Session IDs are provider-generated UUIDs. Use unprepared statements for this private
    // identifier so each session does not leave a new statement in the connection cache.
    const table = `ontology_cardinality_${session.id.replaceAll("-", "")}`
    await this.sql.unsafe(
      `CREATE TEMP TABLE ${table} ON COMMIT DROP AS
        SELECT sort_one AS scope_sort_key, sort_two AS link_sort_key,
          cardinality_occupied AS occupied,
          payload->'ref'->'source'->>'objectTypeId' AS source_type_id,
          payload->'ref'->'source'->>'primaryId' AS source_id,
          payload->'ref'->>'linkId' AS link_id
        FROM ${session.workTable}
        WHERE work_id = $1 AND lane = 'cardinality' AND major_order = 0`,
      [session.workId]
    )
    await this.sql.unsafe(`ANALYZE ${table}`)
    // Apply already rejected a scope with two staged occupants; this checks what it wrote.
    const [violation] = await this.sql.unsafe<{ readonly mismatch: number }[]>(
      `WITH work AS (
        SELECT * FROM ${table}
      ), scopes AS (
        SELECT DISTINCT scope_sort_key, source_type_id, source_id, link_id FROM work
      ), expected AS (
        SELECT scope_sort_key, link_sort_key FROM work WHERE occupied
      ), actual AS (
        SELECT scopes.scope_sort_key,
          ${linkSortExpression("links")} AS link_sort_key
        FROM scopes
        JOIN links USING (source_type_id, source_id, link_id)
        WHERE links.project_id = $1
      ), differences AS (
        (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        UNION ALL
        (SELECT * FROM actual EXCEPT SELECT * FROM expected)
      )
      SELECT 1 AS mismatch FROM differences LIMIT 1`,
      [session.header.commit.projectId]
    )
    await this.sql.unsafe(`DROP TABLE ${table}`)
    if (violation) {
      invalidCorrelation(
        "Materialization cardinality work does not match the final effective link scope."
      )
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
      FROM ${this.sql(session.workTable)}
      WHERE work_id = ${session.workId}
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
    await activateSourceRoots(this.sql, commit.projectId, candidate, activation)
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
    const rows = await this.sql<PgOntologyCommitRow[]>`
      INSERT INTO ontology_commits (
        project_id, id, idempotency_key, request_hash, execution_id,
        origin_kind, origin_run_id, origin_batch_ordinal, origin,
        ontology_revision, projection_revision, ownership_hash,
        intent, result, committed_at
      ) VALUES (
        ${commit.projectId}, ${commit.id}, ${commit.idempotencyKey}, ${commit.requestHash},
        ${commit.executionId},
        ${origin.kind}, ${origin.runId}, ${origin.batchOrdinal},
        ${jsonParameter(this.sql, commit.origin)}, ${commit.ontologyRevision},
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

/** Keep the first bulk publication queryable without analyzing every small subsequent delta.
 * Expression indexes make full ANALYZE expensive. Only a substantial current publication
 * forces synchronous work. Autovacuum accumulates smaller writes separately; its modification
 * count can still include a previous transaction's manually analyzed writes at this point. */
async function refreshMaterializedStatistics(
  sql: SQLClient,
  table: "objects" | "links",
  changed: number
): Promise<void> {
  if (changed < 1_000) return
  const [state] = await sql<{ rows: number }[]>`
    SELECT reltuples AS rows FROM pg_class WHERE oid=${table}::regclass`
  if (!state || state.rows <= 0 || changed >= Math.max(10_000, state.rows * 0.1))
    await sql.unsafe(`ANALYZE ${table}`)
}
