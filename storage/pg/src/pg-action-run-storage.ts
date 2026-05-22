import type {
  ActionRunFailure,
  ActionRunRecord,
  ActionRunStorage,
  FinishActionRunInput,
  JsonValue,
  ListActionRunsInput,
  ListActionRunsResult,
  StartActionRunInput,
} from "@pario/core"
import { ActionRunError } from "@pario/core"
import type { SQL } from "bun"

export class PgActionRunStorage implements ActionRunStorage {
  constructor(private readonly sql: SQL) {}

  async start(input: StartActionRunInput): Promise<ActionRunRecord> {
    try {
      const [row] = (await this.sql`
        INSERT INTO action_runs (
          project_id,
          id,
          action_id,
          object_type_id,
          primary_id,
          status,
          started_at,
          params,
          metadata
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.actionId},
          ${input.objectTypeId},
          ${input.primaryId},
          ${"running"},
          ${input.startedAt ?? new Date()},
          ${JSON.stringify(input.params)}::text::jsonb,
          ${serializeMetadata(input.metadata)}::text::jsonb
        )
        RETURNING *
      `) as DatabaseRow[]

      return rowToActionRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ActionRunError(
          `[ParioPg] Action run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async finish(input: FinishActionRunInput): Promise<ActionRunRecord> {
    return this.sql.begin(async (tx) => {
      const [existing] = (await tx`
        SELECT * FROM action_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
      `) as DatabaseRow[]

      if (!existing) {
        throw new ActionRunError(
          `[ParioPg] Action run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      const metadata = mergeMetadata(existing.metadata, input.metadata)

      const [updated] =
        input.status === "succeeded"
          ? ((await tx`
              UPDATE action_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                error_name = ${null},
                error_message = ${null},
                error_phase = ${null},
                metadata = ${serializeMetadata(metadata)}::text::jsonb
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `) as DatabaseRow[])
          : ((await tx`
              UPDATE action_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                error_name = ${input.error?.name ?? null},
                error_message = ${input.error?.message ?? null},
                error_phase = ${input.error?.phase ?? null},
                metadata = ${serializeMetadata(metadata)}::text::jsonb
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `) as DatabaseRow[])

      return rowToActionRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null> {
    const [row] = (await this.sql`
      SELECT * FROM action_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `) as DatabaseRow[]

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

    const whereClauses = ["project_id = $1"]
    const params: unknown[] = [input.projectId]
    let index = 2

    if (input.actionId) {
      whereClauses.push(`action_id = $${index++}`)
      params.push(input.actionId)
    }

    if (input.objectTypeId) {
      whereClauses.push(`object_type_id = $${index++}`)
      params.push(input.objectTypeId)
    }

    if (input.primaryId) {
      whereClauses.push(`primary_id = $${index++}`)
      params.push(input.primaryId)
    }

    if (input.statuses) {
      const placeholders = input.statuses.map(() => `$${index++}`)
      whereClauses.push(`status IN (${placeholders.join(", ")})`)
      params.push(...input.statuses)
    }

    if (input.startedAfter) {
      whereClauses.push(`started_at >= $${index++}`)
      params.push(input.startedAfter)
    }

    if (input.startedBefore) {
      whereClauses.push(`started_at <= $${index++}`)
      params.push(input.startedBefore)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0

    const [totalRow] = (await this.sql.unsafe(
      `SELECT COUNT(*)::bigint AS count FROM action_runs ${where}`,
      params
    )) as { count: string | number }[]

    const queryParams = [...params]
    let query = `
      SELECT * FROM action_runs
      ${where}
      ORDER BY started_at ${order}, id ${order}
    `

    if (input.limit !== undefined) {
      query += ` LIMIT $${index++} OFFSET $${index++}`
      queryParams.push(input.limit, offset)
    } else if (offset > 0) {
      query += ` OFFSET $${index++}`
      queryParams.push(offset)
    }

    const rows = (await this.sql.unsafe(query, queryParams)) as DatabaseRow[]
    const total = Number(totalRow?.count ?? 0)
    const runs = rows.map(rowToActionRunRecord)

    return {
      runs,
      hasMore: offset + runs.length < total,
      total,
    }
  }
}

function serializeMetadata(
  metadata: Readonly<Record<string, JsonValue>> | undefined
): string | null {
  return metadata ? JSON.stringify(metadata) : null
}

function mergeMetadata(
  existing: Readonly<Record<string, JsonValue>> | null | undefined,
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
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    status: row.status,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    params: row.params,
    error: toActionRunFailure(row),
    metadata: row.metadata ?? undefined,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /duplicate key value|unique/i.test(error.message)
}

interface DatabaseRow {
  project_id: string
  id: string
  action_id: string
  object_type_id: string
  primary_id: string
  status: ActionRunRecord["status"]
  started_at: Date | string
  finished_at: Date | string | null
  params: Readonly<Record<string, unknown>>
  error_name: string | null
  error_message: string | null
  error_phase: ActionRunFailure["phase"] | null
  metadata: Readonly<Record<string, JsonValue>> | null
}
