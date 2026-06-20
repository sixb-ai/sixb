import type {
  ActionRunCommitDiff,
  ActionRunCommitRecord,
  ActionRunCommitSourceRow,
  ActionRunEffectsRecord,
  ActionRunFailure,
  ActionRunLinkDiffSourceRow,
  ActionRunObjectDiffPropertySourceRow,
  ActionRunObjectDiffSourceRow,
  ActionRunParams,
  ActionRunPhase,
  ActionRunRecord,
  ActionRunStorage,
  ActionRunWritebackRecord,
  ActionSubject,
  EnterActionRunPhaseInput,
  FinishActionRunInput,
  JsonValue,
  ListActionRunsInput,
  ListActionRunsResult,
  QueueActionRunInput,
  RecordActionCommitInput,
  RecordActionEffectsInput,
  RecordActionWritebackInput,
  SecurityContext,
  StartActionRunInput,
} from "@sixb/core"
import {
  ActionRunError,
  actionRunCommitDiffsEqual,
  actionRunPhaseRecordsEqual,
  buildActionRunCommitRecords,
  canRequeueActionRunAfterEnqueueFailure,
  finishActionRunPhase,
  isTerminalActionRun,
  normalizeActionRunCommitDiff,
} from "@sixb/core"
import { insertActionRunCommitDiff } from "./action-run-commit-diff"
import type { SQLClient, SqlParameter } from "./pg-client"
import { isUniqueViolation } from "./storage-errors"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgActionRunStorage implements ActionRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

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
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
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
    return runPgTransaction(this.sql, async (tx) => {
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
          writeback_status = ${null},
          writeback_completed_at = ${null},
          writeback_result = ${null},
          writeback_error_name = ${null},
          writeback_error_message = ${null},
          writeback_error_phase = ${null},
          effects_status = ${null},
          effects_completed_at = ${null},
          effects_error_name = ${null},
          effects_error_message = ${null},
          effects_error_phase = ${null},
          error_name = ${null},
          error_message = ${null},
          error_phase = ${null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      await this.deleteCommitRows(tx, input.projectId, input.id)

      return rowToActionRunRecord(updated)
    })
  }

  async start(input: StartActionRunInput): Promise<ActionRunRecord> {
    const [updated] = await this.sql<DatabaseRow[]>`
      UPDATE action_runs
      SET
        status = ${"running"},
        phase = ${input.phase ?? "validation"},
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

  async enterPhase(input: EnterActionRunPhaseInput): Promise<ActionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      await this.requireRunningRun(tx, input.projectId, input.id, "transition phase")

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE action_runs
        SET phase = ${input.phase}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToActionRunRecord(
        updated,
        await this.loadCommitRecord(tx, input.projectId, input.id)
      )
    })
  }

  async recordWriteback(input: RecordActionWritebackInput): Promise<ActionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await this.requireRunningRun(
        tx,
        input.projectId,
        input.id,
        "record writeback"
      )
      const nextWriteback = toWritebackRecord(input, new Date(input.completedAt ?? new Date()))
      const currentWriteback = toActionRunWritebackRecord(existing)

      if (currentWriteback) {
        if (actionRunPhaseRecordsEqual(currentWriteback, nextWriteback)) {
          return rowToActionRunRecord(
            existing,
            await this.loadCommitRecord(tx, input.projectId, input.id)
          )
        }

        throw new ActionRunError(
          `[SixbPg] Action run '${input.id}' already has a different writeback record.`
        )
      }

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE action_runs
        SET
          phase = ${"writeback"},
          writeback_status = ${input.status},
          writeback_completed_at = ${nextWriteback.completedAt},
          writeback_result = ${input.status === "succeeded" ? JSON.stringify(input.result) : null}::text::jsonb,
          writeback_error_name = ${input.status === "failed" ? (input.error.name ?? null) : null},
          writeback_error_message = ${input.status === "failed" ? input.error.message : null},
          writeback_error_phase = ${input.status === "failed" ? (input.error.phase ?? "writeback") : null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToActionRunRecord(
        updated,
        await this.loadCommitRecord(tx, input.projectId, input.id)
      )
    })
  }

  async recordCommit(input: RecordActionCommitInput): Promise<ActionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await this.requireRunningRun(tx, input.projectId, input.id, "record commit")
      const existingCommit = await this.loadCommitRecord(tx, input.projectId, input.id)
      const commit: ActionRunCommitRecord = {
        committedAt: new Date(input.committedAt ?? new Date()),
        diff: normalizeActionRunCommitDiff(input.diff),
      }

      if (existingCommit) {
        if (actionRunCommitDiffsEqual(existingCommit.diff, commit.diff)) {
          return rowToActionRunRecord(existing, existingCommit)
        }

        throw new ActionRunError(
          `[SixbPg] Action run '${input.id}' already has a different commit diff.`
        )
      }

      await tx`
        INSERT INTO action_run_commits (project_id, run_id, committed_at)
        VALUES (${input.projectId}, ${input.id}, ${commit.committedAt})
      `

      await insertActionRunCommitDiff(tx, input.projectId, input.id, commit.diff)

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE action_runs
        SET phase = ${"commit"}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToActionRunRecord(updated, commit)
    })
  }

  async recordEffects(input: RecordActionEffectsInput): Promise<ActionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await this.requireRunningRun(tx, input.projectId, input.id, "record effects")
      const nextEffects = toEffectsRecord(input, new Date(input.completedAt ?? new Date()))
      const currentEffects = toActionRunEffectsRecord(existing)

      if (currentEffects) {
        if (actionRunPhaseRecordsEqual(currentEffects, nextEffects)) {
          return rowToActionRunRecord(
            existing,
            await this.loadCommitRecord(tx, input.projectId, input.id)
          )
        }

        throw new ActionRunError(
          `[SixbPg] Action run '${input.id}' already has a different effects record.`
        )
      }

      const [updated] = await tx<DatabaseRow[]>`
        UPDATE action_runs
        SET
          phase = ${"effects"},
          effects_status = ${input.status},
          effects_completed_at = ${nextEffects.completedAt},
          effects_error_name = ${input.status === "failed" ? (input.error.name ?? null) : null},
          effects_error_message = ${input.status === "failed" ? input.error.message : null},
          effects_error_phase = ${input.status === "failed" ? (input.error.phase ?? "effects") : null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToActionRunRecord(
        updated,
        await this.loadCommitRecord(tx, input.projectId, input.id)
      )
    })
  }

  async finish(input: FinishActionRunInput): Promise<ActionRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
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

      const phase = finishActionRunPhase(input, existing.phase)

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

      return rowToActionRunRecord(
        updated,
        await this.loadCommitRecord(tx, input.projectId, input.id)
      )
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<ActionRunRecord | null> {
    const [row] = await this.sql<DatabaseRow[]>`
      SELECT * FROM action_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row
      ? rowToActionRunRecord(
          row,
          await this.loadCommitRecord(this.sql, params.projectId, params.id)
        )
      : null
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
    const commits = await this.loadCommitRecords(
      this.sql,
      input.projectId,
      rows.map((row) => row.id)
    )
    const runs = rows.map((row) => rowToActionRunRecord(row, commits.get(row.id)))

    return {
      runs,
      hasMore: offset + runs.length < total,
      total,
    }
  }

  private async requireRunningRun(
    runner: SQLClient,
    projectId: string,
    id: string,
    operation: string
  ): Promise<DatabaseRow> {
    const [existing] = await runner<DatabaseRow[]>`
      SELECT * FROM action_runs
      WHERE project_id = ${projectId} AND id = ${id}
      FOR UPDATE
    `

    if (!existing) {
      throw new ActionRunError(`[SixbPg] Action run '${id}' not found for project '${projectId}'.`)
    }

    if (existing.status !== "running") {
      throw new ActionRunError(
        `[SixbPg] Action run '${id}' cannot ${operation} from status '${existing.status}'.`
      )
    }

    return existing
  }

  private async deleteCommitRows(
    runner: SQLClient,
    projectId: string,
    runId: string
  ): Promise<void> {
    await runner`
      DELETE FROM action_run_link_diffs
      WHERE project_id = ${projectId} AND run_id = ${runId}
    `
    await runner`
      DELETE FROM action_run_object_diff_properties
      WHERE project_id = ${projectId} AND run_id = ${runId}
    `
    await runner`
      DELETE FROM action_run_object_diffs
      WHERE project_id = ${projectId} AND run_id = ${runId}
    `
    await runner`
      DELETE FROM action_run_commits
      WHERE project_id = ${projectId} AND run_id = ${runId}
    `
  }

  private async loadCommitRecord(
    runner: SQLClient,
    projectId: string,
    runId: string
  ): Promise<ActionRunCommitRecord | undefined> {
    return (await this.loadCommitRecords(runner, projectId, [runId])).get(runId)
  }

  private async loadCommitRecords(
    runner: SQLClient,
    projectId: string,
    runIds: readonly string[]
  ): Promise<Map<string, ActionRunCommitRecord>> {
    if (runIds.length === 0) {
      return new Map()
    }

    const placeholders = runIds.map((_, index) => `$${index + 2}`).join(", ")
    const params: SqlParameter[] = [projectId, ...runIds]
    const commitRows = await runner.unsafe<CommitRow[]>(
      `
        SELECT * FROM action_run_commits
        WHERE project_id = $1 AND run_id IN (${placeholders})
      `,
      params
    )

    if (commitRows.length === 0) {
      return new Map()
    }

    const objectRows = await runner.unsafe<ObjectDiffRow[]>(
      `
        SELECT * FROM action_run_object_diffs
        WHERE project_id = $1 AND run_id IN (${placeholders})
        ORDER BY run_id, object_type_id, primary_id, operation
      `,
      params
    )

    const propertyRows = await runner.unsafe<ObjectDiffPropertyRow[]>(
      `
        SELECT * FROM action_run_object_diff_properties
        WHERE project_id = $1 AND run_id IN (${placeholders})
        ORDER BY run_id, object_type_id, primary_id, property_id
      `,
      params
    )

    const linkRows = await runner.unsafe<LinkDiffRow[]>(
      `
        SELECT * FROM action_run_link_diffs
        WHERE project_id = $1 AND run_id IN (${placeholders})
        ORDER BY
          run_id,
          source_object_type_id,
          source_primary_id,
          link_id,
          target_object_type_id,
          target_primary_id,
          operation
      `,
      params
    )

    return buildActionRunCommitRecords(
      commitRows.map(toCommitSourceRow),
      objectRows.map(toObjectDiffSourceRow),
      propertyRows.map(toObjectDiffPropertySourceRow),
      linkRows.map(toLinkDiffSourceRow)
    )
  }
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
      result: (row.writeback_result ?? null) as JsonValue,
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

function rowToActionRunRecord(row: DatabaseRow, commit?: ActionRunCommitRecord): ActionRunRecord {
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
    writeback: toActionRunWritebackRecord(row),
    commit,
    effects: toActionRunEffectsRecord(row),
    error: toActionRunFailure(row),
  }
}

function toCommitSourceRow(row: CommitRow): ActionRunCommitSourceRow {
  return {
    runId: row.run_id,
    committedAt: row.committed_at,
  }
}

function toObjectDiffSourceRow(row: ObjectDiffRow): ActionRunObjectDiffSourceRow {
  return {
    runId: row.run_id,
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    operation: row.operation,
  }
}

function toObjectDiffPropertySourceRow(
  row: ObjectDiffPropertyRow
): ActionRunObjectDiffPropertySourceRow {
  return {
    runId: row.run_id,
    objectTypeId: row.object_type_id,
    primaryId: row.primary_id,
    propertyId: row.property_id,
  }
}

function toLinkDiffSourceRow(row: LinkDiffRow): ActionRunLinkDiffSourceRow {
  return {
    runId: row.run_id,
    operation: row.operation,
    sourceObjectTypeId: row.source_object_type_id,
    sourcePrimaryId: row.source_primary_id,
    linkId: row.link_id,
    targetObjectTypeId: row.target_object_type_id,
    targetPrimaryId: row.target_primary_id,
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
  writeback_status: ActionRunWritebackRecord["status"] | null
  writeback_completed_at: Date | string | null
  writeback_result: JsonValue | null
  writeback_error_name: string | null
  writeback_error_message: string | null
  writeback_error_phase: ActionRunPhase | null
  effects_status: ActionRunEffectsRecord["status"] | null
  effects_completed_at: Date | string | null
  effects_error_name: string | null
  effects_error_message: string | null
  effects_error_phase: ActionRunPhase | null
  error_name: string | null
  error_message: string | null
  error_phase: ActionRunPhase | null
}

interface CommitRow {
  project_id: string
  run_id: string
  committed_at: Date | string
}

interface ObjectDiffRow {
  project_id: string
  run_id: string
  object_type_id: string
  primary_id: string
  operation: ActionRunCommitDiff["objects"][number]["operation"]
}

interface ObjectDiffPropertyRow {
  project_id: string
  run_id: string
  object_type_id: string
  primary_id: string
  property_id: string
}

interface LinkDiffRow {
  project_id: string
  run_id: string
  operation: ActionRunCommitDiff["links"][number]["operation"]
  source_object_type_id: string
  source_primary_id: string
  link_id: string
  target_object_type_id: string
  target_primary_id: string
}
