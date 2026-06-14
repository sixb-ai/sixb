import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  ActionRunFailure,
  ActionRunParams,
  ActionRunPhase,
  ActionRunRecord,
  ActionRunStorage,
  ActionSubject,
  FinishActionRunInput,
  ListActionRunsInput,
  ListActionRunsResult,
  QueueActionRunInput,
  SecurityContext,
  StartActionRunInput,
} from "@sixb/core"
import {
  ActionRunError,
  canRequeueActionRunAfterEnqueueFailure,
  isTerminalActionRun,
} from "@sixb/core"
import { installFreshSqliteSchema } from "./migrations"

export interface SqliteActionRunStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
}

export class SqliteActionRunStorage implements ActionRunStorage {
  private readonly db: Database

  constructor(options: SqliteActionRunStorageOptions = {}) {
    const path = options.path ?? ":memory:"
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)

    if (path === ":memory:") {
      installFreshSqliteSchema(this.db)
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
            security_context,
            error_name,
            error_message,
            error_phase
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)
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
          input.idempotencyKey,
          serializeSecurityContext(input.securityContext)
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
            security_context = ?,
            error_name = NULL,
            error_message = NULL,
            error_phase = NULL
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          "queued",
          "request",
          queuedAt.toISOString(),
          serializeSecurityContext(input.securityContext),
          input.projectId,
          input.id
        )

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
          "handler",
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

      const phase = finishPhase(input, existing.phase)

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
    if (input.statuses && input.statuses.length === 0) {
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
    const runs = rows.map(rowToActionRunRecord)

    return {
      runs,
      hasMore: offset + runs.length < totalRow.count,
      total: totalRow.count,
    }
  }

  close(): void {
    this.db.close()
  }
}

function finishPhase(input: FinishActionRunInput, current: ActionRunPhase | null): ActionRunPhase {
  if (input.status === "succeeded") {
    return input.phase ?? current ?? "handler"
  }

  return input.phase ?? input.error?.phase ?? current ?? "handler"
}

function serializeSecurityContext(securityContext: SecurityContext | undefined): string | null {
  return securityContext ? JSON.stringify(securityContext) : null
}

function parseSecurityContext(value: string | null): SecurityContext | undefined {
  return value ? (JSON.parse(value) as SecurityContext) : undefined
}

function toActionRunFailure(row: DatabaseRow): ActionRunFailure | undefined {
  if (!row.error_message) {
    return undefined
  }

  return {
    name: row.error_name ?? undefined,
    message: row.error_message,
    phase: row.error_phase ?? undefined,
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
    securityContext: parseSecurityContext(row.security_context),
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
  security_context: string | null
  error_name: string | null
  error_message: string | null
  error_phase: ActionRunFailure["phase"] | null
}
