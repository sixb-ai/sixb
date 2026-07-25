import type { Database } from "bun:sqlite"
import type { ActionSubject, JsonValue } from "@sixb/core"
import type {
  ActionMaterializationRunStorage,
  ActionRunEffectsRecord,
  ActionRunFailure,
  ActionRunParams,
  ActionRunPhase,
  ActionRunRecord,
  ActionRunWritebackRecord,
  AssertActionMaterializationRunInput,
  EnterActionRunPhaseInput,
  FinishActionRunInput,
  ListActionRunsInput,
  ListActionRunsResult,
  QueueActionRunInput,
  RecordActionEffectsInput,
  RecordActionWritebackInput,
  StartActionRunInput,
} from "@sixb/core/storage"
import {
  ActionRunError,
  actionRunPhaseRecordsEqual,
  canRequeueActionRunAfterEnqueueFailure,
  finishActionRunPhase,
  isTerminalActionRun,
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteActionRunStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteActionRunStorage implements ActionMaterializationRunStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteActionRunStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async assertMaterializationRun(input: AssertActionMaterializationRunInput): Promise<void> {
    const row = this.db
      .query(`SELECT action_id, status FROM action_runs WHERE project_id = ? AND id = ?`)
      .get(input.projectId, input.runId) as {
      readonly action_id: string
      readonly status: string
    } | null
    if (!row) {
      throw new ActionRunError(
        `[SixbSqlite] Action run '${input.runId}' not found for project '${input.projectId}'.`
      )
    }
    if (row.action_id !== input.actionId) {
      throw new ActionRunError(
        `[SixbSqlite] Action run '${input.runId}' does not belong to action '${input.actionId}'.`
      )
    }
    if (row.status !== "running") {
      throw new ActionRunError(
        `[SixbSqlite] Action run '${input.runId}' cannot materialize from status '${row.status}'.`
      )
    }
  }

  async queue(input: QueueActionRunInput): Promise<ActionRunRecord> {
    const queuedAt = input.queuedAt ?? new Date()

    try {
      this.db
        .query(
          `
          INSERT INTO action_runs (
            project_id,
            id,
            action_id,
            subject_kind,
            object_type_id,
            primary_id,
            status,
            phase,
            queued_at,
            started_at,
            finished_at,
            params,
            idempotency_key,
            writeback_status,
            writeback_completed_at,
            writeback_result,
            writeback_error_name,
            writeback_error_message,
            writeback_error_phase,
            effects_status,
            effects_completed_at,
            effects_error_name,
            effects_error_message,
            effects_error_phase,
            error_name,
            error_message,
            error_phase
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?,
            NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL
          )
        `
        )
        .run(
          input.projectId,
          input.id,
          input.actionId,
          input.subject.kind,
          input.subject.kind === "object" ? input.subject.objectTypeId : null,
          input.subject.kind === "object" ? input.subject.primaryId : null,
          "queued",
          "request",
          queuedAt.toISOString(),
          JSON.stringify(input.params),
          input.idempotencyKey
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return this.requeueAfterEnqueueFailure(input, queuedAt)
      }

      throw error
    }

    const record = await this.getById({ projectId: input.projectId, id: input.id })
    if (!record) {
      throw new ActionRunError(
        `[SixbSqlite] Failed to load action run '${input.id}' for project '${input.projectId}'.`
      )
    }

    return record
  }

  private async requeueAfterEnqueueFailure(
    input: QueueActionRunInput,
    queuedAt: Date
  ): Promise<ActionRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow | null

      if (
        !existing ||
        !canRequeueActionRunAfterEnqueueFailure(rowToActionRunRecord(existing), input)
      ) {
        throw new ActionRunError(
          `[SixbSqlite] Action run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      this.db
        .query(
          `
          UPDATE action_runs
          SET
            status = ?,
            phase = ?,
            queued_at = ?,
            started_at = NULL,
            finished_at = NULL,
            writeback_status = NULL,
            writeback_completed_at = NULL,
            writeback_result = NULL,
            writeback_error_name = NULL,
            writeback_error_message = NULL,
            writeback_error_phase = NULL,
            effects_status = NULL,
            effects_completed_at = NULL,
            effects_error_name = NULL,
            effects_error_message = NULL,
            effects_error_phase = NULL,
            error_name = NULL,
            error_message = NULL,
            error_phase = NULL
          WHERE project_id = ? AND id = ?
        `
        )
        .run("queued", "request", queuedAt.toISOString(), input.projectId, input.id)

      const updated = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow

      return rowToActionRunRecord(updated)
    })()
  }

  async start(input: StartActionRunInput): Promise<ActionRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow | null

      if (!existing) {
        throw new ActionRunError(
          `[SixbSqlite] Action run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "queued") {
        throw new ActionRunError(
          `[SixbSqlite] Action run '${input.id}' cannot start from status '${existing.status}'.`
        )
      }

      this.db
        .query(
          `
          UPDATE action_runs
          SET
            status = ?,
            phase = ?,
            started_at = ?,
            error_name = NULL,
            error_message = NULL,
            error_phase = NULL
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          "running",
          input.phase ?? "validation",
          (input.startedAt ?? new Date()).toISOString(),
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow

      return rowToActionRunRecord(updated)
    })()
  }

  async enterPhase(input: EnterActionRunPhaseInput): Promise<ActionRunRecord> {
    return this.db.transaction(() => {
      this.requireRunningRun(input.projectId, input.id, "transition phase")

      this.db
        .query(
          `
          UPDATE action_runs
          SET phase = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(input.phase, input.projectId, input.id)

      const updated = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow

      return rowToActionRunRecord(updated)
    })()
  }

  async recordWriteback(input: RecordActionWritebackInput): Promise<ActionRunRecord> {
    return this.db.transaction(() => {
      const existing = this.requireRunningRun(input.projectId, input.id, "record writeback")
      const nextWriteback = toWritebackRecord(input, new Date(input.completedAt ?? new Date()))
      const currentWriteback = toActionRunWritebackRecord(existing)

      if (currentWriteback) {
        if (actionRunPhaseRecordsEqual(currentWriteback, nextWriteback)) {
          return rowToActionRunRecord(existing)
        }

        throw new ActionRunError(
          `[SixbSqlite] Action run '${input.id}' already has a different writeback record.`
        )
      }

      this.db
        .query(
          `
          UPDATE action_runs
          SET
            phase = ?,
            writeback_status = ?,
            writeback_completed_at = ?,
            writeback_result = ?,
            writeback_error_name = ?,
            writeback_error_message = ?,
            writeback_error_phase = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          "writeback",
          input.status,
          nextWriteback.completedAt.toISOString(),
          input.status === "succeeded" ? serializeJsonValue(input.result) : null,
          input.status === "failed" ? (input.error.name ?? null) : null,
          input.status === "failed" ? input.error.message : null,
          input.status === "failed" ? (input.error.phase ?? "writeback") : null,
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow

      return rowToActionRunRecord(updated)
    })()
  }

  async recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord> {
    return this.db.transaction(() => {
      const existing = this.requireRunningRun(input.projectId, input.id, "record effects")
      const nextEffects = toEffectsRecord(input, new Date(input.completedAt ?? new Date()))
      const currentEffects = toActionRunEffectsRecord(existing)

      if (currentEffects) {
        if (actionRunPhaseRecordsEqual(currentEffects, nextEffects)) {
          return rowToActionRunRecord(existing)
        }

        throw new ActionRunError(
          `[SixbSqlite] Action run '${input.id}' already has a different effects record.`
        )
      }

      this.db
        .query(
          `
          UPDATE action_runs
          SET
            phase = ?,
            effects_status = ?,
            effects_completed_at = ?,
            effects_error_name = ?,
            effects_error_message = ?,
            effects_error_phase = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          "effects",
          input.status,
          nextEffects.completedAt.toISOString(),
          input.status === "failed" ? (input.error.name ?? null) : null,
          input.status === "failed" ? input.error.message : null,
          input.status === "failed" ? (input.error.phase ?? "effects") : null,
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow

      return rowToActionRunRecord(updated)
    })()
  }

  async finish(input: FinishActionRunInput): Promise<ActionRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow | null

      if (!existing) {
        throw new ActionRunError(
          `[SixbSqlite] Action run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (isTerminalActionRun({ status: existing.status })) {
        throw new ActionRunError(
          `[SixbSqlite] Action run '${input.id}' cannot finish from terminal status '${existing.status}'.`
        )
      }

      const phase = finishActionRunPhase(input, existing.phase)

      this.db
        .query(
          `
          UPDATE action_runs
          SET
            status = ?,
            phase = ?,
            finished_at = ?,
            error_name = ?,
            error_message = ?,
            error_phase = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          phase,
          (input.finishedAt ?? new Date()).toISOString(),
          input.status === "succeeded" ? null : (input.error?.name ?? null),
          input.status === "succeeded" ? null : (input.error?.message ?? null),
          input.status === "succeeded" ? null : (input.error?.phase ?? phase),
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow

      return rowToActionRunRecord(updated)
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
      whereClauses.push("COALESCE(started_at, queued_at) >= ?")
      args.push(input.startedAfter.toISOString())
    }

    if (input.startedBefore) {
      whereClauses.push("COALESCE(started_at, queued_at) <= ?")
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
      ORDER BY COALESCE(started_at, queued_at) ${order}, id ${order}
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

  private requireRunningRun(projectId: string, id: string, operation: string): DatabaseRow {
    const existing = this.db
      .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as DatabaseRow | null

    if (!existing) {
      throw new ActionRunError(
        `[SixbSqlite] Action run '${id}' not found for project '${projectId}'.`
      )
    }

    if (existing.status !== "running") {
      throw new ActionRunError(
        `[SixbSqlite] Action run '${id}' cannot ${operation} from status '${existing.status}'.`
      )
    }

    return existing
  }
}

function serializeJsonValue(value: JsonValue): string {
  return JSON.stringify(value)
}

function toActionRunFailure(row: DatabaseRow): ActionRunFailure | undefined {
  return toFailure(row.error_name, row.error_message, row.error_phase)
}

function toFailure(
  name: string | null,
  message: string | null,
  phase: ActionRunPhase | null
): ActionRunFailure | undefined {
  if (!message) {
    return undefined
  }

  return {
    name: name ?? undefined,
    message,
    phase: phase ?? undefined,
  }
}

function toActionRunWritebackRecord(row: DatabaseRow): ActionRunWritebackRecord | undefined {
  if (!row.writeback_status) {
    return undefined
  }

  const completedAt = row.writeback_completed_at
    ? new Date(row.writeback_completed_at)
    : new Date(row.queued_at)

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
    error: toFailure(
      row.writeback_error_name,
      row.writeback_error_message,
      row.writeback_error_phase
    ),
  }
}

function toActionRunEffectsRecord(row: DatabaseRow): ActionRunEffectsRecord | undefined {
  if (!row.effects_status) {
    return undefined
  }

  const completedAt = row.effects_completed_at
    ? new Date(row.effects_completed_at)
    : new Date(row.queued_at)

  if (row.effects_status === "succeeded") {
    return {
      status: "succeeded",
      completedAt,
    }
  }

  return {
    status: "failed",
    completedAt,
    error: toFailure(row.effects_error_name, row.effects_error_message, row.effects_error_phase),
  }
}

function toWritebackRecord(
  input: RecordActionWritebackInput,
  completedAt: Date
): ActionRunWritebackRecord {
  if (input.status === "succeeded") {
    return {
      status: "succeeded",
      completedAt,
      result: input.result,
    }
  }

  return {
    status: "failed",
    completedAt,
    error: input.error,
  }
}

function toEffectsRecord(
  input: RecordActionEffectsInput,
  completedAt: Date
): ActionRunEffectsRecord {
  if (input.status === "succeeded") {
    return {
      status: "succeeded",
      completedAt,
    }
  }

  return {
    status: "failed",
    completedAt,
    error: input.error,
  }
}

function rowToActionRunRecord(row: DatabaseRow): ActionRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    actionId: row.action_id,
    subject: rowToActionSubject(row),
    status: row.status,
    phase: row.phase ?? undefined,
    queuedAt: new Date(row.queued_at),
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    params: JSON.parse(row.params) as ActionRunParams,
    idempotencyKey: row.idempotency_key,
    writeback: toActionRunWritebackRecord(row),
    effects: toActionRunEffectsRecord(row),
    error: toActionRunFailure(row),
  }
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

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed")
}

interface DatabaseRow {
  project_id: string
  id: string
  action_id: string
  subject_kind: ActionSubject["kind"]
  object_type_id: string | null
  primary_id: string | null
  status: ActionRunRecord["status"]
  phase: ActionRunPhase | null
  queued_at: string
  started_at: string | null
  finished_at: string | null
  params: string
  idempotency_key: string
  writeback_status: ActionRunWritebackRecord["status"] | null
  writeback_completed_at: string | null
  writeback_result: string | null
  writeback_error_name: string | null
  writeback_error_message: string | null
  writeback_error_phase: ActionRunPhase | null
  effects_status: ActionRunEffectsRecord["status"] | null
  effects_completed_at: string | null
  effects_error_name: string | null
  effects_error_message: string | null
  effects_error_phase: ActionRunPhase | null
  error_name: string | null
  error_message: string | null
  error_phase: ActionRunPhase | null
}
