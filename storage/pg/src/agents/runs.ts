import {
  agentRunMayHoldCalls,
  assertAgentRunExecution,
  assertAwaitingApprovalFinish,
  assertConversationAgentRunSpec,
  assertConversationThreadRow,
  assertCreateSubagentRunInput,
  assertSubagentRunResult,
  assertSubagentThreadTakesRun,
  newSubagentThreadRecord,
  subagentRunMatchesCreateInput,
} from "@sixb/core/internal/agent-run-storage-provider"
import { AGENT_MESSAGE_CONTENT_VERSION } from "@sixb/core/internal/agents"
import { serializeSixbFailure } from "@sixb/core/internal/errors"
import {
  AGENT_RUN_FAILURE_CODES,
  type AgentRunRecord,
  type AgentRunStore,
  AgentStorageError,
  type ConfirmAgentRunExecutionOwnershipInput,
  type ConversationAgentRunRecord,
  type CreateAgentRunInput,
  type CreateSubagentRunInput,
  type ExecutionStorage,
  type FinishAgentRunInput,
  type FinishQueuedAgentRunInput,
  type ListAgentRunsInput,
  type ListAgentRunsResult,
  type ReclaimAgentRunInput,
  type StartAgentRunInput,
  type SubagentRunRecord,
} from "@sixb/core/storage"
import type { SQLClient, SqlParameter } from "../pg-client"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "../run-list-query"
import { isUniqueViolation } from "../storage-errors"
import { type PgStoreClient, runPgTransaction } from "../transactions"
import { pgHoldsRun } from "./approvals"
import { type AgentRunRow, type AgentThreadRow, rowToRunRecord, rowToThreadRecord } from "./rows"

const PG_RUN_ID_BATCH_SIZE = 10_000

export class PgAgentRunStore implements AgentRunStore {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly executions: ExecutionStorage
  ) {}

  async create(input: CreateAgentRunInput): Promise<ConversationAgentRunRecord> {
    assertConversationAgentRunSpec(input.spec, "SixbPg")
    const createdAt = input.createdAt ?? new Date()
    await assertAgentRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
    })

    try {
      return await runPgTransaction(this.sql, async (tx) => {
        const [thread] = await tx<Pick<AgentThreadRow, "id" | "kind" | "active_run_id">[]>`
          SELECT id, kind, active_run_id FROM agent_threads
          WHERE project_id = ${input.projectId} AND id = ${input.threadId}
          FOR UPDATE
        `

        if (!thread) {
          throw new AgentStorageError(
            "thread_not_found",
            `[SixbPg] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
          )
        }
        assertConversationThreadRow(thread, "takes turns", "SixbPg")
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
            execution_id,
            kind,
            thread_id,
            trigger_message_id,
            spec,
            status,
            attempt,
            created_at
          ) VALUES (
            ${input.projectId},
            ${input.id},
            ${input.executionId},
            ${"conversation"},
            ${input.threadId},
            ${input.triggerMessageId},
            ${JSON.stringify(input.spec)}::text::jsonb,
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

        const created = rowToRunRecord(row)
        if (created.kind !== "conversation") {
          throw new Error(`[SixbPg] Agent run insert '${input.id}' returned the wrong run kind.`)
        }
        return created
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

  async createSubagent(input: CreateSubagentRunInput): Promise<SubagentRunRecord> {
    assertCreateSubagentRunInput(input, "SixbPg")
    const execution = await assertAgentRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
    })

    try {
      return await runPgTransaction(this.sql, async (tx) => {
        const [parent] = await tx<AgentRunRow[]>`
          SELECT * FROM agent_runs
          WHERE project_id = ${input.projectId} AND id = ${input.parentRunId}
          FOR UPDATE
        `
        if (!parent || parent.kind !== "conversation") {
          throw new AgentStorageError(
            "run_not_found",
            `[SixbPg] Parent Agent run '${input.parentRunId}' was not found.`
          )
        }

        const [existingRow] = await tx<AgentRunRow[]>`
          SELECT * FROM agent_runs
          WHERE project_id = ${input.projectId} AND id = ${input.id}
        `
        if (existingRow) {
          const existing = rowToRunRecord(existingRow)
          if (subagentRunMatchesCreateInput(existing, input)) return existing
          throw new AgentStorageError(
            "duplicate_id",
            `[SixbPg] Subagent run '${input.id}' already exists with different immutable inputs.`
          )
        }
        if (parent.status !== "running") {
          throw new AgentStorageError(
            "invalid_state",
            `[SixbPg] Parent Agent run '${parent.id}' is not running (status '${parent.status}').`
          )
        }
        if (
          execution.source.type !== "execution" ||
          execution.source.executionId !== parent.execution_id
        ) {
          throw new AgentStorageError(
            "invalid_input",
            `[SixbPg] Subagent execution '${execution.id}' is not a child of parent execution '${parent.execution_id}'.`
          )
        }
        if (parent.execution_token !== input.parentExecutionToken) {
          throw new AgentStorageError(
            "execution_lost",
            `[SixbPg] Parent Agent run '${parent.id}' is no longer owned by this execution.`
          )
        }

        const [countRow] = await tx<{ count: string | number }[]>`
          SELECT COUNT(*)::bigint AS count FROM agent_runs
          WHERE project_id = ${input.projectId}
            AND parent_run_id = ${input.parentRunId}
            AND status IN (${"queued"}, ${"running"})
        `
        const activeChildren = Number(countRow?.count ?? 0)
        if (activeChildren >= input.maxActiveChildren) {
          throw new AgentStorageError(
            "active_child_limit",
            `[SixbPg] Agent run '${parent.id}' already has ${activeChildren} active subagents.`
          )
        }

        const createdAt = input.createdAt ?? new Date()
        await claimChildThread(tx, input, parent, createdAt)
        const [row] = await tx<AgentRunRow[]>`
          INSERT INTO agent_runs (
            project_id, id, execution_id, kind, thread_id, trigger_message_id, parent_run_id,
            spawn_key, spec, status, attempt, created_at
          ) VALUES (
            ${input.projectId}, ${input.id}, ${input.executionId}, ${"subagent"},
            ${input.thread.id}, ${input.trigger.id}, ${input.parentRunId}, ${input.spawnKey},
            ${JSON.stringify(input.spec)}::text::jsonb,
            ${"queued"}, ${0}, ${createdAt}
          )
          RETURNING *
        `
        await tx`
          INSERT INTO agent_messages (
            project_id, id, thread_id, run_id, role, seq, parts, metadata, content_version,
            created_at
          ) VALUES (
            ${input.projectId}, ${input.trigger.id}, ${input.thread.id}, ${input.id}, ${"user"},
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_messages
              WHERE project_id = ${input.projectId} AND thread_id = ${input.thread.id}),
            ${JSON.stringify(input.trigger.parts)}::text::jsonb,
            ${input.trigger.metadata === undefined ? null : JSON.stringify(input.trigger.metadata)}::text::jsonb,
            ${AGENT_MESSAGE_CONTENT_VERSION}, ${createdAt}
          )
        `
        const created = rowToRunRecord(row)
        if (created.kind !== "subagent") {
          throw new Error(`[SixbPg] Subagent insert '${input.id}' returned the wrong run kind.`)
        }
        return created
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AgentStorageError(
          "duplicate_id",
          `[SixbPg] Subagent run '${input.id}' conflicts with an existing durable spawn.`
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
        SET
          status = ${input.status},
          error = ${input.error === undefined ? null : serializeSixbFailure(input.error, AGENT_RUN_FAILURE_CODES)}::text::jsonb,
          completed_at = ${completedAt}
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
    const errorValue =
      input.status === "succeeded" || input.error === undefined
        ? null
        : serializeSixbFailure(input.error, AGENT_RUN_FAILURE_CODES)

    return runPgTransaction(this.sql, async (tx) => {
      const run = await this.lockRunning(tx, input.projectId, input.id)

      if (input.status === "succeeded" && run.kind === "subagent") {
        assertSubagentRunResult(
          input.result,
          run.id,
          "SixbPg",
          input.finishReason === "awaiting_approval"
        )
      }
      if (
        input.status === "succeeded" &&
        run.kind === "conversation" &&
        input.result !== undefined
      ) {
        throw new AgentStorageError(
          "invalid_input",
          `[SixbPg] Conversational Agent run '${run.id}' cannot persist a subagent result.`
        )
      }

      if (run.execution_token !== input.executionToken) {
        throw new AgentStorageError(
          "execution_lost",
          `[SixbPg] Execution token is no longer current on agent run '${input.id}'.`
        )
      }
      if (input.finishReason === "awaiting_approval") {
        assertAwaitingApprovalFinish({
          runId: input.id,
          status: input.status,
          holdsApproval: await pgHoldsRun(tx, input.projectId, input.id),
          prefix: "SixbPg",
        })
      }

      const [row] = await tx<AgentRunRow[]>`
        UPDATE agent_runs
        SET
          status = ${input.status},
          model_id = COALESCE(${input.modelId ?? null}, model_id),
          finish_reason = ${input.finishReason ?? null},
          error = ${errorValue}::text::jsonb,
          diagnostics = ${input.diagnostics === undefined ? null : JSON.stringify(input.diagnostics)}::text::jsonb,
          result = ${input.status === "succeeded" && input.result !== undefined ? JSON.stringify(input.result) : null}::text::jsonb,
          execution_token = ${null},
          execution_queue_lease_expires_at = ${null},
          completed_at = ${completedAt}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      await this.releaseThread(tx, run, completedAt)
      if (agentRunMayHoldCalls(rowToRunRecord(run))) {
        await settleFinishedRunApprovals(tx, run.kind, input, completedAt)
      }

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
    if (hasEmptyStatuses(input) || input.kinds?.length === 0) {
      return { runs: [], hasMore: false, total: 0 }
    }

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.kinds) {
      whereClauses.push(`kind = ANY($${index++}::text[])`)
      params.push(input.kinds as string[])
    }

    if (input.threadId) {
      whereClauses.push(`thread_id = $${index++}`)
      params.push(input.threadId)
    }

    if (input.parentRunId) {
      whereClauses.push(`parent_run_id = $${index++}`)
      params.push(input.parentRunId)
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

  /** A turn releases its conversation, a child run its own thread. */
  private async releaseThread(sql: SQLClient, run: AgentRunRow, completedAt: Date): Promise<void> {
    await sql`
      UPDATE agent_threads SET active_run_id = ${null}, updated_at = ${completedAt}
      WHERE project_id = ${run.project_id} AND id = ${run.thread_id} AND active_run_id = ${run.id}
    `
  }
}

/**
 * The child's thread: its first run creates it, owned by the conversation's owner; a later run
 * takes it while it is idle. Either way the run is its active run. Locked after the parent run, in
 * the run -> thread order every writer follows.
 */
async function claimChildThread(
  tx: SQLClient,
  input: CreateSubagentRunInput,
  parent: AgentRunRow,
  createdAt: Date
): Promise<void> {
  if (!input.thread.create) {
    const [row] = await tx<AgentThreadRow[]>`
      SELECT * FROM agent_threads
      WHERE project_id = ${input.projectId} AND id = ${input.thread.id}
      FOR UPDATE
    `
    assertSubagentThreadTakesRun(
      row ? rowToThreadRecord(row) : null,
      input,
      parent.thread_id ?? "",
      "SixbPg"
    )
    await tx`
      UPDATE agent_threads
      SET active_run_id = ${input.id}, message_count = message_count + 1,
        last_message_at = ${createdAt}, updated_at = ${createdAt}
      WHERE project_id = ${input.projectId} AND id = ${input.thread.id}
    `
    return
  }

  const [conversation] = await tx<AgentThreadRow[]>`
    SELECT * FROM agent_threads WHERE project_id = ${input.projectId} AND id = ${parent.thread_id}
  `
  if (!conversation) {
    throw new AgentStorageError(
      "thread_not_found",
      `[SixbPg] Agent thread '${parent.thread_id}' not found for project '${input.projectId}'.`
    )
  }

  const thread = newSubagentThreadRecord(input, rowToThreadRecord(conversation), createdAt)
  await tx`
    INSERT INTO agent_threads (
      project_id, id, kind, parent_thread_id, parent_run_id, spawn_key, owner_principal_type,
      owner_principal_id, status, active_run_id, last_message_at, message_count, created_at,
      updated_at
    ) VALUES (
      ${thread.projectId}, ${thread.id}, ${"subagent"}, ${conversation.id}, ${input.parentRunId},
      ${input.spawnKey}, ${thread.ownerPrincipal.type}, ${thread.ownerPrincipal.id},
      ${thread.status}, ${input.id}, ${createdAt}, ${thread.messageCount}, ${createdAt},
      ${createdAt}
    )
  `
}

/**
 * A turn that pauses keeps its calls for their decision. A turn that ends any other way cancels
 * the ones still waiting, a late one included, and never resumes on the rest. A child that fails
 * or is cancelled takes its own pending calls with it.
 */
async function settleFinishedRunApprovals(
  tx: SQLClient,
  kind: AgentRunRecord["kind"],
  input: FinishAgentRunInput,
  completedAt: Date
): Promise<void> {
  if (input.finishReason === "awaiting_approval") return
  const turn = kind === "conversation"
  if (!turn && input.status === "succeeded") return

  await tx`
    UPDATE agent_approvals SET status = 'cancelled'
    WHERE project_id = ${input.projectId} AND status = 'pending'
      AND (run_id = ${input.id} OR caller_run_id = ${input.id})
  `
  if (!turn) return
  await tx`
    UPDATE agent_approvals SET turn_stopped_at = ${completedAt}
    WHERE project_id = ${input.projectId} AND run_id = ${input.id}
      AND reported_in_message_id IS NULL AND turn_stopped_at IS NULL
  `
}
