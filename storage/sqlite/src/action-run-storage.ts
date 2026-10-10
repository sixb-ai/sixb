import type { Database } from "bun:sqlite"
import type { ActionSubject, JsonValue } from "@sixb/core"
import {
  parseActionRunFailure,
  serializeActionRunFailure,
} from "@sixb/core/internal/action-run-storage"
import { assertActionRunExecution } from "@sixb/core/internal/action-run-storage-provider"
import { normalizeRecordActionRunInput, resolveActionRunEffects } from "@sixb/core/internal/storage"
import type {
  ActionRunEffectsRecord,
  ActionRunPhase,
  ActionRunRecord,
  ActionRunStatus,
  ActionRunStorage,
  ActionRunWritebackRecord,
  ExecutionStorage,
  ListActionRunsInput,
  ListActionRunsResult,
  RecordActionEffectsInput,
  RecordActionRunInput,
} from "@sixb/core/storage"
import { ActionRunError } from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteActionRunStorageOptions {
  /** Execution lookup sharing the same provider transaction. */
  executions: ExecutionStorage
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteActionRunStorage implements ActionRunStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  private readonly executions: ExecutionStorage

  constructor(options: SqliteActionRunStorageOptions) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db
    this.executions = options.executions

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async record(input: RecordActionRunInput): Promise<ActionRunRecord> {
    const record = normalizeRecordActionRunInput(input)
    await assertActionRunExecution({
      executions: this.executions,
      projectId: record.projectId,
      executionId: record.executionId,
      runId: record.id,
      actionId: record.actionId,
    })

    const inserted = this.db
      .query(
        `
        INSERT INTO action_runs (
          project_id,
          id,
          execution_id,
          action_id,
          subject_kind,
          object_type_id,
          primary_id,
          status,
          phase,
          started_at,
          finished_at,
          params,
          idempotency_key,
          writeback_status,
          writeback_completed_at,
          writeback_result,
          writeback_error,
          error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `
      )
      .run(
        record.projectId,
        record.id,
        record.executionId,
        record.actionId,
        record.subject.kind,
        record.subject.kind === "object" ? record.subject.objectTypeId : null,
        record.subject.kind === "object" ? record.subject.primaryId : null,
        record.status,
        record.phase,
        record.startedAt.toISOString(),
        record.finishedAt.toISOString(),
        JSON.stringify(record.params),
        record.idempotencyKey,
        record.writeback?.status ?? null,
        record.writeback?.completedAt.toISOString() ?? null,
        record.writeback?.status === "succeeded" ? JSON.stringify(record.writeback.result) : null,
        record.writeback?.status === "failed"
          ? serializeActionRunFailure(record.writeback.error, "writeback")
          : null,
        record.status === "failed" ? serializeActionRunFailure(record.error) : null
      )

    if (inserted.changes === 0) {
      const conflict = this.selectRow(record.projectId, record.id)
      throw new ActionRunError(
        conflict
          ? `[SixbSqlite] Action run '${record.id}' is already recorded for project '${record.projectId}'.`
          : `[SixbSqlite] Execution '${record.executionId}' already belongs to another Action run.`
      )
    }
    return rowToActionRunRecord(this.requireRow(record.projectId, record.id))
  }

  async recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord> {
    return this.db.transaction(() => {
      const existing = this.selectRow(input.projectId, input.id)
      const { run, effects } = resolveActionRunEffects(
        existing ? rowToActionRunRecord(existing) : null,
        input
      )
      if (!effects) return run

      this.db
        .query(
          `
          UPDATE action_runs
          SET
            phase = ?,
            effects_status = ?,
            effects_completed_at = ?,
            effects_error = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          "effects",
          effects.status,
          effects.completedAt.toISOString(),
          effects.status === "failed" ? serializeActionRunFailure(effects.error, "effects") : null,
          input.projectId,
          input.id
        )
      return rowToActionRunRecord(this.requireRow(input.projectId, input.id))
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null> {
    const row = this.db
      .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as DatabaseRow | null

    return row ? rowToActionRunRecord(row) : null
  }

  async list(input: ListActionRunsInput): Promise<ListActionRunsResult> {
    if ((input.statuses && input.statuses.length === 0) || input.actionIds?.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = ?"]
    const args: (string | number)[] = [input.projectId]

    if (input.actionId) {
      whereClauses.push("action_id = ?")
      args.push(input.actionId)
    }

    if (input.actionIds) {
      whereClauses.push(`action_id IN (${input.actionIds.map(() => "?").join(", ")})`)
      args.push(...input.actionIds)
    }

    if (input.objectTypeIds) {
      if (input.objectTypeIds.length === 0) {
        whereClauses.push("subject_kind <> ?")
        args.push("object")
      } else {
        whereClauses.push(
          `(subject_kind <> ? OR object_type_id IN (${input.objectTypeIds
            .map(() => "?")
            .join(", ")}))`
        )
        args.push("object", ...input.objectTypeIds)
      }
    }

    if (input.objectTypeId) {
      whereClauses.push("subject_kind = ?")
      args.push("object")
      whereClauses.push("object_type_id = ?")
      args.push(input.objectTypeId)
    }

    if (input.primaryId) {
      whereClauses.push("subject_kind = ?")
      args.push("object")
      whereClauses.push("primary_id = ?")
      args.push(input.primaryId)
    }

    if (input.subject) {
      whereClauses.push("subject_kind = ?")
      args.push(input.subject.kind)
      if (input.subject.kind === "object") {
        whereClauses.push("object_type_id = ?")
        args.push(input.subject.objectTypeId)
        whereClauses.push("primary_id = ?")
        args.push(input.subject.primaryId)
      }
    }

    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
      args.push(...input.statuses)
    }

    if (input.startedAfter) {
      whereClauses.push("started_at >= ?")
      args.push(input.startedAfter.toISOString())
    }

    if (input.startedBefore) {
      whereClauses.push("started_at <= ?")
      args.push(input.startedBefore.toISOString())
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0
    const limit = input.limit

    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM action_runs ${where}`)
      .get(...args) as { count: number }

    let query = `
      SELECT * FROM action_runs
      ${where}
      ORDER BY started_at ${order}, id ${order}
    `
    const queryArgs = [...args]

    if (limit !== undefined) {
      query += " LIMIT ? OFFSET ?"
      queryArgs.push(limit, offset)
    } else if (offset > 0) {
      query += " LIMIT -1 OFFSET ?"
      queryArgs.push(offset)
    }

    const rows = this.db.query(query).all(...queryArgs) as DatabaseRow[]
    const runs = rows.map((row) => rowToActionRunRecord(row))

    return {
      runs,
      hasMore: offset + runs.length < totalRow.count,
      total: totalRow.count,
    }
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private selectRow(projectId: string, id: string): DatabaseRow | null {
    return this.db
      .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as DatabaseRow | null
  }

  private requireRow(projectId: string, id: string): DatabaseRow {
    const row = this.selectRow(projectId, id)
    if (!row) {
      throw new ActionRunError(
        `[SixbSqlite] Action run '${id}' disappeared from project '${projectId}' while recording it.`
      )
    }
    return row
  }
}

function toActionRunWritebackRecord(row: DatabaseRow): ActionRunWritebackRecord | undefined {
  if (!row.writeback_status) {
    return undefined
  }

  const completedAt = new Date(row.writeback_completed_at ?? row.finished_at)
  if (row.writeback_status === "succeeded") {
    return {
      status: "succeeded",
      completedAt,
      result:
        row.writeback_result === null ? null : (JSON.parse(row.writeback_result) as JsonValue),
    }
  }

  return {
    status: "failed",
    completedAt,
    error: parseActionRunFailure(row.writeback_error, "writeback"),
  }
}

function toActionRunEffectsRecord(row: DatabaseRow): ActionRunEffectsRecord | undefined {
  if (!row.effects_status) {
    return undefined
  }

  const completedAt = new Date(row.effects_completed_at ?? row.finished_at)
  if (row.effects_status === "succeeded") {
    return {
      status: "succeeded",
      completedAt,
    }
  }

  return {
    status: "failed",
    completedAt,
    error: parseActionRunFailure(row.effects_error, "effects"),
  }
}

function rowToActionRunRecord(row: DatabaseRow): ActionRunRecord {
  const writeback = toActionRunWritebackRecord(row)
  const effects = toActionRunEffectsRecord(row)
  const fields = {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    actionId: row.action_id,
    subject: rowToActionSubject(row),
    phase: row.phase,
    startedAt: new Date(row.started_at),
    finishedAt: new Date(row.finished_at),
    params: JSON.parse(row.params) as ActionRunRecord["params"],
    idempotencyKey: row.idempotency_key,
    ...(writeback === undefined ? {} : { writeback }),
    ...(effects === undefined ? {} : { effects }),
  }

  if (row.status === "succeeded") return { ...fields, status: "succeeded" }
  return { ...fields, status: "failed", error: parseActionRunFailure(row.error) }
}

function rowToActionSubject(row: DatabaseRow): ActionSubject {
  if (row.subject_kind === "none") {
    return { kind: "none" }
  }

  if (!row.object_type_id || !row.primary_id) {
    throw new ActionRunError(`[SixbSqlite] Action run '${row.id}' has an invalid object subject.`)
  }

  return {
    kind: "object",
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
  }
}

interface DatabaseRow {
  project_id: string
  id: string
  execution_id: string
  action_id: string
  subject_kind: ActionSubject["kind"]
  object_type_id: string | null
  primary_id: string | null
  status: ActionRunStatus
  phase: ActionRunPhase
  started_at: string
  finished_at: string
  params: string
  idempotency_key: string
  writeback_status: ActionRunWritebackRecord["status"] | null
  writeback_completed_at: string | null
  writeback_result: string | null
  writeback_error: string | null
  effects_status: ActionRunEffectsRecord["status"] | null
  effects_completed_at: string | null
  effects_error: string | null
  error: string | null
}
