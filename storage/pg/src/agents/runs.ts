import {
  type AgentRunRecord,
  type AgentRunStore,
  AgentStorageError,
  type FinishAgentRunInput,
  type ListAgentRunsInput,
  type ListAgentRunsResult,
  type ReclaimAgentRunInput,
  type RenewAgentRunLeaseInput,
  type ReserveAgentRunInput,
} from "@sixb/core"
import type { SQLClient, SqlParameter } from "../pg-client"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "../run-list-query"
import { isUniqueViolation } from "../storage-errors"
import { type PgStoreClient, runPgTransaction } from "../transactions"
import { type AgentRunRow, rowToRunRecord } from "./rows"

export class PgAgentRunStore implements AgentRunStore {
  constructor(private readonly sql: PgStoreClient) {}

  async reserve(input: ReserveAgentRunInput): Promise<AgentRunRecord> {
    const createdAt = input.createdAt ?? new Date()
    const startedAt = input.startedAt ?? createdAt

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
            status,
            model_id,
            attempt,
            lease_id,
            lease_expires_at,
            created_at,
            started_at
          ) VALUES (
            ${input.projectId},
            ${input.id},
            ${input.threadId},
            ${input.agentId},
            ${input.triggerMessageId},
            ${"running"},
            ${input.modelId ?? null},
            ${1},
            ${input.lease.id},
            ${input.lease.expiresAt},
            ${createdAt},
            ${startedAt}
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

  async renewLease(input: RenewAgentRunLeaseInput): Promise<AgentRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const run = await this.lockRunning(tx, input.projectId, input.id)

      if (run.lease_id !== input.leaseId) {
        throw new AgentStorageError(
          "lease_lost",
          `[SixbPg] Lease '${input.leaseId}' is no longer held on agent run '${input.id}'.`
        )
      }

      const [row] = await tx<AgentRunRow[]>`
        UPDATE agent_runs SET lease_expires_at = ${input.expiresAt}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToRunRecord(row)
    })
  }

  async reclaim(input: ReclaimAgentRunInput): Promise<AgentRunRecord> {
    const now = input.now ?? new Date()

    return runPgTransaction(this.sql, async (tx) => {
      const run = await this.lockRunning(tx, input.projectId, input.id)

      if (!run.lease_expires_at) {
        throw new AgentStorageError(
          "invalid_state",
          `[SixbPg] Agent run '${input.id}' has no lease to reclaim.`
        )
      }

      if (new Date(run.lease_expires_at).getTime() > now.getTime()) {
        throw new AgentStorageError(
          "lease_not_expired",
          `[SixbPg] Lease on agent run '${input.id}' has not expired yet.`
        )
      }

      const [row] = await tx<AgentRunRow[]>`
        UPDATE agent_runs
        SET attempt = attempt + 1, lease_id = ${input.lease.id}, lease_expires_at = ${input.lease.expiresAt}
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

      if (run.lease_id !== input.leaseId) {
        throw new AgentStorageError(
          "lease_lost",
          `[SixbPg] Lease '${input.leaseId}' is no longer held on agent run '${input.id}'.`
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
          lease_id = ${null},
          lease_expires_at = ${null},
          completed_at = ${completedAt}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      // Release the thread's single-flight anchor, but only if it still points at this run.
      await tx`
        UPDATE agent_threads SET active_run_id = ${null}, updated_at = ${completedAt}
        WHERE project_id = ${input.projectId} AND id = ${run.thread_id} AND active_run_id = ${input.id}
      `

      return rowToRunRecord(row)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentRunRecord | null> {
    const [row] = await this.sql<AgentRunRow[]>`
      SELECT * FROM agent_runs WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row ? rowToRunRecord(row) : null
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

    index = appendRunListFilters(whereClauses, params, index, input)

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

  private async lockRunning(sql: SQLClient, projectId: string, id: string): Promise<AgentRunRow> {
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

    if (row.status !== "running") {
      throw new AgentStorageError(
        "invalid_state",
        `[SixbPg] Agent run '${id}' is not running (status '${row.status}').`
      )
    }

    return row
  }
}
