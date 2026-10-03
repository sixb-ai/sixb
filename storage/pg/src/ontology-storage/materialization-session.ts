import { MaterializationConflictError } from "@sixb/core/internal/materialization"
import {
  duplicateMaterializationWork as duplicateWork,
  materializationApplyPhase,
  materializationPlanKindRank,
  ProviderMaterializationSessionState,
  type ProviderMaterializationTransactionLifecycle,
  prepareMaterializationWork,
} from "@sixb/core/internal/ontology-storage-provider"
import type {
  MaterializationPlanHeader,
  MaterializationPlanWorkRecord,
  MaterializationSession,
  MaterializationVectorChange,
  StageMaterializationWorkInput,
} from "@sixb/core/storage"
import type { SQLClient } from "../pg-client"
import { isUniqueViolation } from "../storage-errors"
import { PG_MATERIALIZATION_WORK_TABLE } from "./materialization-state"
import {
  assertReplacementPlanCoverage,
  PG_PLAN_WORK_TABLE,
  type PgReplacementPlan,
  replacementPlanCounts,
} from "./replacement-plans"
import { jsonParameter } from "./shared"

export interface PgOntologyTransactionContext {
  readonly id: object
  readonly materializations: ProviderMaterializationTransactionLifecycle
  active: boolean
}

export class PgMaterializationSessionState extends ProviderMaterializationSessionState {
  stagedWorkCount = 0
  changedObjects = 0
  changedLinks = 0
  workAnalyzed = false
  /** Work staged on the session lives in a temp table; a plan-bound session reads its plan's. */
  readonly workTable: string
  readonly workId: string

  constructor(
    header: MaterializationPlanHeader,
    transactionId: object,
    readonly plan: PgReplacementPlan | null
  ) {
    super(header, transactionId)
    this.workTable = plan ? PG_PLAN_WORK_TABLE : PG_MATERIALIZATION_WORK_TABLE
    this.workId = plan ? plan.versionId : this.id
  }
}

export class PgMaterializationSessions {
  private readonly sessions = new WeakMap<object, PgMaterializationSessionState>()
  private readonly live = new Set<PgMaterializationSessionState>()
  private tablesReady = false

  constructor(
    private readonly sql: SQLClient,
    private readonly context: PgOntologyTransactionContext | null
  ) {}

  async create(
    header: MaterializationPlanHeader,
    plan: PgReplacementPlan | null
  ): Promise<PgMaterializationSessionState> {
    if (!this.context?.active) {
      throw new MaterializationConflictError(
        "effective-state",
        "Materialization sessions require an active storage transaction."
      )
    }
    await this.ensureTables()
    const session = new PgMaterializationSessionState(
      structuredClone(header),
      this.context.id,
      plan
    )
    this.sessions.set(session.providerToken, session)
    this.live.add(session)
    this.context.materializations.register(session.providerToken)
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
    // A plan's rows outlive the session: maintenance deletes them once the candidate moved on.
    if (!session.plan) await this.deleteWork(session.id)
    session.active = false
    this.live.delete(session)
    this.context?.materializations.complete(session.providerToken)
  }

  deactivateAll(): void {
    for (const session of this.live) session.active = false
    this.live.clear()
  }

  async stage(input: StageMaterializationWorkInput): Promise<void> {
    const session = this.require(input.session)
    const records = prepareMaterializationWork(session, input)
    if (records.length === 0) return
    const payload = records.map(({ record, uniqueKey, columns }) => {
      return {
        recordKey: record.recordKey,
        uniqueKey,
        kind: record.kind,
        lane: columns.lane,
        majorOrder: columns.majorOrder,
        minorOrder: columns.minorOrder,
        sortOne: columns.sortOne,
        sortTwo: columns.sortTwo,
        occupied: record.kind === "cardinality" ? record.occupied : null,
        record,
      }
    })
    // This session is the only writer to its transaction-local temp rows. Let the two unique
    // constraints arbitrate cross-chunk duplicates instead of issuing a duplicate probe before
    // every insert; a violation aborts the enclosing materialization transaction and is mapped
    // back to the provider contract below.
    try {
      await this.sql`
        WITH staged AS (
          SELECT value FROM jsonb_array_elements(${jsonParameter(this.sql, payload)}::jsonb)
        )
        INSERT INTO ${this.sql(PG_MATERIALIZATION_WORK_TABLE)} (
          work_id, record_key, unique_key, kind, lane,
          major_order, minor_order, sort_one, sort_two, cardinality_occupied, payload
        )
        SELECT ${session.id}, value->>'recordKey', value->>'uniqueKey', value->>'kind',
          value->>'lane', (value->>'majorOrder')::integer, (value->>'minorOrder')::integer,
          value->>'sortOne', value->>'sortTwo', (value->>'occupied')::boolean, value->'record'
        FROM staged
      `
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw duplicateWork()
      }
      throw error
    }
    session.stagedWorkCount += records.length
  }

  /**
   * Refreshes the work table's statistics once planning has finished writing a large population,
   * before set-based reads join it; small edits avoid the extra round trip.
   */
  async analyzeSealedWork(session: PgMaterializationSessionState): Promise<void> {
    if (session.workAnalyzed) return
    session.workAnalyzed = true
    // A plan's shared tables are analyzed as it is planned, outside any commit transaction.
    if (session.plan || session.stagedWorkCount < 10_000) return
    await this.sql`ANALYZE ${this.sql(session.workTable)}`
  }

  /** Staged object upserts and deletes of profiled types, or of objects with a stored vector. */
  async *vectorChangePages(
    session: PgMaterializationSessionState,
    objectTypeIds: readonly string[],
    pageRows: number
  ): AsyncIterable<readonly MaterializationVectorChange[]> {
    if (objectTypeIds.length === 0) {
      const [stored] = await this.sql`
        SELECT 1 FROM object_vectors WHERE project_id = ${session.header.commit.projectId} LIMIT 1
      `
      if (!stored) return
    }
    // Each kind is one range of the lane index, paged in its order.
    for (const kind of ["object-delete", "object-upsert"] as const) {
      let after: readonly [string, string, string] = ["", "", ""]
      while (true) {
        this.require(session.publicSession())
        const rows = await this.sql<
          {
            readonly sort_one: string
            readonly sort_two: string
            readonly record_key: string
            readonly payload: unknown
          }[]
        >`
          WITH changes AS (
            SELECT sort_one, sort_two, record_key, payload,
              COALESCE(payload->'item'->'value'->'row'->'ref', payload->'item'->'value'->'ref')
                AS ref
            FROM ${this.sql(session.workTable)}
            WHERE work_id = ${session.workId} AND lane = 'apply'
              AND major_order = ${materializationApplyPhase(kind)}
              AND minor_order = ${materializationPlanKindRank(kind)}
              AND (sort_one, sort_two, record_key) > (${after[0]}, ${after[1]}, ${after[2]})
          )
          SELECT sort_one, sort_two, record_key, payload FROM changes
          WHERE ref->>'objectTypeId' = ANY(${this.sql.array([...objectTypeIds])}::text[])
            OR EXISTS (
              SELECT 1 FROM object_vectors
              WHERE project_id = ${session.header.commit.projectId}
                AND object_type_id = changes.ref->>'objectTypeId'
                AND primary_id = changes.ref->>'primaryId'
            )
          ORDER BY sort_one, sort_two, record_key
          LIMIT ${pageRows}
        `
        if (rows.length === 0) break
        const last = rows[rows.length - 1]!
        after = [last.sort_one, last.sort_two, last.record_key]
        yield rows.map(
          (row) => (row.payload as MaterializationPlanWorkRecord).item
        ) as MaterializationVectorChange[]
      }
    }
  }

  async hasCardinalityWork(session: PgMaterializationSessionState): Promise<boolean> {
    const [row] = await this.sql`
      SELECT 1 FROM ${this.sql(session.workTable)}
      WHERE work_id = ${session.workId} AND lane = 'cardinality'
      LIMIT 1
    `
    return row !== undefined
  }

  async assertClassificationCoverage(session: PgMaterializationSessionState): Promise<void> {
    if (session.plan) await assertReplacementPlanCoverage(this.sql, session.plan)
  }

  async projectionCounts(session: PgMaterializationSessionState) {
    return session.plan ? replacementPlanCounts(this.sql, session.plan.versionId) : null
  }

  private async ensureTables(): Promise<void> {
    if (this.tablesReady) return
    await this.sql`
      CREATE TEMP TABLE ${this.sql(PG_MATERIALIZATION_WORK_TABLE)} (
        work_id TEXT NOT NULL,
        record_key TEXT COLLATE "C" NOT NULL,
        unique_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        lane TEXT NOT NULL,
        major_order INTEGER NOT NULL,
        minor_order INTEGER NOT NULL,
        sort_one TEXT COLLATE "C" NOT NULL,
        sort_two TEXT COLLATE "C" NOT NULL,
        cardinality_occupied BOOLEAN,
        payload JSONB NOT NULL,
        PRIMARY KEY (work_id, record_key),
        UNIQUE (work_id, unique_key)
      ) ON COMMIT DROP
    `
    await this.sql`
      CREATE INDEX ontology_materialization_work_lane
      ON ${this.sql(PG_MATERIALIZATION_WORK_TABLE)} (
        work_id, lane, major_order, minor_order, sort_one, sort_two, record_key
      )
    `
    this.tablesReady = true
  }

  private async deleteWork(sessionId: string): Promise<void> {
    if (!this.tablesReady) return
    await this.sql`
      DELETE FROM ${this.sql(PG_MATERIALIZATION_WORK_TABLE)} WHERE work_id = ${sessionId}
    `
  }
}
