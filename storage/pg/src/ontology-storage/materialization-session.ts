import { randomUUID } from "node:crypto"
import { stableJsonStringify } from "@sixb/core"
import { MaterializationConflictError } from "@sixb/core/internal/materializer"
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
  MaterializationSession,
  MaterializationWorkPage,
  MaterializationWorkRecord,
  StageMaterializationWorkInput,
  StreamMaterializationWorkInput,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import {
  PG_MATERIALIZATION_WORK_TABLE,
  PG_REPLACEMENT_WORK_TABLE,
  type ReplacementIdentity,
} from "./materialization-state"
import { jsonParameter } from "./shared"

export interface PgOntologyTransactionContext {
  readonly id: object
  active: boolean
}

interface WorkCursor {
  readonly rankOne: number
  readonly rankTwo: number
  readonly sortOne: string
  readonly sortTwo: string
  readonly recordKey: string
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

export interface PgChunkSequenceProgress {
  readonly appliedPlanCount: number
  readonly appliedOutboxCount: number
  readonly appliedPlanCursor: WorkCursor | null
  readonly appliedEventCursor: WorkCursor | null
}

export class PgMaterializationSessionState {
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
  appliedPlanCursor: WorkCursor | null = null
  appliedEventCursor: WorkCursor | null = null
  replacement: ReplacementSessionState | null = null

  constructor(
    readonly header: MaterializationPlanHeader,
    readonly transactionId: object
  ) {}

  publicSession(): MaterializationSession {
    return { providerToken: this.providerToken }
  }
}

interface WorkDatabaseRow {
  readonly record_key: string
  readonly rank_one: number
  readonly rank_two: number
  readonly sort_one: string
  readonly sort_two: string
  readonly payload: unknown
}

export class PgMaterializationSessions {
  private readonly sessions = new WeakMap<object, PgMaterializationSessionState>()
  private readonly live = new Set<PgMaterializationSessionState>()
  private tablesReady = false

  constructor(
    private readonly sql: SQLClient,
    private readonly context: PgOntologyTransactionContext | null
  ) {}

  async create(header: MaterializationPlanHeader): Promise<PgMaterializationSessionState> {
    if (!this.context?.active) {
      throw new MaterializationConflictError(
        "effective-state",
        "Materialization sessions require an active storage transaction."
      )
    }
    await this.ensureTables()
    const session = new PgMaterializationSessionState(structuredClone(header), this.context.id)
    this.sessions.set(session.providerToken, session)
    this.live.add(session)
    return session
  }

  require(session: MaterializationSession): PgMaterializationSessionState {
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

  async release(session: PgMaterializationSessionState): Promise<void> {
    if (!session.active) return
    await this.deleteWork(session.id)
    session.active = false
    session.replacement = null
    this.live.delete(session)
  }

  deactivateAll(): void {
    for (const session of this.live) {
      session.active = false
      session.replacement = null
    }
    this.live.clear()
  }

  async stage(input: StageMaterializationWorkInput): Promise<void> {
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
    if (input.records.length === 0) return

    const [duplicate] = await this.sql<{ readonly record_key: string }[]>`
      SELECT record_key
      FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id}
        AND (
          record_key = ANY(${this.sql.array([...keys])}::text[])
          OR unique_key = ANY(${this.sql.array([...uniqueKeys])}::text[])
        )
      LIMIT 1
    `
    if (duplicate) throw duplicateWork(duplicate.record_key)

    for (const record of input.records) {
      const columns = workColumns(record)
      await this.sql`
        INSERT INTO ${this.sql(PG_MATERIALIZATION_WORK_TABLE)} (
          session_id, record_key, unique_key, kind, lane,
          rank_one, rank_two, sort_one, sort_two, payload
        ) VALUES (
          ${session.id}, ${record.recordKey}, ${workUniquenessKey(record)}, ${record.kind},
          ${columns.lane}, ${columns.rankOne}, ${columns.rankTwo}, ${columns.sortOne},
          ${columns.sortTwo}, ${jsonParameter(this.sql, record)}
        )
      `
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
    let cursor: WorkCursor | null = null
    while (true) {
      this.require(input.session)
      const rows = await this.readLane(input.order, session.id, cursor, input.pageRows)
      if (rows.length === 0) break
      const records = rows.map((row) =>
        structuredClone(row.payload)
      ) as MaterializationWorkPage["records"]
      cursor = workCursor(rows[rows.length - 1]!)
      stream.emittedCount += records.length
      yield { records }
    }
    this.require(input.session)
    stream.completed = true
  }

  async readObjectExistence(
    session: PgMaterializationSessionState,
    refs: readonly { readonly objectTypeId: string; readonly primaryId: string }[]
  ): Promise<
    readonly {
      readonly ref: { readonly objectTypeId: string; readonly primaryId: string }
      readonly exists: boolean
    }[]
  > {
    const result = []
    for (const ref of refs) {
      const key = `object-existence:${JSON.stringify([ref.objectTypeId, ref.primaryId])}`
      const [row] = await this.sql<{ readonly payload: unknown }[]>`
        SELECT payload FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
        WHERE session_id = ${session.id}
          AND unique_key = ${key}
          AND kind = 'object-existence'
      `
      if (!row) continue
      const record = structuredClone(row.payload) as Extract<
        MaterializationWorkRecord,
        { readonly kind: "object-existence" }
      >
      result.push({ ref: record.ref, exists: record.exists })
    }
    return result
  }

  async prepareChunkSequence(
    session: PgMaterializationSessionState,
    chunk: MaterializationPlanChunk
  ): Promise<PgChunkSequenceProgress> {
    const items = materializationPlanItems(chunk)
    if (
      items.length > 0 &&
      (!session.workStreams.apply.started ||
        session.appliedPlanCount + items.length > session.workStreams.apply.emittedCount)
    ) {
      invalidCorrelation("Materialization plan items cannot be applied before they are streamed.")
    }
    const planRows = await this.readLane(
      "apply",
      session.id,
      session.appliedPlanCursor,
      items.length
    )
    for (let index = 0; index < items.length; index += 1) {
      const expected = structuredClone(planRows[index]?.payload) as
        | Extract<MaterializationWorkRecord, { readonly kind: "plan" }>
        | undefined
      if (!expected || stableJsonStringify(items[index]) !== stableJsonStringify(expected.item)) {
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
    const eventRows = await this.readLane(
      "event",
      session.id,
      session.appliedEventCursor,
      chunk.outbox.length
    )
    for (let index = 0; index < chunk.outbox.length; index += 1) {
      const expected = structuredClone(eventRows[index]?.payload) as
        | MaterializationEventWorkRecord
        | undefined
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

    return {
      appliedPlanCount: session.appliedPlanCount + items.length,
      appliedOutboxCount: session.appliedOutboxCount + chunk.outbox.length,
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
    session: PgMaterializationSessionState,
    progress: PgChunkSequenceProgress
  ): void {
    session.appliedPlanCount = progress.appliedPlanCount
    session.appliedOutboxCount = progress.appliedOutboxCount
    session.appliedPlanCursor = progress.appliedPlanCursor
    session.appliedEventCursor = progress.appliedEventCursor
  }

  async recordReplacementIdentities(
    session: PgMaterializationSessionState,
    identities: readonly ReplacementIdentity[]
  ): Promise<void> {
    for (const identity of identities) {
      const identityKey =
        identity.kind === "object"
          ? JSON.stringify([
              (identity.ref as { readonly objectTypeId: string }).objectTypeId,
              (identity.ref as { readonly primaryId: string }).primaryId,
            ])
          : JSON.stringify([
              (identity.ref as { readonly source: { readonly objectTypeId: string } }).source
                .objectTypeId,
              (identity.ref as { readonly source: { readonly primaryId: string } }).source
                .primaryId,
              (identity.ref as { readonly linkId: string }).linkId,
              (identity.ref as { readonly target: { readonly objectTypeId: string } }).target
                .objectTypeId,
              (identity.ref as { readonly target: { readonly primaryId: string } }).target
                .primaryId,
            ])
      await this.sql`
        INSERT INTO ${this.sql(PG_REPLACEMENT_WORK_TABLE)} (
          session_id, entity_kind, identity_key, diff_required
        ) VALUES (${session.id}, ${identity.kind}, ${identityKey}, ${identity.diffRequired})
        ON CONFLICT (session_id, entity_kind, identity_key) DO UPDATE SET
          diff_required = ${this.sql(PG_REPLACEMENT_WORK_TABLE)}.diff_required
            OR EXCLUDED.diff_required
      `
    }
  }

  async count(session: PgMaterializationSessionState, kind: string): Promise<number> {
    const [row] = await this.sql<{ readonly count: number | string }[]>`
      SELECT COUNT(*) AS count FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id} AND kind = ${kind}
    `
    return Number(row?.count ?? 0)
  }

  async laneCount(session: PgMaterializationSessionState, lane: string): Promise<number> {
    const [row] = await this.sql<{ readonly count: number | string }[]>`
      SELECT COUNT(*) AS count FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id} AND lane = ${lane}
    `
    return Number(row?.count ?? 0)
  }

  async records(
    session: PgMaterializationSessionState,
    kind?: string
  ): Promise<MaterializationWorkRecord[]> {
    const kindFilter = kind === undefined ? this.sql`` : this.sql`AND kind = ${kind}`
    const rows = await this.sql<{ readonly payload: unknown }[]>`
      SELECT payload FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id} ${kindFilter}
    `
    return rows.map((row) => structuredClone(row.payload) as MaterializationWorkRecord)
  }

  async assertClassificationCoverage(session: PgMaterializationSessionState): Promise<void> {
    if (!session.replacement) return
    const includeObjects = session.replacement.projectionKind === "object"
    const [mismatch] = await this.sql<{ readonly marker: number }[]>`
      WITH expected AS (
        SELECT entity_kind, identity_key
        FROM ${this.sql(PG_REPLACEMENT_WORK_TABLE)}
        WHERE session_id = ${session.id} AND diff_required
          AND (entity_kind = 'link' OR ${includeObjects})
      ), actual AS (
        SELECT payload->>'entityKind' AS entity_kind,
          payload->>'identityKey' AS identity_key
        FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
        WHERE session_id = ${session.id} AND kind = 'classification'
          AND payload->>'entityKind' IN ('object', 'link')
      ), differences AS (
        (SELECT * FROM expected EXCEPT SELECT * FROM actual)
        UNION ALL
        (SELECT * FROM actual EXCEPT SELECT * FROM expected)
      )
      SELECT 1 AS marker FROM differences LIMIT 1
    `
    const [pointClassification] = await this.sql<{ readonly marker: number }[]>`
      SELECT 1 AS marker FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id} AND kind = 'classification'
        AND payload->>'entityKind' = 'point'
      LIMIT 1
    `
    if (mismatch || pointClassification) {
      invalidCorrelation(
        "Projection replacement classification coverage does not match its streamed state."
      )
    }
  }

  private async readLane(
    lane: StreamMaterializationWorkInput["order"],
    sessionId: string,
    cursor: WorkCursor | null,
    limit: number
  ): Promise<WorkDatabaseRow[]> {
    if (limit === 0) return []
    const after = cursor
      ? this.sql`AND (rank_one, rank_two, sort_one, sort_two, record_key) >
          (${cursor.rankOne}, ${cursor.rankTwo}, ${cursor.sortOne}, ${cursor.sortTwo},
            ${cursor.recordKey})`
      : this.sql``
    return this.sql<WorkDatabaseRow[]>`
      SELECT record_key, rank_one, rank_two, sort_one, sort_two, payload
      FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${sessionId} AND lane = ${lane} ${after}
      ORDER BY rank_one, rank_two, sort_one, sort_two, record_key
      LIMIT ${limit}
    `
  }

  private async ensureTables(): Promise<void> {
    if (this.tablesReady) return
    await this.sql`
      CREATE TEMP TABLE ${this.sql(PG_MATERIALIZATION_WORK_TABLE)} (
        session_id TEXT NOT NULL,
        record_key TEXT COLLATE "C" NOT NULL,
        unique_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        lane TEXT NOT NULL,
        rank_one INTEGER NOT NULL,
        rank_two INTEGER NOT NULL,
        sort_one TEXT COLLATE "C" NOT NULL,
        sort_two TEXT COLLATE "C" NOT NULL,
        payload JSONB NOT NULL,
        PRIMARY KEY (session_id, record_key),
        UNIQUE (session_id, unique_key)
      ) ON COMMIT DROP
    `
    await this.sql`
      CREATE INDEX ontology_materialization_work_lane
      ON ${this.sql(PG_MATERIALIZATION_WORK_TABLE)} (
        session_id, lane, rank_one, rank_two, sort_one, sort_two, record_key
      )
    `
    await this.sql`
      CREATE TEMP TABLE ${this.sql(PG_REPLACEMENT_WORK_TABLE)} (
        session_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        identity_key TEXT COLLATE "C" NOT NULL,
        diff_required BOOLEAN NOT NULL,
        PRIMARY KEY (session_id, entity_kind, identity_key)
      ) ON COMMIT DROP
    `
    this.tablesReady = true
  }

  private async deleteWork(sessionId: string): Promise<void> {
    if (!this.tablesReady) return
    await this.sql`
      DELETE FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)} WHERE session_id = ${sessionId}
    `
    await this.sql`
      DELETE FROM ${this.sql(PG_REPLACEMENT_WORK_TABLE)} WHERE session_id = ${sessionId}
    `
  }
}

function workCursor(row: WorkDatabaseRow): WorkCursor {
  return {
    rankOne: row.rank_one,
    rankTwo: row.rank_two,
    sortOne: row.sort_one,
    sortTwo: row.sort_two,
    recordKey: row.record_key,
  }
}
