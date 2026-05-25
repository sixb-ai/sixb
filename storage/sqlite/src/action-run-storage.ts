import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  ActionRunFailure,
  ActionRunRecord,
  ActionRunStorage,
  ActionSubject,
  FinishActionRunInput,
  JsonValue,
  ListActionRunsInput,
  ListActionRunsResult,
  StartActionRunInput,
} from "@pario/core"
import { ActionRunError } from "@pario/core"
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

  async start(input: StartActionRunInput): Promise<ActionRunRecord> {
    const startedAt = input.startedAt ?? new Date()

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
            started_at,
            params,
            metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.actionId,
          input.subject.kind,
          input.subject.kind === "object" ? input.subject.objectTypeId : null,
          input.subject.kind === "object" ? input.subject.primaryId : null,
          "running",
          startedAt.toISOString(),
          JSON.stringify(input.params),
          serializeMetadata(input.metadata)
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ActionRunError(
          `[ParioSqlite] Action run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }

    const record = await this.getById({ projectId: input.projectId, id: input.id })
    if (!record) {
      throw new ActionRunError(
        `[ParioSqlite] Failed to load action run '${input.id}' for project '${input.projectId}'.`
      )
    }

    return record
  }

  async finish(input: FinishActionRunInput): Promise<ActionRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM action_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as DatabaseRow | null

      if (!existing) {
        throw new ActionRunError(
          `[ParioSqlite] Action run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      const metadata = mergeMetadata(parseMetadata(existing.metadata), input.metadata)

      this.db
        .query(
          `
          UPDATE action_runs
          SET
            status = ?,
            finished_at = ?,
            error_name = ?,
            error_message = ?,
            error_phase = ?,
            metadata = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          input.status === "succeeded" ? null : (input.error?.name ?? null),
          input.status === "succeeded" ? null : (input.error?.message ?? null),
          input.status === "succeeded" ? null : (input.error?.phase ?? null),
          serializeMetadata(metadata),
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

function serializeMetadata(
  metadata: Readonly<Record<string, JsonValue>> | undefined
): string | null {
  return metadata ? JSON.stringify(metadata) : null
}

function parseMetadata(value: string | null): Readonly<Record<string, JsonValue>> | undefined {
  return value ? (JSON.parse(value) as Readonly<Record<string, JsonValue>>) : undefined
}

function mergeMetadata(
  existing: Readonly<Record<string, JsonValue>> | undefined,
  next: Readonly<Record<string, JsonValue>> | undefined
): Readonly<Record<string, JsonValue>> | undefined {
  if (!existing && !next) {
    return undefined
  }

  return {
    ...(existing ?? {}),
    ...(next ?? {}),
  }
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
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    params: JSON.parse(row.params) as Readonly<Record<string, unknown>>,
    error: toActionRunFailure(row),
    metadata: parseMetadata(row.metadata),
  }
}

function rowToActionSubject(row: DatabaseRow): ActionSubject {
  if (row.subject_kind === "none") {
    return { kind: "none" }
  }

  if (!row.object_type_id || !row.primary_id) {
    throw new ActionRunError(`[ParioSqlite] Action run '${row.id}' has an invalid object subject.`)
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
  started_at: string
  finished_at: string | null
  params: string
  error_name: string | null
  error_message: string | null
  error_phase: ActionRunFailure["phase"] | null
  metadata: string | null
}
