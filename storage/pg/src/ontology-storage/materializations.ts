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
  assertMaterializationHeader,
  assertPageRows,
  assertPlanChunkCorrelations,
  effectiveConflict,
  invalidCorrelation,
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
import {
  assertProjectionExecution,
  assertTimestamp,
  commitRecord,
  jsonKeyParameter,
  jsonParameter,
  ontologyLockKey,
  originColumns,
  type PgOntologyCommitRow,
  type PgOntologySourceRow,
  toIsoString,
} from "./shared"

export class PgOntologyMaterializationStorage implements OntologyMaterializationStorage {
  private readonly sessions: PgMaterializationSessions

  constructor(
    private readonly sql: SQLClient,
    context: PgOntologyTransactionContext | null
  ) {
    this.sessions = new PgMaterializationSessions(sql, context)
  }

  async begin(input: MaterializationPlanHeader): Promise<MaterializationSession> {
    assertMaterializationHeader(input)
    const session = await this.sessions.create(input)
    try {
      await lockAdvisoryKeys(this.sql, materializationLockKeys(input))
      await this.assertCommitAbsent(input)
      const reader = new PgMaterializationStateReader(this.sql, input.commit.projectId)
      for (const expected of input.expected.sources) {
        await this.assertSource(expected, input.commit.projectId)
      }
      for (const expected of input.expected.objects) await this.assertObject(reader, expected)
      for (const expected of input.expected.links) await this.assertLink(reader, expected)
      for (const expected of input.expected.linkScopes) {
        if (
          (await reader.linkScope(expected.source, expected.linkId)).fingerprint !==
          expected.fingerprint
        ) {
          throw new MaterializationConflictError(
            "effective-state",
            `Expected link scope changed for ${expected.source.objectTypeId}:${expected.source.primaryId}.${expected.linkId}.`
          )
        }
      }
      for (const expected of input.expected.points) {
        const point = await reader.exactPoint(expected.series, expected.at, true)
        if ((point?.lastCommitId ?? null) !== expected.lastCommitId) {
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
        const states = []
        for (const ref of objects.slice(offset, offset + input.pageRows)) {
          states.push(await reader.objectState(ref))
        }
        yield { objects: states, links: [], linkScopes: [], points: [] }
      }
      const links = uniqueSorted(request.links, linkRefKey, linkRefSortKey)
      for (let offset = 0; offset < links.length; offset += input.pageRows) {
        const states = []
        for (const ref of links.slice(offset, offset + input.pageRows)) {
          states.push(await reader.linkState(ref))
        }
        yield { objects: [], links: states, linkScopes: [], points: [] }
      }
      for await (const refs of reader.incidentLinks(request.incidentObjects, input.pageRows)) {
        this.sessions.require(input.session)
        const states = []
        for (const ref of refs) states.push(await reader.linkState(ref))
        yield { objects: [], links: states, linkScopes: [], points: [] }
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
          linkScopes: [await reader.linkScope(scope.source, scope.linkId)],
          points: [],
        }
      }
      const points = uniqueSorted(
        request.points,
        (point) => telemetryPointKey(point.series, point.at),
        (point) => telemetryPointSortKey(point.series, point.at)
      )
      for (let offset = 0; offset < points.length; offset += input.pageRows) {
        const stored = []
        for (const point of points.slice(offset, offset + input.pageRows)) {
          const value = await reader.exactPoint(point.series, point.at)
          if (value) stored.push(value)
        }
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
        await this.sessions.recordReplacementIdentities(session, identities)
        const objects = []
        for (const identity of identities) {
          objects.push(
            await reader.replacementObjectState(
              replacement.sourceId,
              replacement.candidateMaterializationId,
              identity.ref as OntologyObjectRef
            )
          )
        }
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
      await this.sessions.recordReplacementIdentities(session, identities)
      const links = []
      for (const identity of identities) {
        const ref = identity.ref as OntologyLinkRef
        links.push(
          await reader.replacementLinkState(
            replacement.sourceId,
            replacement.candidateMaterializationId,
            ref,
            identity.diffRequired,
            await reader.sourceOwnsEntity(
              replacement.sourceId,
              materializationIds,
              projectionEntityKey({ kind: "link", ref })
            )
          )
        )
      }
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
    await this.applyOverrides(commit.projectId, input.chunk)
    await this.applyEffective(commit.projectId, input.chunk)
    await this.applyTimeseries(commit.projectId, input.chunk)
    await this.applyOutbox(commit.projectId, commit.id, input.chunk)
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

  private async assertSource(
    expected: MaterializationPlanHeader["expected"]["sources"][number],
    projectId: string
  ): Promise<void> {
    const active = await this.getActiveSource(projectId, expected.source.projectionId, true)
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

  private async assertObject(
    reader: PgMaterializationStateReader,
    expected: ExpectedObjectRevision
  ): Promise<void> {
    const row = await reader.effectiveObjectRevision(expected.ref, true)
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

  private async assertLink(
    reader: PgMaterializationStateReader,
    expected: ExpectedLinkRevision
  ): Promise<void> {
    const lastCommitId = await reader.effectiveLinkLastCommit(expected.ref, true)
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

  private async applyOverrides(
    projectId: string,
    chunk: ApplyMaterializationChunkInput["chunk"]
  ): Promise<void> {
    const upsert = async (
      kind: "object" | "link",
      item:
        | (typeof chunk.overrides.objectUpserts)[number]
        | (typeof chunk.overrides.linkUpserts)[number]
    ): Promise<void> => {
      const ref = item.ref
      const key =
        kind === "object"
          ? objectRefKey(ref as OntologyObjectRef)
          : linkRefKey(ref as OntologyLinkRef)
      const columns = overrideColumns(kind, ref)
      if (item.expectedLastCommitId === null) {
        const rows = await this.sql<{ readonly last_commit_id: string }[]>`
          INSERT INTO ontology_overrides (
            project_id, entity_kind, entity_key, entity_sort_key,
            object_type_id, primary_id, source_type_id, source_primary_id,
            link_id, target_type_id, target_primary_id,
            value, last_commit_id, updated_at
          ) VALUES (
            ${projectId}, ${kind}, ${jsonKeyParameter(this.sql, key)}, ${columns.sortKey},
            ${columns.objectTypeId}, ${columns.primaryId}, ${columns.sourceTypeId},
            ${columns.sourcePrimaryId}, ${columns.linkId}, ${columns.targetTypeId},
            ${columns.targetPrimaryId}, ${jsonParameter(this.sql, item.value)},
            ${item.lastCommitId}, ${item.updatedAt}
          )
          ON CONFLICT DO NOTHING
          RETURNING last_commit_id
        `
        if (rows.length !== 1) throw effectiveConflict(`Expected ${kind} override changed.`)
      } else {
        const rows = await this.sql<{ readonly last_commit_id: string }[]>`
          UPDATE ontology_overrides
          SET value = ${jsonParameter(this.sql, item.value)},
            last_commit_id = ${item.lastCommitId}, updated_at = ${item.updatedAt}
          WHERE project_id = ${projectId}
            AND entity_kind = ${kind}
            AND entity_key = ${jsonKeyParameter(this.sql, key)}
            AND last_commit_id = ${item.expectedLastCommitId}
          RETURNING last_commit_id
        `
        if (rows.length !== 1) throw effectiveConflict(`Expected ${kind} override changed.`)
      }
    }
    for (const item of chunk.overrides.objectUpserts) await upsert("object", item)
    for (const item of chunk.overrides.objectDeletes) {
      const rows = await this.sql<{ readonly last_commit_id: string }[]>`
        DELETE FROM ontology_overrides
        WHERE project_id = ${projectId}
          AND entity_kind = 'object'
          AND entity_key = ${jsonKeyParameter(this.sql, objectRefKey(item.ref))}
          AND last_commit_id = ${item.expectedLastCommitId}
        RETURNING last_commit_id
      `
      if (rows.length !== 1) throw effectiveConflict("Expected object override changed.")
    }
    for (const item of chunk.overrides.linkUpserts) await upsert("link", item)
    for (const item of chunk.overrides.linkDeletes) {
      const rows = await this.sql<{ readonly last_commit_id: string }[]>`
        DELETE FROM ontology_overrides
        WHERE project_id = ${projectId}
          AND entity_kind = 'link'
          AND entity_key = ${jsonKeyParameter(this.sql, linkRefKey(item.ref))}
          AND last_commit_id = ${item.expectedLastCommitId}
        RETURNING last_commit_id
      `
      if (rows.length !== 1) throw effectiveConflict("Expected link override changed.")
    }
  }

  private async applyEffective(
    projectId: string,
    chunk: ApplyMaterializationChunkInput["chunk"]
  ): Promise<void> {
    for (const item of chunk.effective.linkDeletes) {
      const rows = await this.sql<{ readonly last_commit_id: string | null }[]>`
        DELETE FROM links
        WHERE project_id = ${projectId}
          AND source_type_id = ${item.ref.source.objectTypeId}
          AND source_id = ${item.ref.source.primaryId}
          AND link_id = ${item.ref.linkId}
          AND target_type_id = ${item.ref.target.objectTypeId}
          AND target_id = ${item.ref.target.primaryId}
          AND last_commit_id = ${item.expected.lastCommitId}
        RETURNING last_commit_id
      `
      if (rows.length !== 1) {
        throw effectiveConflict(`Expected link ${linkRefKey(item.ref)} changed.`)
      }
    }
    for (const item of chunk.effective.objectDeletes) {
      const rows = await this.sql<{ readonly last_commit_id: string | null }[]>`
        DELETE FROM objects
        WHERE project_id = ${projectId}
          AND object_type_id = ${item.ref.objectTypeId}
          AND primary_id = ${item.ref.primaryId}
          AND version = ${item.expected.version}
          AND last_commit_id = ${item.expected.lastCommitId}
        RETURNING last_commit_id
      `
      if (rows.length !== 1) {
        throw effectiveConflict(`Expected object ${objectRefKey(item.ref)} changed.`)
      }
    }
    for (const item of chunk.effective.objectUpserts) await this.applyObject(projectId, item)
    for (const item of chunk.effective.linkUpserts) await this.applyLink(projectId, item)
  }

  private async applyObject(projectId: string, item: ExactEffectiveObjectWrite): Promise<void> {
    const { row, expected } = item
    if (!expected.exists) {
      const rows = await this.sql<{ readonly last_commit_id: string | null }[]>`
        INSERT INTO objects (
          project_id, object_type_id, primary_id, properties, created_at,
          updated_at, version, source_event_id, last_commit_id
        ) VALUES (
          ${projectId}, ${row.ref.objectTypeId}, ${row.ref.primaryId},
          ${jsonParameter(this.sql, row.properties)}, ${row.createdAt}, ${row.updatedAt},
          ${row.version}, NULL, ${row.lastCommitId}
        )
        ON CONFLICT DO NOTHING
        RETURNING last_commit_id
      `
      if (rows.length !== 1) {
        throw effectiveConflict(`Expected object ${objectRefKey(row.ref)} to be absent.`)
      }
      return
    }
    const rows = await this.sql<{ readonly last_commit_id: string | null }[]>`
      UPDATE objects
      SET properties = ${jsonParameter(this.sql, row.properties)},
        created_at = ${row.createdAt}, updated_at = ${row.updatedAt},
        version = ${row.version}, source_event_id = NULL, last_commit_id = ${row.lastCommitId}
      WHERE project_id = ${projectId}
        AND object_type_id = ${row.ref.objectTypeId}
        AND primary_id = ${row.ref.primaryId}
        AND version = ${expected.version}
        AND last_commit_id = ${expected.lastCommitId}
      RETURNING last_commit_id
    `
    if (rows.length !== 1) {
      throw effectiveConflict(`Expected object ${objectRefKey(row.ref)} changed.`)
    }
  }

  private async applyLink(projectId: string, item: ExactEffectiveLinkWrite): Promise<void> {
    const { row, expected } = item
    const properties = row.properties === undefined ? null : jsonParameter(this.sql, row.properties)
    if (!expected.exists) {
      const rows = await this.sql<{ readonly last_commit_id: string | null }[]>`
        INSERT INTO links (
          project_id, source_type_id, source_id, link_id, target_type_id, target_id,
          properties, created_at, updated_at, source_event_id, last_commit_id
        ) VALUES (
          ${projectId}, ${row.ref.source.objectTypeId}, ${row.ref.source.primaryId},
          ${row.ref.linkId}, ${row.ref.target.objectTypeId}, ${row.ref.target.primaryId},
          ${properties}, ${row.createdAt}, ${row.updatedAt}, NULL, ${row.lastCommitId}
        )
        ON CONFLICT DO NOTHING
        RETURNING last_commit_id
      `
      if (rows.length !== 1) {
        throw effectiveConflict(`Expected link ${linkRefKey(row.ref)} to be absent.`)
      }
      return
    }
    const rows = await this.sql<{ readonly last_commit_id: string | null }[]>`
      UPDATE links
      SET properties = ${properties}, created_at = ${row.createdAt},
        updated_at = ${row.updatedAt}, source_event_id = NULL,
        last_commit_id = ${row.lastCommitId}
      WHERE project_id = ${projectId}
        AND source_type_id = ${row.ref.source.objectTypeId}
        AND source_id = ${row.ref.source.primaryId}
        AND link_id = ${row.ref.linkId}
        AND target_type_id = ${row.ref.target.objectTypeId}
        AND target_id = ${row.ref.target.primaryId}
        AND last_commit_id = ${expected.lastCommitId}
      RETURNING last_commit_id
    `
    if (rows.length !== 1) {
      throw effectiveConflict(`Expected link ${linkRefKey(row.ref)} changed.`)
    }
  }

  private async applyTimeseries(
    projectId: string,
    chunk: ApplyMaterializationChunkInput["chunk"]
  ): Promise<void> {
    for (const item of chunk.timeseries.pointUpserts) {
      const { point, expected } = item
      if (expected.lastCommitId === null) {
        const rows = await this.sql<{ readonly last_commit_id: string | null }[]>`
          INSERT INTO timeseries (
            project_id, object_type_id, object_id, property_id,
            value, unit, at, source_event_id, last_commit_id
          ) VALUES (
            ${projectId}, ${point.series.object.objectTypeId},
            ${point.series.object.primaryId}, ${point.series.propertyId},
            ${jsonParameter(this.sql, point.value)}, ${point.unit ?? null}, ${point.at},
            NULL, ${point.lastCommitId}
          )
          ON CONFLICT DO NOTHING
          RETURNING last_commit_id
        `
        if (rows.length !== 1) {
          throw new MaterializationConflictError(
            "timeseries-point",
            `Telemetry point ${telemetryPointKey(point.series, point.at)} changed.`
          )
        }
      } else {
        const rows = await this.sql<{ readonly last_commit_id: string | null }[]>`
          UPDATE timeseries
          SET value = ${jsonParameter(this.sql, point.value)}, unit = ${point.unit ?? null},
            source_event_id = NULL, last_commit_id = ${point.lastCommitId}
          WHERE project_id = ${projectId}
            AND object_type_id = ${point.series.object.objectTypeId}
            AND object_id = ${point.series.object.primaryId}
            AND property_id = ${point.series.propertyId}
            AND at = ${point.at}
            AND last_commit_id = ${expected.lastCommitId}
          RETURNING last_commit_id
        `
        if (rows.length !== 1) {
          throw new MaterializationConflictError(
            "timeseries-point",
            `Telemetry point ${telemetryPointKey(point.series, point.at)} changed.`
          )
        }
      }
    }
  }

  private async applyOutbox(
    projectId: string,
    commitId: string,
    chunk: ApplyMaterializationChunkInput["chunk"]
  ): Promise<void> {
    for (const item of chunk.outbox) {
      assertTimestamp(item.availableAt, "Outbox availableAt")
      assertTimestamp(item.createdAt, "Outbox createdAt")
      const rows = await this.sql<{ readonly id: string }[]>`
        INSERT INTO ontology_outbox (
          project_id, id, commit_id, commit_ordinal, envelope,
          available_at, attempts, lease_id, lease_expires_at,
          published_at, last_error, created_at
        ) VALUES (
          ${projectId}, ${item.envelope.id}, ${commitId}, ${item.envelope.commitOrdinal},
          ${jsonParameter(this.sql, item.envelope)}, ${item.availableAt}, 0,
          NULL, NULL, NULL, NULL, ${item.createdAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `
      if (rows.length !== 1) {
        throw effectiveConflict(`Duplicate outbox event '${item.envelope.id}'.`)
      }
    }
  }

  private async assertFinalization(
    session: PgMaterializationSessionState,
    input: FinalizeMaterializationInput
  ): Promise<void> {
    const { commit } = session.header
    const { result, sourceActivations } = input.finalization
    if (
      result.commitId !== commit.id ||
      result.kind !== commit.intent.kind ||
      result.created !== true ||
      !Number.isSafeInteger(result.eventCount) ||
      result.eventCount < 0 ||
      result.eventCount !== session.appliedOutboxCount
    ) {
      invalidCorrelation("Materialization result does not correlate with its commit intent.")
    }
    if (commit.intent.kind === "edit") {
      if (result.kind !== "edit" || result.outcomes.length !== commit.intent.operationCount) {
        invalidCorrelation("Edit result does not correlate with its operation count.")
      }
      if (sourceActivations.length !== 0) {
        invalidCorrelation("Edit materialization cannot activate a source materialization.")
      }
    } else if (commit.intent.kind === "projection") {
      if (result.kind !== "projection" || sourceActivations.length !== 1) {
        invalidCorrelation("Projection result requires exactly one correlated source activation.")
      }
    } else if (result.kind !== "telemetry" || sourceActivations.length !== 0) {
      invalidCorrelation("Telemetry result does not correlate with its point intent.")
    }

    const applyCount = await this.sessions.laneCount(session, "apply")
    if (applyCount > 0 && !session.workStreams.apply.completed) {
      invalidCorrelation("Materialization plan work was not fully streamed.")
    }
    if (session.appliedPlanCount !== applyCount) {
      invalidCorrelation("Materialization plan work was not applied exactly once.")
    }
    const cardinalityCount = await this.sessions.laneCount(session, "cardinality")
    if (cardinalityCount > 0 && !session.workStreams.cardinality.completed) {
      invalidCorrelation("Materialization cardinality work was not fully validated.")
    }
    await this.assertFinalCardinality(session)
    const eventCount = await this.sessions.laneCount(session, "event")
    if (eventCount > 0 && !session.workStreams.event.completed) {
      invalidCorrelation("Materialization event work was not fully drained.")
    }
    if (eventCount !== session.appliedOutboxCount) {
      invalidCorrelation("Materialization event work was not fully written to the outbox.")
    }
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
      const [classified] = await this.sql<{ readonly count: number | string }[]>`
        SELECT COUNT(*) AS count FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
        WHERE session_id = ${session.id}
          AND kind = 'classification'
          AND payload->>'entityKind' = 'point'
      `
      if (Number(classified?.count ?? 0) !== commit.intent.pointCount) {
        invalidCorrelation(
          "Telemetry point classification coverage does not match the commit intent."
        )
      }
      if (
        result.kind !== "telemetry" ||
        !sameCounts(result, await this.telemetryCounts(session, commit.intent.pointCount))
      ) {
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
    const [duplicate] = await this.sql<{ readonly scope_key: string }[]>`
      SELECT payload->>'scopeSortKey' AS scope_key
      FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id}
        AND kind = 'cardinality'
        AND (payload->>'occupied')::boolean
      GROUP BY scope_key
      HAVING COUNT(*) > 1
      LIMIT 1
    `
    if (duplicate) {
      invalidCorrelation("Materialization cardinality work violates cardinality-one.")
    }
    const records = (await this.sessions.records(
      session,
      "cardinality"
    )) as MaterializationCardinalityOccupantWorkRecord[]
    const scopes = new Map<string, MaterializationCardinalityOccupantWorkRecord>()
    for (const record of records) scopes.set(record.scopeSortKey, record)
    for (const record of scopes.values()) {
      const effective = await this.sql<{ readonly sort_key: string }[]>`
        SELECT ${this.sql.unsafe(linkSortExpression("links"))} AS sort_key
        FROM links
        WHERE project_id = ${session.header.commit.projectId}
          AND source_type_id = ${record.ref.source.objectTypeId}
          AND source_id = ${record.ref.source.primaryId}
          AND link_id = ${record.ref.linkId}
        ORDER BY sort_key
      `
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

  private async projectionCounts(
    session: PgMaterializationSessionState
  ): Promise<EffectiveChangeCounts> {
    const classifications = (await this.sessions.records(
      session,
      "classification"
    )) as MaterializationClassificationWorkRecord[]
    const plans = (await this.sessions.records(session, "plan")) as MaterializationPlanWorkRecord[]
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

  private async telemetryCounts(session: PgMaterializationSessionState, pointCount: number) {
    let pointsCreated = 0
    let pointsUpdated = 0
    let latestObjectsChanged = 0
    for (const record of (await this.sessions.records(
      session,
      "plan"
    )) as MaterializationPlanWorkRecord[]) {
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

  private async activateSource(
    session: PgMaterializationSessionState,
    activation: SourceActivationWrite
  ): Promise<void> {
    const { commit } = session.header
    if (
      commit.intent.kind !== "projection" ||
      commit.origin.kind !== "projection" ||
      activation.source.projectionId !== commit.intent.source.projectionId ||
      activation.source.projectionId !== commit.origin.projectionId ||
      activation.execution.projectionRunId !== commit.origin.projectionRunId ||
      activation.protocol !== "replacement" ||
      stableJsonStringify(activation.datasetVersion) !==
        stableJsonStringify(commit.intent.datasetVersion) ||
      activation.projectionRevision !== commit.projectionRevision ||
      activation.ownershipHash !== commit.ownershipHash ||
      activation.ontologyRevision !== commit.ontologyRevision ||
      activation.lastCommitId !== commit.id ||
      activation.updatedAt !== commit.committedAt ||
      !session.header.expected.sources.some(
        (expected) => stableJsonStringify(expected) === stableJsonStringify(activation.expected)
      )
    ) {
      invalidCorrelation("Source activation does not correlate with its projection commit.")
    }
    const replacement = session.replacement
    if (
      !replacement ||
      replacement.sourceId !== activation.source.projectionId ||
      replacement.candidateMaterializationId !== activation.materializationId ||
      replacement.projectionKind !== activation.projectionKind ||
      (activation.projectionKind === "object" &&
        (!replacement.objectStreamCompleted || !replacement.linkStreamCompleted)) ||
      (activation.projectionKind === "link" && !replacement.linkStreamCompleted)
    ) {
      invalidCorrelation("Source activation does not match fully streamed replacement state.")
    }
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
    await this.assertSource(activation.expected, commit.projectId)
    const previous = await this.getActiveSource(
      commit.projectId,
      activation.source.projectionId,
      true
    )
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

type MutableEffectiveChangeCounts = {
  -readonly [TKey in keyof EffectiveChangeCounts]: EffectiveChangeCounts[TKey]
}
