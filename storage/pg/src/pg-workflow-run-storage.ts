import { normalizeRequesterGroupIds } from "@sixb/core/internal/auth"
import {
  assertWorkflowAgentNodeRunExecution,
  assertWorkflowRunExecution,
} from "@sixb/core/internal/workflow-run-storage-provider"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type {
  CancelWorkflowAgentNodeRunInput,
  ConfirmWorkflowAgentNodeRunExecutionOwnershipInput,
  ConfirmWorkflowRunExecutionOwnershipInput,
  CreateWorkflowAgentNodeRunInput,
  ExecutionStorage,
  FinishWorkflowAgentNodeRunInput,
  FinishWorkflowNodeRunInput,
  FinishWorkflowRunInput,
  ListLatestWorkflowRunsInput,
  ListLatestWorkflowRunsResult,
  ListWorkflowAgentNodeRunsInput,
  ListWorkflowAgentNodeRunsResult,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  QueueWorkflowRunInput,
  ReclaimWorkflowAgentNodeRunInput,
  ReclaimWorkflowRunInput,
  ResumeWorkflowRunInput,
  StartWorkflowAgentNodeRunInput,
  StartWorkflowNodeRunInput,
  StartWorkflowRunInput,
  WaitWorkflowNodeRunInput,
  WaitWorkflowRunInput,
  WorkflowAgentNodeRunRecord,
  WorkflowAgentNodeRunStorage,
  WorkflowNodeRunRecord,
  WorkflowNodeRunStorage,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import { WorkflowRunError } from "@sixb/core/storage"
import { queryLatestRunsByOwnerId } from "./latest-run-query"
import type { SqlParameter } from "./pg-client"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "./run-list-query"
import { isUniqueViolation } from "./storage-errors"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgWorkflowRunStorage implements WorkflowRunStorage {
  readonly nodes: PgWorkflowNodeRunStorage
  readonly agentNodes: PgWorkflowAgentNodeRunStorage

  constructor(
    private readonly sql: PgStoreClient,
    private readonly executions: ExecutionStorage
  ) {
    this.nodes = new PgWorkflowNodeRunStorage(sql)
    this.agentNodes = new PgWorkflowAgentNodeRunStorage(sql, executions)
  }

  async queue(input: QueueWorkflowRunInput): Promise<WorkflowRunRecord> {
    const queuedAt = input.queuedAt ?? new Date()
    await assertWorkflowRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      workflowId: input.workflowId,
    })

    try {
      const [row] = await this.sql<WorkflowRunDatabaseRow[]>`
        INSERT INTO workflow_runs (
          project_id,
          id,
          execution_id,
          workflow_id,
          status,
          input,
          queued_at,
          started_at,
          requester_group_ids,
          attempt
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.executionId},
          ${input.workflowId},
          ${"queued"},
          ${serializeRecord(input.input)}::text::jsonb,
          ${queuedAt},
          ${queuedAt},
          ${JSON.stringify(normalizeRequesterGroupIds(input.requesterGroupIds))}::text::jsonb,
          ${0}
        )
        RETURNING *
      `

      return rowToWorkflowRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkflowRunError(
          `[SixbPg] Workflow run '${input.id}' or execution '${input.executionId}' is already linked for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async start(input: StartWorkflowRunInput): Promise<WorkflowRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const startedAt = input.startedAt ?? new Date()
      const [existing] = await tx<WorkflowRunDatabaseRow[]>`
        SELECT * FROM workflow_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      if (!existing || existing.status !== "queued") {
        throw new WorkflowRunError(
          existing
            ? `[SixbPg] Workflow run '${input.id}' cannot start from status '${existing.status}'.`
            : `[SixbPg] Workflow run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      const [updated] = await tx<WorkflowRunDatabaseRow[]>`
        UPDATE workflow_runs
        SET
          status = ${"running"},
          started_at = ${startedAt},
          finished_at = ${null},
          error = ${null},
          attempt = attempt + 1,
          execution_token = ${input.execution?.token ?? null},
          execution_queue_lease_expires_at = ${input.execution?.queueLeaseExpiresAt ?? null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToWorkflowRunRecord(updated)
    })
  }

  async reclaim(input: ReclaimWorkflowRunInput): Promise<WorkflowRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await lockWorkflowRun(tx, input.projectId, input.id, "running")
      const [updated] = await tx<WorkflowRunDatabaseRow[]>`
        UPDATE workflow_runs SET
          attempt = ${Number(existing.attempt) + 1},
          execution_token = ${input.execution.token},
          execution_queue_lease_expires_at = ${input.execution.queueLeaseExpiresAt}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `
      return rowToWorkflowRunRecord(updated)
    })
  }

  async confirmExecutionOwnership(
    input: ConfirmWorkflowRunExecutionOwnershipInput
  ): Promise<WorkflowRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const existing = await lockWorkflowRun(tx, input.projectId, input.id, "running")
      assertWorkflowRunExecutionOwnership(existing, input.executionToken)
      const current = existing.execution_queue_lease_expires_at
        ? new Date(existing.execution_queue_lease_expires_at)
        : input.queueLeaseExpiresAt
      const [updated] = await tx<WorkflowRunDatabaseRow[]>`
        UPDATE workflow_runs SET execution_queue_lease_expires_at = ${new Date(
          Math.max(current.getTime(), input.queueLeaseExpiresAt.getTime())
        )}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `
      return rowToWorkflowRunRecord(updated)
    })
  }

  async finish(input: FinishWorkflowRunInput): Promise<WorkflowRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<WorkflowRunDatabaseRow[]>`
        SELECT * FROM workflow_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbPg] Workflow run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (!canFinishWorkflowRun(existing.status, input.status)) {
        throw new WorkflowRunError(
          `[SixbPg] Workflow run '${input.id}' for project '${input.projectId}' cannot be finished from status '${existing.status}'.`
        )
      }
      assertWorkflowRunExecutionOwnership(existing, input.executionToken)

      const [updated] =
        input.status === "succeeded"
          ? await tx<WorkflowRunDatabaseRow[]>`
              UPDATE workflow_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output = ${serializeRecord(input.output)}::text::jsonb,
                error = ${null},
                execution_token = ${null},
                execution_queue_lease_expires_at = ${null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `
          : await tx<WorkflowRunDatabaseRow[]>`
              UPDATE workflow_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output = ${null},
                error = ${input.error ?? null},
                execution_token = ${null},
                execution_queue_lease_expires_at = ${null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `

      return rowToWorkflowRunRecord(updated)
    })
  }

  async wait(input: WaitWorkflowRunInput): Promise<WorkflowRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<WorkflowRunDatabaseRow[]>`
        SELECT * FROM workflow_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbPg] Workflow run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "running") {
        throw new WorkflowRunError(
          `[SixbPg] Workflow run '${input.id}' for project '${input.projectId}' must be running.`
        )
      }
      assertWorkflowRunExecutionOwnership(existing, input.executionToken)

      const [updated] = await tx<WorkflowRunDatabaseRow[]>`
        UPDATE workflow_runs
        SET
          status = ${"waiting"},
          finished_at = ${null},
          error = ${null},
          execution_token = ${null},
          execution_queue_lease_expires_at = ${null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToWorkflowRunRecord(updated)
    })
  }

  async resume(input: ResumeWorkflowRunInput): Promise<WorkflowRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<WorkflowRunDatabaseRow[]>`
        SELECT * FROM workflow_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbPg] Workflow run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "waiting") {
        throw new WorkflowRunError(
          `[SixbPg] Workflow run '${input.id}' for project '${input.projectId}' must be waiting.`
        )
      }

      const [updated] = await tx<WorkflowRunDatabaseRow[]>`
        UPDATE workflow_runs
        SET
          status = ${"running"},
          finished_at = ${null},
          error = ${null},
          attempt = attempt + 1,
          execution_token = ${input.execution?.token ?? null},
          execution_queue_lease_expires_at = ${input.execution?.queueLeaseExpiresAt ?? null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToWorkflowRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<WorkflowRunRecord | null> {
    const [row] = await this.sql<WorkflowRunDatabaseRow[]>`
      SELECT * FROM workflow_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row ? rowToWorkflowRunRecord(row) : null
  }

  async list(input: ListWorkflowRunsInput): Promise<ListWorkflowRunsResult> {
    if (hasEmptyStatuses(input) || input.workflowIds?.length === 0) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.workflowId) {
      whereClauses.push(`workflow_id = $${index++}`)
      params.push(input.workflowId)
    }

    if (input.workflowIds) {
      const placeholders = input.workflowIds.map(() => `$${index++}`)
      whereClauses.push(`workflow_id IN (${placeholders.join(", ")})`)
      params.push(...input.workflowIds)
    }

    index = appendRunListFilters(whereClauses, params, index, input)

    const { rows, total, hasMore } = await queryRunList<WorkflowRunDatabaseRow>({
      sql: this.sql,
      tableName: "workflow_runs",
      whereClauses,
      params,
      nextIndex: index,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })
    const runs = rows.map(rowToWorkflowRunRecord)

    return {
      runs,
      hasMore,
      total,
    }
  }

  async listLatestByWorkflowIds(
    input: ListLatestWorkflowRunsInput
  ): Promise<ListLatestWorkflowRunsResult> {
    const rows = await queryLatestRunsByOwnerId<WorkflowRunDatabaseRow>({
      sql: this.sql,
      tableName: "workflow_runs",
      ownerColumn: "workflow_id",
      ownerIds: input.workflowIds,
      projectId: input.projectId,
      ownerIdFor: (row) => row.workflow_id,
    })

    return {
      runs: rows.map(rowToWorkflowRunRecord),
    }
  }
}

export class PgWorkflowAgentNodeRunStorage implements WorkflowAgentNodeRunStorage {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly executions: ExecutionStorage
  ) {}

  async create(input: CreateWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    const [parent] = await this.sql<{ execution_id: string }[]>`
      SELECT workflow_runs.execution_id
      FROM workflow_node_runs
      JOIN workflow_runs
        ON workflow_runs.project_id = workflow_node_runs.project_id
        AND workflow_runs.id = workflow_node_runs.workflow_run_id
      WHERE workflow_node_runs.project_id = ${input.projectId}
        AND workflow_node_runs.id = ${input.nodeRunId}
        AND workflow_node_runs.node_type = ${"agent"}
    `
    if (!parent) {
      throw new WorkflowRunError(
        `[SixbPg] Agent workflow node run '${input.nodeRunId}' was not found.`
      )
    }
    await assertWorkflowAgentNodeRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      nodeRunId: input.nodeRunId,
      agentId: input.agentId,
      parentExecutionId: parent.execution_id,
    })

    try {
      const [row] = await this.sql<WorkflowAgentNodeRunDatabaseRow[]>`
        INSERT INTO workflow_agent_node_runs (
          project_id, node_run_id, execution_id, agent_id, status, prompt, attempt, created_at
        ) VALUES (
          ${input.projectId}, ${input.nodeRunId}, ${input.executionId}, ${input.agentId},
          ${"queued"}, ${input.prompt}, ${0}, ${input.createdAt ?? new Date()}
        ) RETURNING *
      `
      return rowToWorkflowAgentNodeRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkflowRunError(
          `[SixbPg] Agent execution already exists for workflow node run '${input.nodeRunId}'.`
        )
      }
      throw error
    }
  }

  async start(input: StartWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const row = await lockWorkflowAgentNodeRun(tx, input.projectId, input.nodeRunId, "queued")
      const [updated] = await tx<WorkflowAgentNodeRunDatabaseRow[]>`
        UPDATE workflow_agent_node_runs SET
          status = ${"running"},
          model_id = ${input.modelId ?? null},
          attempt = ${1},
          execution_token = ${input.execution.token},
          execution_queue_lease_expires_at = ${input.execution.queueLeaseExpiresAt},
          started_at = ${input.startedAt ?? new Date()}
        WHERE project_id = ${row.project_id} AND node_run_id = ${row.node_run_id}
        RETURNING *
      `
      return rowToWorkflowAgentNodeRunRecord(updated)
    })
  }

  async reclaim(input: ReclaimWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const row = await lockWorkflowAgentNodeRun(tx, input.projectId, input.nodeRunId, "running")
      const [updated] = await tx<WorkflowAgentNodeRunDatabaseRow[]>`
        UPDATE workflow_agent_node_runs SET
          attempt = ${Number(row.attempt) + 1},
          execution_token = ${input.execution.token},
          execution_queue_lease_expires_at = ${input.execution.queueLeaseExpiresAt}
        WHERE project_id = ${input.projectId} AND node_run_id = ${input.nodeRunId}
        RETURNING *
      `
      return rowToWorkflowAgentNodeRunRecord(updated)
    })
  }

  async confirmExecutionOwnership(
    input: ConfirmWorkflowAgentNodeRunExecutionOwnershipInput
  ): Promise<WorkflowAgentNodeRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const row = await lockWorkflowAgentNodeRun(tx, input.projectId, input.nodeRunId, "running")
      assertWorkflowAgentNodeOwnership(row, input.executionToken)
      const currentLease = row.execution_queue_lease_expires_at
        ? new Date(row.execution_queue_lease_expires_at)
        : input.queueLeaseExpiresAt
      const [updated] = await tx<WorkflowAgentNodeRunDatabaseRow[]>`
        UPDATE workflow_agent_node_runs SET
          execution_queue_lease_expires_at = ${new Date(
            Math.max(currentLease.getTime(), input.queueLeaseExpiresAt.getTime())
          )}
        WHERE project_id = ${input.projectId} AND node_run_id = ${input.nodeRunId}
        RETURNING *
      `
      return rowToWorkflowAgentNodeRunRecord(updated)
    })
  }

  async finish(input: FinishWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const row = await lockWorkflowAgentNodeRun(tx, input.projectId, input.nodeRunId, "running")
      assertWorkflowAgentNodeOwnership(row, input.executionToken)
      const [updated] = await tx<WorkflowAgentNodeRunDatabaseRow[]>`
        UPDATE workflow_agent_node_runs SET
          status = ${input.status},
          model_id = COALESCE(${input.modelId ?? null}, model_id),
          finish_reason = ${input.finishReason ?? null},
          usage = ${input.usage ? JSON.stringify(input.usage) : null}::text::jsonb,
          trace = ${input.trace ? JSON.stringify(input.trace) : null}::text::jsonb,
          diagnostics = ${input.diagnostics ? JSON.stringify(input.diagnostics) : null}::text::jsonb,
          error = ${input.status === "succeeded" ? null : (input.error ?? null)},
          execution_token = ${null},
          execution_queue_lease_expires_at = ${null},
          completed_at = ${input.completedAt ?? new Date()}
        WHERE project_id = ${input.projectId} AND node_run_id = ${input.nodeRunId}
        RETURNING *
      `
      return rowToWorkflowAgentNodeRunRecord(updated)
    })
  }

  async cancel(input: CancelWorkflowAgentNodeRunInput): Promise<WorkflowAgentNodeRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [row] = await tx<WorkflowAgentNodeRunDatabaseRow[]>`
        SELECT * FROM workflow_agent_node_runs
        WHERE project_id = ${input.projectId} AND node_run_id = ${input.nodeRunId}
        FOR UPDATE
      `
      if (!row) {
        throw new WorkflowRunError(
          `[SixbPg] Agent workflow node run '${input.nodeRunId}' not found.`
        )
      }
      if (row.status !== "queued" && row.status !== "running") {
        throw new WorkflowRunError(
          `[SixbPg] Agent workflow node run '${input.nodeRunId}' cannot be cancelled from status '${row.status}'.`
        )
      }
      const [updated] = await tx<WorkflowAgentNodeRunDatabaseRow[]>`
        UPDATE workflow_agent_node_runs SET
          status = ${"cancelled"},
          error = ${input.error ?? null},
          execution_token = ${null},
          execution_queue_lease_expires_at = ${null},
          completed_at = ${input.completedAt ?? new Date()}
        WHERE project_id = ${input.projectId} AND node_run_id = ${input.nodeRunId}
        RETURNING *
      `
      return rowToWorkflowAgentNodeRunRecord(updated)
    })
  }

  async getByNodeRunId(params: {
    projectId: string
    nodeRunId: string
  }): Promise<WorkflowAgentNodeRunRecord | null> {
    const [row] = await this.sql<WorkflowAgentNodeRunDatabaseRow[]>`
      SELECT * FROM workflow_agent_node_runs
      WHERE project_id = ${params.projectId} AND node_run_id = ${params.nodeRunId}
    `
    return row ? rowToWorkflowAgentNodeRunRecord(row) : null
  }

  async list(input: ListWorkflowAgentNodeRunsInput): Promise<ListWorkflowAgentNodeRunsResult> {
    if (hasEmptyStatuses(input)) return { runs: [], total: 0, hasMore: false }
    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2
    if (input.agentId) {
      whereClauses.push(`agent_id = $${index++}`)
      params.push(input.agentId)
    }
    index = appendRunListFilters(whereClauses, params, index, input)
    const result = await queryRunList<WorkflowAgentNodeRunDatabaseRow>({
      sql: this.sql,
      tableName: "workflow_agent_node_runs",
      whereClauses,
      params,
      nextIndex: index,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })
    return { ...result, runs: result.rows.map(rowToWorkflowAgentNodeRunRecord) }
  }
}

export class PgWorkflowNodeRunStorage implements WorkflowNodeRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async start(input: StartWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    assertNonNegativeInteger(input.nodeIndex, "nodeIndex")

    return runPgTransaction(this.sql, async (tx) => {
      const [workflowRun] = await tx<WorkflowRunDatabaseRow[]>`
        SELECT * FROM workflow_runs
        WHERE project_id = ${input.projectId} AND id = ${input.workflowRunId}
        FOR UPDATE
      `

      if (!workflowRun) {
        throw new WorkflowRunError(
          `[SixbPg] Workflow run '${input.workflowRunId}' not found for project '${input.projectId}'.`
        )
      }

      if (workflowRun.status !== "running") {
        throw new WorkflowRunError(
          `[SixbPg] Workflow run '${input.workflowRunId}' for project '${input.projectId}' must be running.`
        )
      }
      assertWorkflowRunExecutionOwnership(workflowRun, input.executionToken)

      if (workflowRun.workflow_id !== input.workflowId) {
        throw new WorkflowRunError(
          `[SixbPg] Workflow node run '${input.id}' workflow '${input.workflowId}' does not match workflow run '${input.workflowRunId}' workflow '${workflowRun.workflow_id}'.`
        )
      }

      try {
        const [row] = await tx<WorkflowNodeRunDatabaseRow[]>`
          INSERT INTO workflow_node_runs (
            project_id,
            id,
            workflow_run_id,
            workflow_id,
            node_index,
            node_type,
            node_id,
            node_key,
            status,
            input,
            started_at
          ) VALUES (
            ${input.projectId},
            ${input.id},
            ${input.workflowRunId},
            ${input.workflowId},
            ${input.nodeIndex},
            ${input.nodeType},
            ${input.nodeId},
            ${input.nodeKey},
            ${"running"},
            ${serializeRecord(input.input)}::text::jsonb,
            ${input.startedAt ?? new Date()}
          )
          RETURNING *
        `

        return rowToWorkflowNodeRunRecord(row)
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new WorkflowRunError(
            `[SixbPg] Workflow node run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        throw error
      }
    })
  }

  async finish(input: FinishWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<WorkflowNodeRunDatabaseRow[]>`
        SELECT * FROM workflow_node_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbPg] Workflow node run '${input.id}' not found for project '${input.projectId}'.`
        )
      }
      await assertWorkflowNodeParentExecutionOwnership(tx, existing, input.executionToken)

      if (existing.status !== "running" && existing.status !== "waiting") {
        throw new WorkflowRunError(
          `[SixbPg] Workflow node run '${input.id}' for project '${input.projectId}' is already terminal.`
        )
      }

      const [updated] =
        input.status === "succeeded"
          ? await tx<WorkflowNodeRunDatabaseRow[]>`
              UPDATE workflow_node_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output = ${input.output ? serializeRecord(input.output) : null}::text::jsonb,
                error = ${null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `
          : await tx<WorkflowNodeRunDatabaseRow[]>`
              UPDATE workflow_node_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output = ${null},
                error = ${input.error ?? null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `

      return rowToWorkflowNodeRunRecord(updated)
    })
  }

  async wait(input: WaitWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<WorkflowNodeRunDatabaseRow[]>`
        SELECT * FROM workflow_node_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `

      if (!existing) {
        throw new WorkflowRunError(
          `[SixbPg] Workflow node run '${input.id}' not found for project '${input.projectId}'.`
        )
      }
      await assertWorkflowNodeParentExecutionOwnership(tx, existing, input.executionToken)

      if (existing.status !== "running") {
        throw new WorkflowRunError(
          `[SixbPg] Workflow node run '${input.id}' for project '${input.projectId}' must be running.`
        )
      }

      const [updated] = await tx<WorkflowNodeRunDatabaseRow[]>`
        UPDATE workflow_node_runs
        SET
          status = ${"waiting"},
          finished_at = ${null},
          output = ${null},
          error = ${null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToWorkflowNodeRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<WorkflowNodeRunRecord | null> {
    const [row] = await this.sql<WorkflowNodeRunDatabaseRow[]>`
      SELECT * FROM workflow_node_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row ? rowToWorkflowNodeRunRecord(row) : null
  }

  async list(input: ListWorkflowNodeRunsInput): Promise<ListWorkflowNodeRunsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        nodes: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.workflowRunId) {
      whereClauses.push(`workflow_run_id = $${index++}`)
      params.push(input.workflowRunId)
    }

    if (input.workflowId) {
      whereClauses.push(`workflow_id = $${index++}`)
      params.push(input.workflowId)
    }

    if (input.nodeType) {
      whereClauses.push(`node_type = $${index++}`)
      params.push(input.nodeType)
    }

    if (input.nodeId) {
      whereClauses.push(`node_id = $${index++}`)
      params.push(input.nodeId)
    }

    if (input.nodeKey) {
      whereClauses.push(`node_key = $${index++}`)
      params.push(input.nodeKey)
    }

    index = appendRunListFilters(whereClauses, params, index, input)

    const { rows, total, hasMore } = await queryRunList<WorkflowNodeRunDatabaseRow>({
      sql: this.sql,
      tableName: "workflow_node_runs",
      whereClauses,
      params,
      nextIndex: index,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })
    const nodes = rows.map(rowToWorkflowNodeRunRecord)

    return {
      nodes,
      hasMore,
      total,
    }
  }
}

function serializeRecord(value: WorkflowIOSnapshot): string {
  return JSON.stringify(value)
}

function parseRecord(value: WorkflowIOSnapshot | string): WorkflowIOSnapshot {
  return typeof value === "string" ? (JSON.parse(value) as WorkflowIOSnapshot) : value
}

function rowToWorkflowRunRecord(row: WorkflowRunDatabaseRow): WorkflowRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    status: row.status,
    input: parseRecord(row.input),
    output: row.output ? parseRecord(row.output) : undefined,
    queuedAt: row.queued_at ? new Date(row.queued_at) : undefined,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    error: row.error ?? undefined,
    requesterGroupIds: parseJson(row.requester_group_ids),
    attempt: Number(row.attempt),
    ...(row.execution_token && row.execution_queue_lease_expires_at
      ? {
          execution: {
            token: row.execution_token,
            queueLeaseExpiresAt: new Date(row.execution_queue_lease_expires_at),
          },
        }
      : {}),
  }
}

function rowToWorkflowNodeRunRecord(row: WorkflowNodeRunDatabaseRow): WorkflowNodeRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowRunId: row.workflow_run_id,
    workflowId: row.workflow_id,
    nodeIndex: Number(row.node_index),
    nodeType: row.node_type,
    nodeId: row.node_id,
    nodeKey: row.node_key,
    status: row.status,
    input: parseRecord(row.input),
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    output: row.output ? parseRecord(row.output) : undefined,
    error: row.error ?? undefined,
  }
}

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowRunError(`[SixbPg] Workflow run ${fieldName} must be a non-negative integer.`)
  }
}

function canFinishWorkflowRun(
  current: WorkflowRunRecord["status"],
  next: FinishWorkflowRunInput["status"]
): boolean {
  return (
    current === "running" ||
    (current === "waiting" && next !== "succeeded") ||
    (current === "queued" && next !== "succeeded")
  )
}

interface WorkflowRunDatabaseRow {
  project_id: string
  id: string
  execution_id: string
  workflow_id: string
  status: WorkflowRunRecord["status"]
  input: WorkflowIOSnapshot | string
  output: WorkflowIOSnapshot | string | null
  queued_at: Date | string | null
  started_at: Date | string
  finished_at: Date | string | null
  error: string | null
  requester_group_ids: string[] | string
  attempt: number | string
  execution_token: string | null
  execution_queue_lease_expires_at: Date | string | null
}

interface WorkflowNodeRunDatabaseRow {
  project_id: string
  id: string
  workflow_run_id: string
  workflow_id: string
  node_index: number | string
  node_type: WorkflowNodeRunRecord["nodeType"]
  node_id: string
  node_key: string
  status: WorkflowNodeRunRecord["status"]
  input: WorkflowIOSnapshot | string
  started_at: Date | string
  finished_at: Date | string | null
  output: WorkflowIOSnapshot | string | null
  error: string | null
}

interface WorkflowAgentNodeRunDatabaseRow {
  project_id: string
  node_run_id: string
  execution_id: string
  agent_id: string
  status: WorkflowAgentNodeRunRecord["status"]
  prompt: string
  model_id: string | null
  finish_reason: WorkflowAgentNodeRunRecord["finishReason"] | null
  usage: WorkflowAgentNodeRunRecord["usage"] | string | null
  trace: WorkflowAgentNodeRunRecord["trace"] | string | null
  diagnostics: WorkflowAgentNodeRunRecord["diagnostics"] | string | null
  error: string | null
  attempt: number | string
  execution_token: string | null
  execution_queue_lease_expires_at: Date | string | null
  created_at: Date | string
  started_at: Date | string | null
  completed_at: Date | string | null
}

async function lockWorkflowAgentNodeRun(
  sql: PgStoreClient,
  projectId: string,
  nodeRunId: string,
  status: WorkflowAgentNodeRunRecord["status"]
): Promise<WorkflowAgentNodeRunDatabaseRow> {
  const [row] = await sql<WorkflowAgentNodeRunDatabaseRow[]>`
    SELECT * FROM workflow_agent_node_runs
    WHERE project_id = ${projectId} AND node_run_id = ${nodeRunId}
    FOR UPDATE
  `
  if (!row) {
    throw new WorkflowRunError(
      `[SixbPg] Agent workflow node run '${nodeRunId}' not found for project '${projectId}'.`
    )
  }
  if (row.status !== status) {
    throw new WorkflowRunError(
      `[SixbPg] Agent workflow node run '${nodeRunId}' must be ${status} (status '${row.status}').`
    )
  }
  return row
}

function assertWorkflowAgentNodeOwnership(
  row: WorkflowAgentNodeRunDatabaseRow,
  token: string
): void {
  if (row.execution_token !== token) {
    throw new WorkflowRunError(
      `[SixbPg] Execution token is no longer current on agent workflow node run '${row.node_run_id}'.`
    )
  }
}

function rowToWorkflowAgentNodeRunRecord(
  row: WorkflowAgentNodeRunDatabaseRow
): WorkflowAgentNodeRunRecord {
  return {
    projectId: row.project_id,
    nodeRunId: row.node_run_id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    status: row.status,
    prompt: row.prompt,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.finish_reason ? { finishReason: row.finish_reason } : {}),
    ...(row.usage ? { usage: parseJson(row.usage) } : {}),
    ...(row.trace ? { trace: parseJson(row.trace) } : {}),
    ...(row.diagnostics ? { diagnostics: parseJson(row.diagnostics) } : {}),
    ...(row.error ? { error: row.error } : {}),
    attempt: Number(row.attempt),
    ...(row.execution_token && row.execution_queue_lease_expires_at
      ? {
          execution: {
            token: row.execution_token,
            queueLeaseExpiresAt: new Date(row.execution_queue_lease_expires_at),
          },
        }
      : {}),
    createdAt: new Date(row.created_at),
    ...(row.started_at ? { startedAt: new Date(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: new Date(row.completed_at) } : {}),
  }
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value
}

async function lockWorkflowRun(
  sql: PgStoreClient,
  projectId: string,
  id: string,
  status: WorkflowRunRecord["status"]
): Promise<WorkflowRunDatabaseRow> {
  const [row] = await sql<WorkflowRunDatabaseRow[]>`
    SELECT * FROM workflow_runs WHERE project_id = ${projectId} AND id = ${id} FOR UPDATE
  `
  if (!row) throw new WorkflowRunError(`[SixbPg] Workflow run '${id}' not found.`)
  if (row.status !== status) {
    throw new WorkflowRunError(
      `[SixbPg] Workflow run '${id}' must be ${status} (status '${row.status}').`
    )
  }
  return row
}

function assertWorkflowRunExecutionOwnership(row: WorkflowRunDatabaseRow, token?: string): void {
  if (row.execution_token !== (token ?? null)) {
    throw new WorkflowRunError(
      `[SixbPg] Execution token is no longer current on workflow run '${row.id}'.`
    )
  }
}

async function assertWorkflowNodeParentExecutionOwnership(
  sql: PgStoreClient,
  node: WorkflowNodeRunDatabaseRow,
  token?: string
): Promise<void> {
  const [run] = await sql<WorkflowRunDatabaseRow[]>`
    SELECT * FROM workflow_runs
    WHERE project_id = ${node.project_id} AND id = ${node.workflow_run_id}
    FOR UPDATE
  `
  if (!run) throw new WorkflowRunError(`[SixbPg] Parent workflow run was not found.`)
  assertWorkflowRunExecutionOwnership(run, token)
}
