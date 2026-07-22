import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { stableJsonStringify } from "@sixb/core"
import {
  linkRefKey,
  MaterializationConflictError,
  objectRefKey,
} from "@sixb/core/internal/materializer"
import {
  assertWorkRecord,
  duplicateMaterializationWork as duplicateWork,
  invalidCorrelation,
  materializationPlanItems,
  materializationWorkColumns as workColumns,
  workUniquenessKey,
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
  type ReplacementIdentity,
  SQLITE_MATERIALIZATION_WORK_TABLE,
  SQLITE_REPLACEMENT_WORK_TABLE,
} from "./materialization-state"
import { canonicalJson, isSqliteConstraintError, parseJson } from "./shared"

export interface SqliteOntologyTransactionContext {
  readonly id: object
  active: boolean
}

interface LaneState {
  started: boolean
  completed: boolean
  emittedCount: number
}

export interface ReplacementSessionState {
  readonly sourceId: string
  readonly candidateMaterializationId: string
  readonly previousMaterializationId: string | null
  readonly projectionKind: "object" | "link"
  objectStreamStarted: boolean
  objectStreamCompleted: boolean
  linkStreamStarted: boolean
  linkStreamCompleted: boolean
}

export class SqliteMaterializationSessionState {
  readonly id = randomUUID()
  readonly providerToken = {}
  readonly workStreams: Record<StreamMaterializationWorkInput["order"], LaneState> = {
    apply: { started: false, completed: false, emittedCount: 0 },
    cardinality: { started: false, completed: false, emittedCount: 0 },
    event: { started: false, completed: false, emittedCount: 0 },
  }
  active = true
  workSealed = false
  appliedPlanCount = 0
  appliedOutboxCount = 0
  replacement: ReplacementSessionState | null = null

  constructor(
    readonly header: MaterializationPlanHeader,
    readonly transactionId: object
  ) {}

  publicSession(): MaterializationSession {
    return { providerToken: this.providerToken }
  }
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
  }

  deactivateAll(): void {
    for (const session of this.live) this.release(session)
  }

  stage(input: StageMaterializationWorkInput): void {
    const session = this.require(input.session)
    if (session.workSealed) {
      throw new MaterializationConflictError(
        "effective-state",
        "Materialization work cannot be staged after draining begins."
      )
    }
    const keys = new Set<string>()
    const uniqueKeys = new Set<string>()
    for (const record of input.records) {
      assertWorkRecord(record, session.header)
      const uniqueKey = workUniquenessKey(record)
      if (keys.has(record.recordKey) || uniqueKeys.has(uniqueKey)) {
        throw duplicateWork(record.recordKey)
      }
      if (
        record.kind === "incident-object" &&
        (!session.replacement || session.replacement.linkStreamStarted)
      ) {
        throw new MaterializationConflictError(
          "effective-state",
          "Incident replacement work must be staged before link state is streamed."
        )
      }
      keys.add(record.recordKey)
      uniqueKeys.add(uniqueKey)
    }
    const insert = this.db.query(
      `
        INSERT INTO ${SQLITE_MATERIALIZATION_WORK_TABLE} (
          session_id, record_key, unique_key, kind, lane,
          rank_one, rank_two, sort_one, sort_two, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
      `
    )
    try {
      for (const record of input.records) {
        const columns = workColumns(record)
        insert.run(
          session.id,
          record.recordKey,
          workUniquenessKey(record),
          record.kind,
          columns.lane,
          columns.rankOne,
          columns.rankTwo,
          columns.sortOne,
          columns.sortTwo,
          canonicalJson(record)
        )
      }
    } catch (error) {
      if (isSqliteConstraintError(error)) {
        throw duplicateWork(input.records[0]?.recordKey ?? "unknown")
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
            ORDER BY rank_one, rank_two, sort_one, sort_two, record_key
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
    if (
      items.length > 0 &&
      (!session.workStreams.apply.started ||
        session.appliedPlanCount + items.length > session.workStreams.apply.emittedCount)
    ) {
      invalidCorrelation("Materialization plan items cannot be applied before they are streamed.")
    }
    const expectedItems = this.planItems(session, session.appliedPlanCount, items.length)
    for (let index = 0; index < items.length; index += 1) {
      if (stableJsonStringify(items[index]) !== stableJsonStringify(expectedItems[index])) {
        invalidCorrelation("Materialization plan items must be applied in exact streamed order.")
      }
    }

    if (
      chunk.outbox.length > 0 &&
      (!session.workStreams.event.started ||
        session.appliedOutboxCount + chunk.outbox.length > session.workStreams.event.emittedCount)
    ) {
      invalidCorrelation("Materialization events cannot be applied before they are streamed.")
    }
    const events = this.eventRecords(session, session.appliedOutboxCount, chunk.outbox.length)
    for (let index = 0; index < chunk.outbox.length; index += 1) {
      const expected = events[index]
      const actual = chunk.outbox[index]?.envelope
      if (!expected || !actual) {
        invalidCorrelation("Materialization outbox events must follow exact streamed order.")
      }
      const { id: _id, commitOrdinal, ...draft } = actual
      if (
        commitOrdinal !== session.appliedOutboxCount + index ||
        stableJsonStringify(draft) !== stableJsonStringify(expected.draft)
      ) {
        invalidCorrelation("Materialization outbox events must follow exact streamed order.")
      }
    }
    session.appliedPlanCount += items.length
    session.appliedOutboxCount += chunk.outbox.length
  }

  recordReplacementIdentities(
    session: SqliteMaterializationSessionState,
    identities: readonly ReplacementIdentity[]
  ): void {
    const upsert = this.db.query(
      `
        INSERT INTO ${SQLITE_REPLACEMENT_WORK_TABLE} (
          session_id, entity_kind, identity_key, diff_required
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, entity_kind, identity_key) DO UPDATE SET
          diff_required = MAX(diff_required, excluded.diff_required)
      `
    )
    for (const identity of identities) {
      upsert.run(
        session.id,
        identity.kind,
        identity.kind === "object" ? objectRefKey(identity.ref) : linkRefKey(identity.ref),
        identity.diffRequired ? 1 : 0
      )
    }
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

  laneCount(session: SqliteMaterializationSessionState, lane: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS count FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
         WHERE session_id = ? AND lane = ?`
      )
      .get(session.id, lane) as { readonly count: number }
    return row.count
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
            SELECT json_extract(payload, '$.entityKind') AS entity_kind,
              json_extract(payload, '$.identityKey') AS identity_key
            FROM ${SQLITE_MATERIALIZATION_WORK_TABLE}
            WHERE session_id = ? AND kind = 'classification'
              AND json_extract(payload, '$.entityKind') IN ('object', 'link')
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
            AND json_extract(payload, '$.entityKind') = 'point'
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
          ORDER BY rank_one, rank_two, sort_one, sort_two, record_key
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
          ORDER BY rank_one, rank_two, sort_one, sort_two, record_key
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
        rank_one INTEGER NOT NULL,
        rank_two INTEGER NOT NULL,
        sort_one TEXT NOT NULL,
        sort_two TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        PRIMARY KEY (session_id, record_key),
        UNIQUE (session_id, unique_key)
      );
      CREATE INDEX IF NOT EXISTS idx_ontology_materialization_work_lane
        ON ${SQLITE_MATERIALIZATION_WORK_TABLE}(
          session_id, lane, rank_one, rank_two, sort_one, sort_two, record_key
        );
      CREATE TEMP TABLE IF NOT EXISTS ${SQLITE_REPLACEMENT_WORK_TABLE} (
        session_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        diff_required INTEGER NOT NULL CHECK (diff_required IN (0, 1)),
        PRIMARY KEY (session_id, entity_kind, identity_key)
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
