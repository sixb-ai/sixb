import type { Database } from "bun:sqlite"
import {
  type EffectiveChangeCounts,
  MaterializationConflictError,
} from "@sixb/core/internal/materialization"
import {
  correlateMaterializationChunk,
  duplicateMaterializationWork as duplicateWork,
  invalidCorrelation,
  materializationPlanItems,
  ProviderMaterializationSessionState,
  type ProviderMaterializationTransactionLifecycle,
  prepareMaterializationWork,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  MaterializationEventWorkRecord,
  MaterializationPlanChunk,
  MaterializationPlanHeader,
  MaterializationSession,
  MaterializationWorkPage,
  MaterializationWorkRecord,
  StageMaterializationWorkInput,
  StreamMaterializationWorkInput,
} from "@sixb/core/storage"
import {
  SQLITE_MATERIALIZATION_WORK_TABLE,
  SQLITE_REPLACEMENT_WORK_TABLE,
} from "./materialization-state"
import { canonicalJson, isSqliteConstraintError, parseJson } from "./shared"

export interface SqliteOntologyTransactionContext {
  readonly id: object
  readonly materializations: ProviderMaterializationTransactionLifecycle
  active: boolean
}

interface WorkCursor {
  readonly majorOrder: number
  readonly minorOrder: number
  readonly sortOne: string
  readonly sortTwo: string
  readonly recordKey: string
}

interface WorkDatabaseRow {
  readonly record_key: string
  readonly major_order: number
  readonly minor_order: number
  readonly sort_one: string
  readonly sort_two: string
  readonly payload: string
}

interface WorkSummary {
  apply: number
  cardinality: number
  event: number
  objectClassifications: number
  linkClassifications: number
  pointClassifications: number
  objectsCreated: number
  objectsUpdated: number
  objectsDeleted: number
  linksCreated: number
  linksUpdated: number
  linksDeleted: number
  pointsCreated: number
  pointsUpdated: number
  latestObjectsChanged: number
}

export interface SqliteChunkSequenceProgress {
  readonly appliedPlanCount: number
  readonly appliedOutboxCount: number
  readonly appliedPlanCursor: WorkCursor | null
  readonly appliedEventCursor: WorkCursor | null
}

export class SqliteMaterializationSessionState extends ProviderMaterializationSessionState {
  appliedPlanCursor: WorkCursor | null = null
  appliedEventCursor: WorkCursor | null = null
  readonly summary: WorkSummary = emptyWorkSummary()
}

export class SqliteMaterializationSessions {
  private readonly sessions = new WeakMap<object, SqliteMaterializationSessionState>()
  private readonly live = new Set<SqliteMaterializationSessionState>()

  constructor(
    private readonly db: Database,
    private readonly context: SqliteOntologyTransactionContext | null
  ) {}

  create(header: MaterializationPlanHeader): SqliteMaterializationSessionState {
    if (!this.context?.active) {
      throw new MaterializationConflictError(
        "effective-state",
        "Materialization sessions require an active storage transaction."
      )
    }
    this.ensureTables()
    const session = new SqliteMaterializationSessionState(structuredClone(header), this.context.id)
    this.sessions.set(session.providerToken, session)
    this.live.add(session)
    this.context.materializations.register(session.providerToken)
    return session
  }

  require(session: MaterializationSession): SqliteMaterializationSessionState {
    const value = this.sessions.get(session.providerToken)
    if (
      !value ||
      !value.active ||
      !this.context?.active ||
      value.transactionId !== this.context.id
    ) {
      throw new MaterializationConflictError(
        "effective-state",
        "Materialization session is inactive."
      )
    }
    return value
  }

  release(session: SqliteMaterializationSessionState): void {
    if (!session.active) return
    session.active = false
    session.replacement = null
    this.live.delete(session)
    // The normal transaction has one session. Dropping its transaction-local spool avoids an
    // indexed DELETE over hundreds of thousands of rows and releases temp pages immediately.
    // Preserve per-session deletion only when another live session still shares the tables.
    if (this.live.size === 0) this.dropWorkTables()
    else this.deleteWork(session.id)
    this.context?.materializations.complete(session.providerToken)
  }

  deactivateAll(): void {
    for (const session of this.live) this.release(session)
  }

  stage(input: StageMaterializationWorkInput): void {
    const session = this.require(input.session)
    const records = prepareMaterializationWork(session, input)
    if (records.length === 0) return
    const insert = this.db.query(
      `
        INSERT INTO ${SQLITE_MATERIALIZATION_WORK_TABLE} (
          session_id, record_key, unique_key, kind, lane,
          major_order, minor_order, sort_one, sort_two,
          classification_entity_kind, classification_identity_key,
          cardinality_view, cardinality_occupied, cardinality_source_type_id,
          cardinality_source_primary_id, cardinality_link_id,
          cardinality_target_type_id, cardinality_target_primary_id, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
      `
    )
    this.db.run("SAVEPOINT sixb_ontology_stage_work")
    let currentRecordKey: string | undefined
    try {
      for (const { record, uniqueKey, columns } of records) {
        currentRecordKey = record.recordKey
        const classification = record.kind === "classification" ? record : null
        const cardinality = record.kind === "cardinality" ? record : null
        insert.run(
          session.id,
          record.recordKey,
          uniqueKey,
          record.kind,
          columns.lane,
          columns.majorOrder,
          columns.minorOrder,
          columns.sortOne,
          columns.sortTwo,
          classification?.entityKind ?? null,
          classification?.identityKey ?? null,
          cardinality?.view ?? null,
          cardinality ? Number(cardinality.occupied) : null,
          cardinality?.ref.source.objectTypeId ?? null,
          cardinality?.ref.source.primaryId ?? null,
          cardinality?.ref.linkId ?? null,
          cardinality?.ref.target.objectTypeId ?? null,
          cardinality?.ref.target.primaryId ?? null,
          canonicalJson(record)
        )
      }
      this.db.run("RELEASE SAVEPOINT sixb_ontology_stage_work")
    } catch (error) {
      this.db.run("ROLLBACK TO SAVEPOINT sixb_ontology_stage_work")
      this.db.run("RELEASE SAVEPOINT sixb_ontology_stage_work")
      if (isSqliteConstraintError(error)) {
        throw duplicateWork(currentRecordKey)
      }
      throw error
    }
    for (const prepared of records)
      recordSummary(session.summary, prepared.record, prepared.columns)
  }

  async *stream(input: StreamMaterializationWorkInput): AsyncIterable<MaterializationWorkPage> {
    const session = this.require(input.session)
    const stream = session.workStreams[input.order]
    if (stream.started) {
      throw new MaterializationConflictError(
        "effective-state",
        `Materialization ${input.order} work may only be streamed once per session.`
      )
    }
    stream.started = true
    session.workSealed = true
    let cursor: WorkCursor | null = null
    while (true) {
      this.require(input.session)
      const rows = this.readLane(input.order, session.id, cursor, input.pageRows)
      if (rows.length === 0) break
      const records = rows.map((row) =>
        parseJson<MaterializationWorkRecord>(row.payload)
      ) as MaterializationWorkPage["records"]
      cursor = workCursor(rows[rows.length - 1]!)
      stream.emittedCount += records.length
      yield { records }
    }
    this.require(input.session)
    stream.completed = true
  }

  readObjectExistence(
    session: SqliteMaterializationSessionState,
    refs: readonly { readonly objectTypeId: string; readonly primaryId: string }[]
  ): readonly {
    readonly ref: { readonly objectTypeId: string; readonly primaryId: string }
    readonly exists: boolean
  }[] {
    const lookup = this.db.query(
      `
        SELECT payload FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
        WHERE session_id = ? AND unique_key = ? AND kind = 'object-existence'
      `
    )
    return refs.flatMap((ref) => {
      const key = `object-existence:${JSON.stringify([ref.objectTypeId, ref.primaryId])}`
      const row = lookup.get(session.id, key) as { readonly payload: string } | null
      if (!row) return []
      const record = parseJson<
        Extract<MaterializationWorkRecord, { readonly kind: "object-existence" }>
      >(row.payload)
      return [{ ref: record.ref, exists: record.exists }]
    })
  }

  prepareChunkSequence(
    session: SqliteMaterializationSessionState,
    chunk: MaterializationPlanChunk
  ): SqliteChunkSequenceProgress {
    const items = materializationPlanItems(chunk)
    const planRows = this.readLane("apply", session.id, session.appliedPlanCursor, items.length)
    const expectedItems = planRows.map((row) => {
      const record = parseJson<Extract<MaterializationWorkRecord, { readonly kind: "plan" }>>(
        row.payload
      )
      return record.item
    })
    const eventRows = this.readLane(
      "event",
      session.id,
      session.appliedEventCursor,
      chunk.outbox.length
    )
    const expectedEvents = eventRows.map((row) =>
      parseJson<MaterializationEventWorkRecord>(row.payload)
    )
    const progress = correlateMaterializationChunk(
      session,
      chunk,
      items,
      expectedItems,
      expectedEvents
    )
    return {
      ...progress,
      appliedPlanCursor:
        planRows.length === 0
          ? session.appliedPlanCursor
          : workCursor(planRows[planRows.length - 1]!),
      appliedEventCursor:
        eventRows.length === 0
          ? session.appliedEventCursor
          : workCursor(eventRows[eventRows.length - 1]!),
    }
  }

  commitChunkSequence(
    session: SqliteMaterializationSessionState,
    progress: SqliteChunkSequenceProgress
  ): void {
    session.appliedPlanCount = progress.appliedPlanCount
    session.appliedOutboxCount = progress.appliedOutboxCount
    session.appliedPlanCursor = progress.appliedPlanCursor
    session.appliedEventCursor = progress.appliedEventCursor
  }

  laneCounts(session: SqliteMaterializationSessionState): {
    readonly apply: number
    readonly cardinality: number
    readonly event: number
  } {
    return {
      apply: session.summary.apply,
      cardinality: session.summary.cardinality,
      event: session.summary.event,
    }
  }

  projectionCounts(session: SqliteMaterializationSessionState): EffectiveChangeCounts {
    const summary = session.summary
    return {
      objectsCreated: summary.objectsCreated,
      objectsUpdated: summary.objectsUpdated,
      objectsDeleted: summary.objectsDeleted,
      objectsUnchanged:
        summary.objectClassifications -
        summary.objectsCreated -
        summary.objectsUpdated -
        summary.objectsDeleted,
      linksCreated: summary.linksCreated,
      linksUpdated: summary.linksUpdated,
      linksDeleted: summary.linksDeleted,
      linksUnchanged:
        summary.linkClassifications -
        summary.linksCreated -
        summary.linksUpdated -
        summary.linksDeleted,
    }
  }

  telemetrySummary(session: SqliteMaterializationSessionState, pointCount: number) {
    const summary = session.summary
    return {
      classifiedPoints: summary.pointClassifications,
      counts: {
        pointsCreated: summary.pointsCreated,
        pointsUpdated: summary.pointsUpdated,
        pointsUnchanged: pointCount - summary.pointsCreated - summary.pointsUpdated,
        latestObjectsChanged: summary.latestObjectsChanged,
      },
    }
  }

  assertClassificationCoverage(session: SqliteMaterializationSessionState): void {
    if (!session.replacement) return
    const expectedObject = session.replacement.projectionKind === "object" ? 1 : 0
    const mismatch = this.db
      .query(
        `
          WITH invalid AS (
            SELECT 1
            FROM ${SQLITE_REPLACEMENT_WORK_TABLE} AS expected
            WHERE expected.session_id = ? AND expected.diff_required = 1
              AND (expected.entity_kind = 'link' OR ? = 1)
              AND NOT EXISTS (
                SELECT 1 FROM ${SQLITE_MATERIALIZATION_WORK_TABLE} AS actual
                WHERE actual.session_id = expected.session_id
                  AND actual.unique_key = 'classification:' || expected.entity_kind || ':'
                    || expected.identity_key
              )
            UNION ALL
            SELECT 1
            FROM ${SQLITE_MATERIALIZATION_WORK_TABLE} AS actual
            WHERE actual.session_id = ?
              -- A bounded range uses the existing (session_id, unique_key) unique index and scans
              -- classification entries only, instead of sorting the complete JSON work spool.
              AND actual.unique_key >= 'classification:'
              AND actual.unique_key < 'classification;'
              AND (
                actual.classification_entity_kind = 'point'
                OR NOT EXISTS (
                  SELECT 1 FROM ${SQLITE_REPLACEMENT_WORK_TABLE} AS expected
                  WHERE expected.session_id = actual.session_id
                    AND expected.entity_kind = actual.classification_entity_kind
                    AND expected.identity_key = actual.classification_identity_key
                    AND expected.diff_required = 1
                    AND (expected.entity_kind = 'link' OR ? = 1)
                )
              )
          )
          SELECT 1 FROM invalid LIMIT 1
        `
      )
      .get(session.id, expectedObject, session.id, expectedObject)
    if (mismatch) {
      invalidCorrelation(
        "Projection replacement classification coverage does not match its streamed state."
      )
    }
  }

  private readLane(
    lane: StreamMaterializationWorkInput["order"],
    sessionId: string,
    cursor: WorkCursor | null,
    limit: number
  ): WorkDatabaseRow[] {
    if (limit === 0) return []
    const selected = `record_key, major_order, minor_order, sort_one, sort_two, payload`
    if (!cursor) {
      return this.db
        .query(
          `SELECT ${selected} FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
           WHERE session_id = ? AND lane = ?
           ORDER BY major_order, minor_order, sort_one, sort_two, record_key
           LIMIT ?`
        )
        .all(sessionId, lane, limit) as WorkDatabaseRow[]
    }
    return this.db
      .query(
        `SELECT ${selected} FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
         WHERE session_id = ? AND lane = ?
           AND (major_order, minor_order, sort_one, sort_two, record_key) > (?, ?, ?, ?, ?)
         ORDER BY major_order, minor_order, sort_one, sort_two, record_key
         LIMIT ?`
      )
      .all(
        sessionId,
        lane,
        cursor.majorOrder,
        cursor.minorOrder,
        cursor.sortOne,
        cursor.sortTwo,
        cursor.recordKey,
        limit
      ) as WorkDatabaseRow[]
  }

  private ensureTables(): void {
    this.db.run(`
      CREATE TEMP TABLE IF NOT EXISTS ${SQLITE_MATERIALIZATION_WORK_TABLE} (
        session_id TEXT NOT NULL,
        record_key TEXT NOT NULL,
        unique_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        lane TEXT NOT NULL,
        major_order INTEGER NOT NULL,
        minor_order INTEGER NOT NULL,
        sort_one TEXT NOT NULL,
        sort_two TEXT NOT NULL,
        classification_entity_kind TEXT,
        classification_identity_key TEXT,
        cardinality_view TEXT,
        cardinality_occupied INTEGER,
        cardinality_source_type_id TEXT,
        cardinality_source_primary_id TEXT,
        cardinality_link_id TEXT,
        cardinality_target_type_id TEXT,
        cardinality_target_primary_id TEXT,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        PRIMARY KEY (session_id, record_key),
        UNIQUE (session_id, unique_key)
      );
      CREATE INDEX IF NOT EXISTS idx_ontology_materialization_work_lane
        ON ${SQLITE_MATERIALIZATION_WORK_TABLE}(
          session_id, lane, major_order, minor_order, sort_one, sort_two, record_key
        );
      CREATE TEMP TABLE IF NOT EXISTS ${SQLITE_REPLACEMENT_WORK_TABLE} (
        session_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        sort_key TEXT NOT NULL,
        diff_required INTEGER NOT NULL CHECK (diff_required IN (0, 1)),
        PRIMARY KEY (session_id, entity_kind, identity_key)
      );
      CREATE INDEX IF NOT EXISTS idx_ontology_replacement_work_order
        ON ${SQLITE_REPLACEMENT_WORK_TABLE}(
          session_id, entity_kind, sort_key, identity_key
        );
    `)
  }

  private deleteWork(sessionId: string): void {
    this.db
      .query(`DELETE FROM ${SQLITE_MATERIALIZATION_WORK_TABLE} WHERE session_id = ?`)
      .run(sessionId)
    this.db
      .query(`DELETE FROM ${SQLITE_REPLACEMENT_WORK_TABLE} WHERE session_id = ?`)
      .run(sessionId)
  }

  private dropWorkTables(): void {
    this.db.run(`
      DROP TABLE IF EXISTS ${SQLITE_MATERIALIZATION_WORK_TABLE};
      DROP TABLE IF EXISTS ${SQLITE_REPLACEMENT_WORK_TABLE};
    `)
  }
}

function workCursor(row: WorkDatabaseRow): WorkCursor {
  return {
    majorOrder: row.major_order,
    minorOrder: row.minor_order,
    sortOne: row.sort_one,
    sortTwo: row.sort_two,
    recordKey: row.record_key,
  }
}

function emptyWorkSummary(): WorkSummary {
  return {
    apply: 0,
    cardinality: 0,
    event: 0,
    objectClassifications: 0,
    linkClassifications: 0,
    pointClassifications: 0,
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksDeleted: 0,
    pointsCreated: 0,
    pointsUpdated: 0,
    latestObjectsChanged: 0,
  }
}

function recordSummary(
  summary: WorkSummary,
  record: MaterializationWorkRecord,
  columns: { readonly lane: "none" | "apply" | "cardinality" | "event" }
): void {
  if (columns.lane !== "none") summary[columns.lane] += 1

  if (record.kind === "classification") {
    if (record.entityKind === "object") summary.objectClassifications += 1
    if (record.entityKind === "link") summary.linkClassifications += 1
    if (record.entityKind === "point") summary.pointClassifications += 1
    return
  }
  if (record.kind !== "plan") return

  switch (record.item.kind) {
    case "object-upsert":
      summary.latestObjectsChanged += 1
      if (record.item.value.expected.exists) summary.objectsUpdated += 1
      else summary.objectsCreated += 1
      return
    case "object-delete":
      summary.objectsDeleted += 1
      return
    case "link-upsert":
      if (record.item.value.expected.exists) summary.linksUpdated += 1
      else summary.linksCreated += 1
      return
    case "link-delete":
      summary.linksDeleted += 1
      return
    case "point-upsert":
      if (record.item.value.expected.lastCommitId === null) summary.pointsCreated += 1
      else summary.pointsUpdated += 1
      return
    case "object-override-upsert":
    case "object-override-delete":
    case "link-override-upsert":
    case "link-override-delete":
      return
  }
}
