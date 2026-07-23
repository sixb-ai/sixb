import {
  linkRefKey,
  MaterializationConflictError,
  objectRefKey,
} from "@sixb/core/internal/materializer"
import {
  correlateMaterializationChunk,
  duplicateMaterializationWork as duplicateWork,
  invalidCorrelation,
  materializationPlanItems,
  ProviderMaterializationSessionState,
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

export interface PgChunkSequenceProgress {
  readonly appliedPlanCount: number
  readonly appliedOutboxCount: number
  readonly appliedPlanCursor: WorkCursor | null
  readonly appliedEventCursor: WorkCursor | null
}

export class PgMaterializationSessionState extends ProviderMaterializationSessionState {
  appliedPlanCursor: WorkCursor | null = null
  appliedEventCursor: WorkCursor | null = null
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
    const records = prepareMaterializationWork(session, input)
    if (records.length === 0) return
    const keys = records.map(({ record }) => record.recordKey)
    const uniqueKeys = records.map(({ uniqueKey }) => uniqueKey)

    const [duplicate] = await this.sql<{ readonly record_key: string }[]>`
      SELECT record_key
      FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id}
        AND (
          record_key = ANY(${this.sql.array(keys)}::text[])
          OR unique_key = ANY(${this.sql.array(uniqueKeys)}::text[])
        )
      LIMIT 1
    `
    if (duplicate) throw duplicateWork(duplicate.record_key)

    const payload = records.map(({ record, uniqueKey, columns }) => {
      return {
        recordKey: record.recordKey,
        uniqueKey,
        kind: record.kind,
        lane: columns.lane,
        rankOne: columns.rankOne,
        rankTwo: columns.rankTwo,
        sortOne: columns.sortOne,
        sortTwo: columns.sortTwo,
        record,
      }
    })
    await this.sql`
      WITH staged AS (
        SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, payload)}::jsonb)
      )
      INSERT INTO ${this.sql(PG_MATERIALIZATION_WORK_TABLE)} (
        session_id, record_key, unique_key, kind, lane,
        rank_one, rank_two, sort_one, sort_two, payload
      )
      SELECT ${session.id}, value->>'recordKey', value->>'uniqueKey', value->>'kind',
        value->>'lane', (value->>'rankOne')::integer, (value->>'rankTwo')::integer,
        value->>'sortOne', value->>'sortTwo', value->'record'
      FROM staged
    `
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
    if (refs.length === 0) return []
    const keys = refs.map(
      (ref) => `object-existence:${JSON.stringify([ref.objectTypeId, ref.primaryId])}`
    )
    const rows = await this.sql<{ readonly unique_key: string; readonly payload: unknown }[]>`
      SELECT unique_key, payload FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id}
        AND unique_key = ANY(${this.sql.array(keys)}::text[])
        AND kind = 'object-existence'
    `
    const found = new Map(rows.map((row) => [row.unique_key, row.payload] as const))
    return keys.flatMap((key) => {
      const payload = found.get(key)
      if (!payload) return []
      const record = structuredClone(payload) as Extract<
        MaterializationWorkRecord,
        { readonly kind: "object-existence" }
      >
      return [{ ref: record.ref, exists: record.exists }]
    })
  }

  async prepareChunkSequence(
    session: PgMaterializationSessionState,
    chunk: MaterializationPlanChunk
  ): Promise<PgChunkSequenceProgress> {
    const items = materializationPlanItems(chunk)
    const planRows = await this.readLane(
      "apply",
      session.id,
      session.appliedPlanCursor,
      items.length
    )
    const expectedItems = planRows.map(
      (row) =>
        (
          structuredClone(row.payload) as Extract<
            MaterializationWorkRecord,
            { readonly kind: "plan" }
          >
        ).item
    )
    const eventRows = await this.readLane(
      "event",
      session.id,
      session.appliedEventCursor,
      chunk.outbox.length
    )
    const expectedEvents = eventRows.map(
      (row) => structuredClone(row.payload) as MaterializationEventWorkRecord
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
    if (identities.length === 0) return
    const payload = identities.map((identity) => ({
      kind: identity.kind,
      identityKey: replacementIdentityKey(identity),
      diffRequired: identity.diffRequired,
    }))
    await this.sql`
      WITH staged AS (
        SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, payload)}::jsonb)
      )
      INSERT INTO ${this.sql(PG_REPLACEMENT_WORK_TABLE)} (
        session_id, entity_kind, identity_key, diff_required
      )
      SELECT ${session.id}, value->>'kind', value->>'identityKey',
        (value->>'diffRequired')::boolean
      FROM staged
      ON CONFLICT (session_id, entity_kind, identity_key) DO UPDATE SET
        diff_required = ${this.sql(PG_REPLACEMENT_WORK_TABLE)}.diff_required
          OR EXCLUDED.diff_required
    `
  }

  async count(session: PgMaterializationSessionState, kind: string): Promise<number> {
    const [row] = await this.sql<{ readonly count: number | string }[]>`
      SELECT COUNT(*) AS count FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id} AND kind = ${kind}
    `
    return Number(row?.count ?? 0)
  }

  async laneCounts(session: PgMaterializationSessionState): Promise<{
    readonly apply: number
    readonly cardinality: number
    readonly event: number
  }> {
    const rows = await this.sql<
      { readonly lane: "apply" | "cardinality" | "event"; readonly count: number | string }[]
    >`
      SELECT lane, COUNT(*) AS count FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)}
      WHERE session_id = ${session.id} AND lane <> 'none'
      GROUP BY lane
    `
    const counts = { apply: 0, cardinality: 0, event: 0 }
    for (const row of rows) counts[row.lane] = Number(row.count)
    return counts
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

function replacementIdentityKey(identity: ReplacementIdentity): string {
  return identity.kind === "object" ? objectRefKey(identity.ref) : linkRefKey(identity.ref)
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
