import type { Database } from "bun:sqlite"
import { MaterializationConflictError } from "@sixb/core/internal/materialization"
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
  MaterializationPlanWorkItem,
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

export class SqliteMaterializationSessionState extends ProviderMaterializationSessionState {}

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
    this.deleteWork(session.id)
    session.active = false
    session.replacement = null
    this.live.delete(session)
    this.context?.materializations.complete(session.providerToken)
  }

  deactivateAll(): void {
    for (const session of this.live) this.release(session)
  }

  stage(input: StageMaterializationWorkInput): void {
    const session = this.require(input.session)
    const records = prepareMaterializationWork(session, input)
    const insert = this.db.query(
      `
        INSERT INTO ${SQLITE_MATERIALIZATION_WORK_TABLE} (
          session_id, record_key, unique_key, kind, lane,
          major_order, minor_order, sort_one, sort_two, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
      `
    )
    let currentRecordKey: string | undefined
    try {
      for (const { record, uniqueKey, columns } of records) {
        currentRecordKey = record.recordKey
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
          canonicalJson(record)
        )
      }
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw duplicateWork(currentRecordKey)
      }
      throw error
    }
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
    let offset = 0
    while (true) {
      this.require(input.session)
      const rows = this.db
        .query(
          `
            SELECT payload
            FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
            WHERE session_id = ? AND lane = ?
            ORDER BY major_order, minor_order, sort_one, sort_two, record_key
            LIMIT ? OFFSET ?
          `
        )
        .all(session.id, input.order, input.pageRows, offset) as { readonly payload: string }[]
      if (rows.length === 0) break
      const records = rows.map((row) =>
        parseJson<MaterializationWorkRecord>(row.payload)
      ) as MaterializationWorkPage["records"]
      offset += records.length
      stream.emittedCount = offset
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

  assertChunkSequence(
    session: SqliteMaterializationSessionState,
    chunk: MaterializationPlanChunk
  ): void {
    const items = materializationPlanItems(chunk)
    const progress = correlateMaterializationChunk(
      session,
      chunk,
      items,
      this.planItems(session, session.appliedPlanCount, items.length),
      this.eventRecords(session, session.appliedOutboxCount, chunk.outbox.length)
    )
    session.appliedPlanCount = progress.appliedPlanCount
    session.appliedOutboxCount = progress.appliedOutboxCount
  }

  count(session: SqliteMaterializationSessionState, kind: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS count FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
         WHERE session_id = ? AND kind = ?`
      )
      .get(session.id, kind) as { readonly count: number }
    return row.count
  }

  laneCounts(session: SqliteMaterializationSessionState): {
    readonly apply: number
    readonly cardinality: number
    readonly event: number
  } {
    const rows = this.db
      .query(
        `SELECT lane, COUNT(*) AS count FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
         WHERE session_id = ? AND lane <> 'none'
         GROUP BY lane`
      )
      .all(session.id) as {
      readonly lane: "apply" | "cardinality" | "event"
      readonly count: number
    }[]
    const counts = { apply: 0, cardinality: 0, event: 0 }
    for (const row of rows) counts[row.lane] = row.count
    return counts
  }

  records(session: SqliteMaterializationSessionState, kind?: string): MaterializationWorkRecord[] {
    const rows = this.db
      .query(
        `SELECT payload FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
         WHERE session_id = ? ${kind ? "AND kind = ?" : ""}`
      )
      .all(...(kind ? [session.id, kind] : [session.id])) as { readonly payload: string }[]
    return rows.map((row) => parseJson<MaterializationWorkRecord>(row.payload))
  }

  assertClassificationCoverage(session: SqliteMaterializationSessionState): void {
    if (!session.replacement) return
    const expectedObject = session.replacement.projectionKind === "object" ? 1 : 0
    const mismatch = this.db
      .query(
        `
          WITH expected AS (
            SELECT entity_kind, identity_key
            FROM ${SQLITE_REPLACEMENT_WORK_TABLE}
            WHERE session_id = ? AND diff_required = 1
              AND (entity_kind = 'link' OR ? = 1)
          ), actual AS (
            SELECT CASE
                WHEN unique_key LIKE 'classification:object:%' THEN 'object'
                ELSE 'link'
              END AS entity_kind,
              CASE
                WHEN unique_key LIKE 'classification:object:%'
                  THEN substr(unique_key, length('classification:object:') + 1)
                ELSE substr(unique_key, length('classification:link:') + 1)
              END AS identity_key
            FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
            WHERE session_id = ? AND kind = 'classification'
              AND (unique_key LIKE 'classification:object:%'
                OR unique_key LIKE 'classification:link:%')
          ), differences AS (
            SELECT * FROM expected EXCEPT SELECT * FROM actual
            UNION ALL
            SELECT * FROM actual EXCEPT SELECT * FROM expected
          )
          SELECT 1 FROM differences LIMIT 1
        `
      )
      .get(session.id, expectedObject, session.id)
    const pointClassifications = this.db
      .query(
        `
          SELECT 1 FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
          WHERE session_id = ? AND kind = 'classification'
            AND unique_key LIKE 'classification:point:%'
          LIMIT 1
        `
      )
      .get(session.id)
    if (mismatch || pointClassifications) {
      invalidCorrelation(
        "Projection replacement classification coverage does not match its streamed state."
      )
    }
  }

  private planItems(
    session: SqliteMaterializationSessionState,
    offset: number,
    limit: number
  ): MaterializationPlanWorkItem[] {
    if (limit === 0) return []
    const rows = this.db
      .query(
        `
          SELECT payload FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
          WHERE session_id = ? AND lane = 'apply'
          ORDER BY major_order, minor_order, sort_one, sort_two, record_key
          LIMIT ? OFFSET ?
        `
      )
      .all(session.id, limit, offset) as { readonly payload: string }[]
    return rows.map((row) => {
      const record = parseJson<Extract<MaterializationWorkRecord, { readonly kind: "plan" }>>(
        row.payload
      )
      return record.item
    })
  }

  private eventRecords(
    session: SqliteMaterializationSessionState,
    offset: number,
    limit: number
  ): MaterializationEventWorkRecord[] {
    if (limit === 0) return []
    const rows = this.db
      .query(
        `
          SELECT payload FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
          WHERE session_id = ? AND lane = 'event'
          ORDER BY major_order, minor_order, sort_one, sort_two, record_key
          LIMIT ? OFFSET ?
        `
      )
      .all(session.id, limit, offset) as { readonly payload: string }[]
    return rows.map((row) => parseJson<MaterializationEventWorkRecord>(row.payload))
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
}
