import {
  type AgentRunRecord,
  type AgentRunStore,
  AgentStorageError,
  type ConfirmAgentRunExecutionOwnershipInput,
  type CreateAgentRunInput,
  type FinishAgentRunInput,
  type FinishQueuedAgentRunInput,
  type ListAgentRunsInput,
  type ListAgentRunsResult,
  type ReclaimAgentRunInput,
  type StartAgentRunInput,
} from "@sixb/core"
import type { SQLClient, SqlParameter } from "../pg-client"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "../run-list-query"
import { isUniqueViolation } from "../storage-errors"
import { type PgStoreClient, runPgTransaction } from "../transactions"
import { type AgentRunRow, rowToRunRecord } from "./rows"

const PG_RUN_ID_BATCH_SIZE = 10_000

export class PgAgentRunStore implements AgentRunStore {
  constructor(private readonly sql: PgStoreClient) {}

  async create(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    const createdAt = input.createdAt ?? new Date()

    try {
      return await runPgTransaction(this.sql, async (tx) => {
        const [thread] = await tx<{ active_run_id: string | null }[]>`
          SELECT active_run_id FROM agent_threads
          WHERE project_id = ${input.projectId} AND id = ${input.threadId}
          FOR UPDATE
        `

        if (!thread) {
          throw new AgentStorageError(
            "thread_not_found",
            `[SixbPg] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
          )
        }

        if (thread.active_run_id !== null) {
          throw new AgentStorageError(
            "active_run_exists",
            `[SixbPg] Agent thread '${input.threadId}' already has an active run '${thread.active_run_id}'.`
          )
        }

        const [row] = await tx<AgentRunRow[]>`
          INSERT INTO agent_runs (
            project_id,
            id,
            thread_id,
            agent_id,
            trigger_message_id,
            requested_by_principal_type,
            requested_by_principal_id,
            status,
            attempt,
            created_at
          ) VALUES (
            ${input.projectId},
            ${input.id},
            ${input.threadId},
            ${input.agentId},
            ${input.triggerMessageId},
            ${input.requestedByPrincipal.type},
            ${input.requestedByPrincipal.id},
            ${"queued"},
            ${0},
            ${createdAt}
          )
          RETURNING *
        `

        await tx`
          UPDATE agent_threads SET active_run_id = ${input.id}, updated_at = ${createdAt}
          WHERE project_id = ${input.projectId} AND id = ${input.threadId}
        `

        return rowToRunRecord(row)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbPg] Agent run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async start(input: StartAgentRunInput): Promise<AgentRunRecord> {
    const startedAt = input.startedAt ?? new Date()
    return runPgTransaction(this.sql, async (tx) => {
      await this.lockStatus(tx, input.projectId, input.id, "queued")
      const [row] = await tx<AgentRunRow[]>`
        UPDATE agent_runs
        SET
          status = ${"running"},
          execution_principal_type = ${input.executionPrincipal?.type ?? null},
          execution_principal_id = ${input.executionPrincipal?.id ?? null},
          model_id = ${input.modelId ?? null},
          attempt = ${1},
          execution_token = ${input.execution.token},
          execution_queue_lease_expires_at = ${input.execution.queueLeaseExpiresAt},
          started_at = ${startedAt}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `
      return rowToRunRecord(row)
    })
  }

  async finishQueued(input: FinishQueuedAgentRunInput): Promise<AgentRunRecord> {
    const completedAt = input.completedAt ?? new Date()
    return runPgTransaction(this.sql, async (tx) => {
      const run = await this.lockStatus(tx, input.projectId, input.id, "queued")
      const [row] = await tx<AgentRunRow[]>`
        UPDATE agent_runs
        SET status = ${input.status}, error = ${input.error ?? null}, completed_at = ${completedAt}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `
      await this.releaseThread(tx, run, completedAt)
      return rowToRunRecord(row)
    })
  }

  async reclaim(input: ReclaimAgentRunInput): Promise<AgentRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      await this.lockRunning(tx, input.projectId, input.id)
      const [row] = await tx<AgentRunRow[]>`
        UPDATE agent_runs
        SET
          attempt = attempt + 1,
          execution_token = ${input.execution.token},
          execution_queue_lease_expires_at = ${input.execution.queueLeaseExpiresAt}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToRunRecord(row)
    })
  }

  async confirmExecutionOwnership(
    input: ConfirmAgentRunExecutionOwnershipInput
  ): Promise<AgentRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const run = await this.lockRunning(tx, input.projectId, input.id)
      if (run.execution_token !== input.executionToken) {
        throw new AgentStorageError(
          "execution_lost",
          `[SixbPg] Execution token is no longer current on agent run '${input.id}'.`
        )
      }

      const [row] = await tx<AgentRunRow[]>`
        UPDATE agent_runs
        SET execution_queue_lease_expires_at = GREATEST(
          execution_queue_lease_expires_at,
          ${input.queueLeaseExpiresAt}
        )
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `
      return rowToRunRecord(row)
    })
  }

  async finish(input: FinishAgentRunInput): Promise<AgentRunRecord> {
    const completedAt = input.completedAt ?? new Date()
    const errorValue = input.status === "succeeded" ? null : (input.error ?? null)

    return runPgTransaction(this.sql, async (tx) => {
      const run = await this.lockRunning(tx, input.projectId, input.id)

      if (run.execution_token !== input.executionToken) {
        throw new AgentStorageError(
          "execution_lost",
          `[SixbPg] Execution token is no longer current on agent run '${input.id}'.`
        )
      }

      const [row] = await tx<AgentRunRow[]>`
        UPDATE agent_runs
        SET
          status = ${input.status},
          model_id = COALESCE(${input.modelId ?? null}, model_id),
          finish_reason = ${input.finishReason ?? null},
          usage_input_tokens = ${input.usage?.inputTokens ?? null},
          usage_output_tokens = ${input.usage?.outputTokens ?? null},
          usage_total_tokens = ${input.usage?.totalTokens ?? null},
          usage_reasoning_tokens = ${input.usage?.reasoningTokens ?? null},
          usage_cached_input_tokens = ${input.usage?.cachedInputTokens ?? null},
          error = ${errorValue},
          diagnostics = ${input.diagnostics === undefined ? null : JSON.stringify(input.diagnostics)}::text::jsonb,
          execution_token = ${null},
          execution_queue_lease_expires_at = ${null},
          completed_at = ${completedAt}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      await this.releaseThread(tx, run, completedAt)

      return rowToRunRecord(row)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentRunRecord | null> {
    const [row] = await this.sql<AgentRunRow[]>`
      SELECT * FROM agent_runs WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row ? rowToRunRecord(row) : null
  }

  async getByIds(params: {
    projectId: string
    ids: readonly string[]
  }): Promise<readonly AgentRunRecord[]> {
    const ids = [...new Set(params.ids)]
    if (ids.length === 0) {
      return []
    }

    const rows: AgentRunRow[] = []
    for (let offset = 0; offset < ids.length; offset += PG_RUN_ID_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + PG_RUN_ID_BATCH_SIZE)
      const placeholders = batch.map((_, index) => `$${index + 2}`).join(", ")
      rows.push(
        ...(await this.sql.unsafe<AgentRunRow[]>(
          `SELECT * FROM agent_runs WHERE project_id = $1 AND id IN (${placeholders})`,
          [params.projectId, ...batch] as SqlParameter[]
        ))
      )
    }
    const byId = new Map(rows.map((row) => [row.id, rowToRunRecord(row)]))
    return ids.flatMap((id) => {
      const run = byId.get(id)
      return run ? [run] : []
    })
  }

  async list(input: ListAgentRunsInput): Promise<ListAgentRunsResult> {
    if (hasEmptyStatuses(input)) {
      return { runs: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.threadId) {
      whereClauses.push(`thread_id = $${index++}`)
      params.push(input.threadId)
    }

    if (input.agentId) {
      whereClauses.push(`agent_id = $${index++}`)
      params.push(input.agentId)
    }

    index = appendRunListFilters(
      whereClauses,
      params,
      index,
      input,
      "COALESCE(started_at, created_at)"
    )

    const { rows, total, hasMore } = await queryRunList<AgentRunRow>({
      sql: this.sql,
      tableName: "agent_runs",
      whereClauses,
      params,
      nextIndex: index,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })

    return { runs: rows.map(rowToRunRecord), hasMore, total }
  }

  private lockRunning(sql: SQLClient, projectId: string, id: string): Promise<AgentRunRow> {
    return this.lockStatus(sql, projectId, id, "running")
  }

  private async lockStatus(
    sql: SQLClient,
    projectId: string,
    id: string,
    status: AgentRunRecord["status"]
  ): Promise<AgentRunRow> {
    const [row] = await sql<AgentRunRow[]>`
      SELECT * FROM agent_runs
      WHERE project_id = ${projectId} AND id = ${id}
      FOR UPDATE
    `

    if (!row) {
      throw new AgentStorageError(
        "run_not_found",
        `[SixbPg] Agent run '${id}' not found for project '${projectId}'.`
      )
    }

    if (row.status !== status) {
      throw new AgentStorageError(
        "invalid_state",
        `[SixbPg] Agent run '${id}' is not ${status} (status '${row.status}').`
      )
    }

    return row
  }

  private async releaseThread(sql: SQLClient, run: AgentRunRow, completedAt: Date): Promise<void> {
    await sql`
      UPDATE agent_threads SET active_run_id = ${null}, updated_at = ${completedAt}
      WHERE project_id = ${run.project_id} AND id = ${run.thread_id} AND active_run_id = ${run.id}
    `
  }
}
