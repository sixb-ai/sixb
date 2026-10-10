import type { ActionSubject, JsonValue } from "@sixb/core"
import {
  parseActionRunFailure,
  serializeActionRunFailure,
} from "@sixb/core/internal/action-run-storage"
import { assertActionRunExecution } from "@sixb/core/internal/action-run-storage-provider"
import { normalizeRecordActionRunInput, resolveActionRunEffects } from "@sixb/core/internal/storage"
import type {
  ActionRunEffectsRecord,
  ActionRunParams,
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
import type { SqlParameter } from "./pg-client"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgActionRunStorage implements ActionRunStorage {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly executions: ExecutionStorage
  ) {}

  async record(input: RecordActionRunInput): Promise<ActionRunRecord> {
    const record = normalizeRecordActionRunInput(input)
    await assertActionRunExecution({
      executions: this.executions,
      projectId: record.projectId,
      executionId: record.executionId,
      runId: record.id,
      actionId: record.actionId,
    })

    // A conflict with a committed record is answered as a refusal rather than raised: a raised
    // unique violation would abort the caller's transaction before the error could say what
    // conflicted. A conflict with a concurrent transaction's insert waits for that transaction;
    // under the serializable isolation of an Action commit, it then fails with a serialization
    // error, which the Materializer retries into a replay of the commit that won.
    const [row] = await this.sql<DatabaseRow[]>`
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
      ) VALUES (
        ${record.projectId},
        ${record.id},
        ${record.executionId},
        ${record.actionId},
        ${record.subject.kind},
        ${record.subject.kind === "object" ? record.subject.objectTypeId : null},
        ${record.subject.kind === "object" ? record.subject.primaryId : null},
        ${record.status},
        ${record.phase},
        ${record.startedAt},
        ${record.finishedAt},
        ${JSON.stringify(record.params)}::text::jsonb,
        ${record.idempotencyKey},
        ${record.writeback?.status ?? null},
        ${record.writeback?.completedAt ?? null},
        ${record.writeback?.status === "succeeded" ? JSON.stringify(record.writeback.result) : null}::text::jsonb,
        ${record.writeback?.status === "failed" ? serializeActionRunFailure(record.writeback.error, "writeback") : null}::text::jsonb,
        ${record.status === "failed" ? serializeActionRunFailure(record.error) : null}::text::jsonb
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `
    if (row) return rowToActionRunRecord(row)

    const [conflict] = await this.sql<{ id: string }[]>`
      SELECT id FROM action_runs
      WHERE project_id = ${record.projectId} AND id = ${record.id}
    `
    throw new ActionRunError(
      conflict
        ? `[SixbPg] Action run '${record.id}' is already recorded for project '${record.projectId}'.`
        : `[SixbPg] Execution '${record.executionId}' already belongs to another Action run.`
    )
  }

  async recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<DatabaseRow[]>`
        SELECT * FROM action_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      const { run, effects } = resolveActionRunEffects(
        existing ? rowToActionRunRecord(existing) : null,
        input
      )
      if (!effects) return run

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE action_runs
        SET
          phase = ${"effects"},
          effects_status = ${effects.status},
          effects_completed_at = ${effects.completedAt},
          effects_error = ${effects.status === "failed" ? serializeActionRunFailure(effects.error, "effects") : null}::text::jsonb
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
    if ((input.statuses && input.statuses.length === 0) || input.actionIds?.length === 0) {
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

    if (input.actionIds) {
      const placeholders = input.actionIds.map(() => `$${index++}`)
      whereClauses.push(`action_id IN (${placeholders.join(", ")})`)
      params.push(...input.actionIds)
    }

    if (input.objectTypeIds) {
      if (input.objectTypeIds.length === 0) {
        whereClauses.push(`subject_kind <> $${index++}`)
        params.push("object")
      } else {
        const subjectKindIndex = index++
        const placeholders = input.objectTypeIds.map(() => `$${index++}`)
        whereClauses.push(
          `(subject_kind <> $${subjectKindIndex} OR object_type_id IN (${placeholders.join(", ")}))`
        )
        params.push("object", ...input.objectTypeIds)
      }
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

    const [totalRow] = await this.sql.unsafe<{ count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM action_runs ${where}`,
      params
    )

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

    const rows = await this.sql.unsafe<DatabaseRow[]>(query, queryParams)
    const total = Number(totalRow?.count ?? 0)
    const runs = rows.map((row) => rowToActionRunRecord(row))

    return {
      runs,
      hasMore: offset + runs.length < total,
      total,
    }
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
      result: row.writeback_result ?? null,
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
    params: row.params,
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
  execution_id: string
  action_id: string
  subject_kind: ActionSubject["kind"]
  object_type_id: string | null
  primary_id: string | null
  status: ActionRunStatus
  phase: ActionRunPhase
  started_at: Date | string
  finished_at: Date | string
  params: ActionRunParams
  idempotency_key: string
  writeback_status: ActionRunWritebackRecord["status"] | null
  writeback_completed_at: Date | string | null
  writeback_result: JsonValue | null
  writeback_error: unknown | null
  effects_status: ActionRunEffectsRecord["status"] | null
  effects_completed_at: Date | string | null
  effects_error: unknown | null
  error: unknown | null
}
