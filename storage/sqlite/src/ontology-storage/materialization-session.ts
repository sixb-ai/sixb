import type { Database } from "bun:sqlite"
import {
  type EffectiveChangeCounts,
  MaterializationConflictError,
} from "@sixb/core/internal/materialization"
import {
  duplicateMaterializationWork as duplicateWork,
  ProviderMaterializationSessionState,
  type ProviderMaterializationTransactionLifecycle,
  prepareMaterializationWork,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  MaterializationCardinalityOccupantWorkRecord,
  MaterializationEventWorkRecord,
  MaterializationPlanHeader,
  MaterializationPlanWorkRecord,
  MaterializationSession,
  MaterializationVectorChange,
  MaterializationWorkRecord,
  StageMaterializationWorkInput,
} from "@sixb/core/storage"
import { SQLITE_MATERIALIZATION_WORK_TABLE } from "./materialization-state"
import {
  assertReplacementPlanCoverage,
  replacementPlanCounts,
  SQLITE_PLAN_WORK_TABLE,
  type SqliteReplacementPlan,
} from "./replacement-plans"
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

type WorkLane = "apply" | "cardinality" | "event"

interface LaneRecord {
  readonly apply: MaterializationPlanWorkRecord
  readonly cardinality: MaterializationCardinalityOccupantWorkRecord
  readonly event: MaterializationEventWorkRecord
}

export class SqliteMaterializationSessionState extends ProviderMaterializationSessionState {
  readonly summary: WorkSummary = emptyWorkSummary()
  /** Work staged on the session lives in a temp table; a plan-bound session reads its plan's. */
  readonly workTable: string
  readonly workId: string | number

  constructor(
    header: MaterializationPlanHeader,
    transactionId: object,
    readonly plan: SqliteReplacementPlan | null
  ) {
    super(header, transactionId)
    this.workTable = plan ? SQLITE_PLAN_WORK_TABLE : SQLITE_MATERIALIZATION_WORK_TABLE
    this.workId = plan ? plan.versionId : this.id
  }
}

export class SqliteMaterializationSessions {
  private readonly sessions = new WeakMap<object, SqliteMaterializationSessionState>()
  private readonly live = new Set<SqliteMaterializationSessionState>()

  constructor(
    private readonly db: Database,
    private readonly context: SqliteOntologyTransactionContext | null
  ) {}

  create(
    header: MaterializationPlanHeader,
    plan: SqliteReplacementPlan | null
  ): SqliteMaterializationSessionState {
    if (!this.context?.active) {
      throw new MaterializationConflictError(
        "effective-state",
        "Materialization sessions require an active storage transaction."
      )
    }
    this.ensureTables()
    const session = new SqliteMaterializationSessionState(
      structuredClone(header),
      this.context.id,
      plan
    )
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
    this.live.delete(session)
    // The normal transaction has one session. Dropping its transaction-local spool avoids an
    // indexed DELETE over hundreds of thousands of rows and releases temp pages immediately.
    // Preserve per-session deletion only when another live session still shares the tables.
    // A plan's rows outlive the session: maintenance deletes them once the candidate moved on.
    if (this.live.size === 0) this.dropWorkTables()
    else if (!session.plan) this.deleteWork(session.id)
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
          work_id, record_key, unique_key, kind, lane,
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
    for (const prepared of records) recordSummary(session.summary, prepared.record)
  }

  /** Pages of one work lane in canonical order. */
  *lanePages<TLane extends WorkLane>(
    session: SqliteMaterializationSessionState,
    lane: TLane,
    pageRows: number
  ): Iterable<readonly LaneRecord[TLane][]> {
    let cursor: WorkCursor | null = null
    while (true) {
      this.require(session.publicSession())
      const rows = this.readLane(session, lane, cursor, pageRows)
      if (rows.length === 0) return
      cursor = workCursor(rows[rows.length - 1]!)
      yield rows.map((row) => parseJson<LaneRecord[TLane]>(row.payload))
    }
  }

  /** Staged object upserts and deletes of profiled types, or of objects with a stored vector. */
  *vectorChangePages(
    session: SqliteMaterializationSessionState,
    objectTypeIds: readonly string[],
    pageRows: number
  ): Iterable<readonly MaterializationVectorChange[]> {
    if (
      objectTypeIds.length === 0 &&
      !this.db
        .query(`SELECT 1 FROM object_vectors WHERE project_id = ? LIMIT 1`)
        .get(session.header.commit.projectId)
    ) {
      return
    }
    const query = this.db.query(
      `
        WITH changes AS (
          SELECT record_key, payload,
            coalesce(
              json_extract(payload, '$.item.value.row.ref.objectTypeId'),
              json_extract(payload, '$.item.value.ref.objectTypeId')
            ) AS object_type_id,
            coalesce(
              json_extract(payload, '$.item.value.row.ref.primaryId'),
              json_extract(payload, '$.item.value.ref.primaryId')
            ) AS primary_id
          FROM ${session.workTable}
          WHERE work_id = ? AND lane = 'apply' AND kind = 'plan'
            AND json_extract(payload, '$.item.kind') IN ('object-upsert', 'object-delete')
            AND record_key > ?
        )
        SELECT record_key, payload FROM changes
        WHERE object_type_id IN (SELECT value FROM json_each(?))
          OR EXISTS (
            SELECT 1 FROM object_vectors
            WHERE project_id = ? AND object_type_id = changes.object_type_id
              AND primary_id = changes.primary_id
          )
        ORDER BY record_key
        LIMIT ?
      `
    )
    let after = ""
    while (true) {
      this.require(session.publicSession())
      const rows = query.all(
        session.workId,
        after,
        JSON.stringify(objectTypeIds),
        session.header.commit.projectId,
        pageRows
      ) as { readonly record_key: string; readonly payload: string }[]
      if (rows.length === 0) return
      after = rows[rows.length - 1]!.record_key
      yield rows.map(
        (row) => parseJson<MaterializationPlanWorkRecord>(row.payload).item
      ) as MaterializationVectorChange[]
    }
  }

  projectionCounts(session: SqliteMaterializationSessionState): EffectiveChangeCounts {
    if (session.plan) return replacementPlanCounts(this.db, session.plan.versionId)
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
    if (session.plan) assertReplacementPlanCoverage(this.db, session.plan)
  }

  private readLane(
    session: SqliteMaterializationSessionState,
    lane: WorkLane,
    cursor: WorkCursor | null,
    limit: number
  ): WorkDatabaseRow[] {
    if (limit === 0) return []
    const selected = `record_key, major_order, minor_order, sort_one, sort_two, payload`
    if (!cursor) {
      return this.db
        .query(
          `SELECT ${selected} FROM ${session.workTable}
           WHERE work_id = ? AND lane = ?
           ORDER BY major_order, minor_order, sort_one, sort_two, record_key
           LIMIT ?`
        )
        .all(session.workId, lane, limit) as WorkDatabaseRow[]
    }
    return this.db
      .query(
        `SELECT ${selected} FROM ${session.workTable}
         WHERE work_id = ? AND lane = ?
           AND (major_order, minor_order, sort_one, sort_two, record_key) > (?, ?, ?, ?, ?)
         ORDER BY major_order, minor_order, sort_one, sort_two, record_key
         LIMIT ?`
      )
      .all(
        session.workId,
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
        work_id TEXT NOT NULL,
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
        PRIMARY KEY (work_id, record_key),
        UNIQUE (work_id, unique_key)
      );
      CREATE INDEX IF NOT EXISTS idx_ontology_materialization_work_lane
        ON ${SQLITE_MATERIALIZATION_WORK_TABLE}(
          work_id, lane, major_order, minor_order, sort_one, sort_two, record_key
        );
    `)
  }

  private deleteWork(sessionId: string): void {
    this.db
      .query(`DELETE FROM ${SQLITE_MATERIALIZATION_WORK_TABLE} WHERE work_id = ?`)
      .run(sessionId)
  }

  private dropWorkTables(): void {
    this.db.run(`
      DROP TABLE IF EXISTS ${SQLITE_MATERIALIZATION_WORK_TABLE};
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

function recordSummary(summary: WorkSummary, record: MaterializationWorkRecord): void {
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
