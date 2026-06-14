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
import type { SQL, SqlParameter } from "./pg-client"
import { isUniqueViolation } from "./storage-errors"

export class PgActionRunStorage implements ActionRunStorage {
  constructor(private readonly sql: SQL) {}

  async queue(input: QueueActionRunInput): Promise<ActionRunRecord> {
    try {
      const [row] = await this.sql<DatabaseRow[]>`
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
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.actionId},
          ${input.subject.kind},
          ${input.subject.kind === "object" ? input.subject.objectTypeId : null},
          ${input.subject.kind === "object" ? input.subject.primaryId : null},
          ${"queued"},
          ${"request"},
          ${input.queuedAt ?? new Date()},
          ${null},
          ${null},
          ${JSON.stringify(input.params)}::text::jsonb,
          ${input.idempotencyKey},
          ${serializeSecurityContext(input.securityContext)}::text::jsonb,
          ${null},
          ${null},
          ${null}
        )
        RETURNING *
      `

      return rowToActionRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        return this.requeueAfterEnqueueFailure(input)
      }

      throw error
    }
  }

  private async requeueAfterEnqueueFailure(input: QueueActionRunInput): Promise<ActionRunRecord> {
    return this.sql.begin(async (tx) => {
      const [existing] = await tx<DatabaseRow[]>`
        SELECT * FROM action_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      if (
        !existing ||
        !canRequeueActionRunAfterEnqueueFailure(rowToActionRunRecord(existing), input)
      ) {
        throw new ActionRunError(
          `[SixbPg] Action run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE action_runs
        SET
          status = ${"queued"},
          phase = ${"request"},
          queued_at = ${input.queuedAt ?? new Date()},
          started_at = ${null},
          finished_at = ${null},
          security_context = ${serializeSecurityContext(input.securityContext)}::text::jsonb,
          error_name = ${null},
          error_message = ${null},
          error_phase = ${null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToActionRunRecord(updated)
    })
  }

  async start(input: StartActionRunInput): Promise<ActionRunRecord> {
    const [updated] = await this.sql<DatabaseRow[]>`
      UPDATE action_runs
      SET
        status = ${"running"},
        phase = ${"handler"},
        started_at = ${input.startedAt ?? new Date()},
        error_name = ${null},
        error_message = ${null},
        error_phase = ${null}
      WHERE project_id = ${input.projectId}
        AND id = ${input.id}
        AND status = ${"queued"}
      RETURNING *
    `

    if (updated) {
      return rowToActionRunRecord(updated)
    }

    const existing = await this.getById({ projectId: input.projectId, id: input.id })
    if (!existing) {
      throw new ActionRunError(
        `[SixbPg] Action run '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    throw new ActionRunError(
      `[SixbPg] Action run '${input.id}' cannot start from status '${existing.status}'.`
    )
  }

  async finish(input: FinishActionRunInput): Promise<ActionRunRecord> {
    return this.sql.begin(async (tx) => {
      const [existing] = await tx<DatabaseRow[]>`
        SELECT * FROM action_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      if (!existing) {
        throw new ActionRunError(
          `[SixbPg] Action run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (isTerminalActionRun({ status: existing.status })) {
        throw new ActionRunError(
          `[SixbPg] Action run '${input.id}' cannot finish from terminal status '${existing.status}'.`
        )
      }

      const phase = finishPhase(input, existing.phase)

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE action_runs
        SET
          status = ${input.status},
          phase = ${phase},
          finished_at = ${input.finishedAt ?? new Date()},
          error_name = ${input.status === "succeeded" ? null : (input.error?.name ?? null)},
          error_message = ${input.status === "succeeded" ? null : (input.error?.message ?? null)},
          error_phase = ${input.status === "succeeded" ? null : (input.error?.phase ?? phase)}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToActionRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null> {
    const [row] = await this.sql<DatabaseRow[]>`
      SELECT * FROM action_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

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
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.actionId) {
      whereClauses.push(`action_id = $${index++}`)
      params.push(input.actionId)
    }

    if (input.objectTypeId) {
      whereClauses.push(`subject_kind = $${index++}`)
      params.push("object")
      whereClauses.push(`object_type_id = $${index++}`)
      params.push(input.objectTypeId)
    }

    if (input.primaryId) {
      whereClauses.push(`subject_kind = $${index++}`)
      params.push("object")
      whereClauses.push(`primary_id = $${index++}`)
      params.push(input.primaryId)
    }

    if (input.subject) {
      whereClauses.push(`subject_kind = $${index++}`)
      params.push(input.subject.kind)
      if (input.subject.kind === "object") {
        whereClauses.push(`object_type_id = $${index++}`)
        params.push(input.subject.objectTypeId)
        whereClauses.push(`primary_id = $${index++}`)
        params.push(input.subject.primaryId)
      }
    }

    if (input.statuses) {
      const placeholders = input.statuses.map(() => `$${index++}`)
      whereClauses.push(`status IN (${placeholders.join(", ")})`)
      params.push(...input.statuses)
    }

    if (input.startedAfter) {
      whereClauses.push(`COALESCE(started_at, queued_at) >= $${index++}`)
      params.push(input.startedAfter)
    }

    if (input.startedBefore) {
      whereClauses.push(`COALESCE(started_at, queued_at) <= $${index++}`)
      params.push(input.startedBefore)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0

    const [totalRow] = await this.sql.unsafe<{ count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM action_runs ${where}`,
      params
    )

    const queryParams = [...params]
    let query = `
      SELECT * FROM action_runs
      ${where}
      ORDER BY COALESCE(started_at, queued_at) ${order}, id ${order}
    `

    if (input.limit !== undefined) {
      query += ` LIMIT $${index++} OFFSET $${index++}`
      queryParams.push(input.limit, offset)
    } else if (offset > 0) {
      query += ` OFFSET $${index++}`
      queryParams.push(offset)
    }

    const rows = await this.sql.unsafe<DatabaseRow[]>(query, queryParams)
    const total = Number(totalRow?.count ?? 0)
    const runs = rows.map(rowToActionRunRecord)

    return {
      runs,
      hasMore: offset + runs.length < total,
      total,
    }
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

function normalizeSecurityContext(
  value: SecurityContext | string | null
): SecurityContext | undefined {
  if (!value) {
    return undefined
  }
  return typeof value === "string" ? (JSON.parse(value) as SecurityContext) : value
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
    params: row.params,
    idempotencyKey: row.idempotency_key,
    securityContext: normalizeSecurityContext(row.security_context),
    error: toActionRunFailure(row),
  }
}

function rowToActionSubject(row: DatabaseRow): ActionSubject {
  if (row.subject_kind === "none") {
    return { kind: "none" }
  }

  if (!row.object_type_id || !row.primary_id) {
    throw new ActionRunError(`[SixbPg] Action run '${row.id}' has an invalid object subject.`)
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
  action_id: string
  subject_kind: ActionSubject["kind"]
  object_type_id: string | null
  primary_id: string | null
  status: ActionRunRecord["status"]
  phase: ActionRunPhase | null
  queued_at: Date | string
  started_at: Date | string | null
  finished_at: Date | string | null
  params: ActionRunParams
  idempotency_key: string
  security_context: SecurityContext | string | null
  error_name: string | null
  error_message: string | null
  error_phase: ActionRunFailure["phase"] | null
}
