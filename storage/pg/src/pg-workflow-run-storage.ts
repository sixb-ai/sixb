import type {
  FinishWorkflowNodeRunInput,
  FinishWorkflowRunInput,
  ListWorkflowNodeRunsInput,
  ListWorkflowNodeRunsResult,
  ListWorkflowRunsInput,
  ListWorkflowRunsResult,
  QueueWorkflowRunInput,
  StartWorkflowNodeRunInput,
  StartWorkflowRunInput,
  WorkflowIOSnapshot,
  WorkflowNodeRunRecord,
  WorkflowNodeRunStorage,
  WorkflowRunRecord,
  WorkflowRunSource,
  WorkflowRunStorage,
} from "@pario/core"
import { WorkflowRunError } from "@pario/core"
import type { SQL } from "bun"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "./run-list-query"
import { isUniqueViolation } from "./storage-errors"

export class PgWorkflowRunStorage implements WorkflowRunStorage {
  readonly nodes: PgWorkflowNodeRunStorage

  constructor(private readonly sql: SQL) {
    this.nodes = new PgWorkflowNodeRunStorage(sql)
  }

  async queue(input: QueueWorkflowRunInput): Promise<WorkflowRunRecord> {
    const queuedAt = input.queuedAt ?? new Date()

    try {
      const [row] = (await this.sql`
        INSERT INTO workflow_runs (
          project_id,
          id,
          workflow_id,
          status,
          input,
          queued_at,
          started_at,
          source
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.workflowId},
          ${"queued"},
          ${serializeRecord(input.input)}::text::jsonb,
          ${queuedAt},
          ${queuedAt},
          ${input.source ? JSON.stringify(input.source) : null}::text::jsonb
        )
        RETURNING *
      `) as WorkflowRunDatabaseRow[]

      return rowToWorkflowRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkflowRunError(
          `[ParioPg] Workflow run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async start(input: StartWorkflowRunInput): Promise<WorkflowRunRecord> {
    return this.sql.begin(async (tx) => {
      const startedAt = input.startedAt ?? new Date()
      const [existing] = (await tx`
        SELECT * FROM workflow_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `) as WorkflowRunDatabaseRow[]

      if (existing) {
        if (existing.status !== "queued") {
          throw new WorkflowRunError(
            `[ParioPg] Workflow run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        if (existing.workflow_id !== input.workflowId) {
          throw new WorkflowRunError(
            `[ParioPg] Workflow run '${input.id}' workflow '${input.workflowId}' does not match existing workflow '${existing.workflow_id}'.`
          )
        }

        const [updated] = (await tx`
          UPDATE workflow_runs
          SET
            status = ${"running"},
            input = ${serializeRecord(input.input)}::text::jsonb,
            started_at = ${startedAt},
            finished_at = ${null},
            error = ${null}
          WHERE project_id = ${input.projectId} AND id = ${input.id}
          RETURNING *
        `) as WorkflowRunDatabaseRow[]

        return rowToWorkflowRunRecord(updated)
      }

      try {
        const [row] = (await tx`
          INSERT INTO workflow_runs (
            project_id,
            id,
            workflow_id,
            status,
            input,
            started_at
          ) VALUES (
            ${input.projectId},
            ${input.id},
            ${input.workflowId},
            ${"running"},
            ${serializeRecord(input.input)}::text::jsonb,
            ${startedAt}
          )
          RETURNING *
        `) as WorkflowRunDatabaseRow[]

        return rowToWorkflowRunRecord(row)
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new WorkflowRunError(
            `[ParioPg] Workflow run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        throw error
      }
    })
  }

  async finish(input: FinishWorkflowRunInput): Promise<WorkflowRunRecord> {
    return this.sql.begin(async (tx) => {
      const [existing] = (await tx`
        SELECT * FROM workflow_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `) as WorkflowRunDatabaseRow[]

      if (!existing) {
        throw new WorkflowRunError(
          `[ParioPg] Workflow run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (!canFinishWorkflowRun(existing.status, input.status)) {
        throw new WorkflowRunError(
          `[ParioPg] Workflow run '${input.id}' for project '${input.projectId}' cannot be finished from status '${existing.status}'.`
        )
      }

      const [updated] =
        input.status === "succeeded"
          ? ((await tx`
              UPDATE workflow_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                error = ${null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `) as WorkflowRunDatabaseRow[])
          : ((await tx`
              UPDATE workflow_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                error = ${input.error ?? null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `) as WorkflowRunDatabaseRow[])

      return rowToWorkflowRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<WorkflowRunRecord | null> {
    const [row] = (await this.sql`
      SELECT * FROM workflow_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `) as WorkflowRunDatabaseRow[]

    return row ? rowToWorkflowRunRecord(row) : null
  }

  async list(input: ListWorkflowRunsInput): Promise<ListWorkflowRunsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = $1"]
    const params: unknown[] = [input.projectId]
    let index = 2

    if (input.workflowId) {
      whereClauses.push(`workflow_id = $${index++}`)
      params.push(input.workflowId)
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
}

export class PgWorkflowNodeRunStorage implements WorkflowNodeRunStorage {
  constructor(private readonly sql: SQL) {}

  async start(input: StartWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    assertNonNegativeInteger(input.nodeIndex, "nodeIndex")

    return this.sql.begin(async (tx) => {
      const [workflowRun] = (await tx`
        SELECT * FROM workflow_runs
        WHERE project_id = ${input.projectId} AND id = ${input.workflowRunId}
        FOR UPDATE
      `) as WorkflowRunDatabaseRow[]

      if (!workflowRun) {
        throw new WorkflowRunError(
          `[ParioPg] Workflow run '${input.workflowRunId}' not found for project '${input.projectId}'.`
        )
      }

      if (workflowRun.status !== "running") {
        throw new WorkflowRunError(
          `[ParioPg] Workflow run '${input.workflowRunId}' for project '${input.projectId}' is already terminal.`
        )
      }

      if (workflowRun.workflow_id !== input.workflowId) {
        throw new WorkflowRunError(
          `[ParioPg] Workflow node run '${input.id}' workflow '${input.workflowId}' does not match workflow run '${input.workflowRunId}' workflow '${workflowRun.workflow_id}'.`
        )
      }

      try {
        const [row] = (await tx`
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
        `) as WorkflowNodeRunDatabaseRow[]

        return rowToWorkflowNodeRunRecord(row)
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new WorkflowRunError(
            `[ParioPg] Workflow node run '${input.id}' already exists for project '${input.projectId}'.`
          )
        }

        throw error
      }
    })
  }

  async finish(input: FinishWorkflowNodeRunInput): Promise<WorkflowNodeRunRecord> {
    return this.sql.begin(async (tx) => {
      const [existing] = (await tx`
        SELECT * FROM workflow_node_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `) as WorkflowNodeRunDatabaseRow[]

      if (!existing) {
        throw new WorkflowRunError(
          `[ParioPg] Workflow node run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "running") {
        throw new WorkflowRunError(
          `[ParioPg] Workflow node run '${input.id}' for project '${input.projectId}' is already terminal.`
        )
      }

      const [updated] =
        input.status === "succeeded"
          ? ((await tx`
              UPDATE workflow_node_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output = ${input.output ? serializeRecord(input.output) : null}::text::jsonb,
                error = ${null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `) as WorkflowNodeRunDatabaseRow[])
          : ((await tx`
              UPDATE workflow_node_runs
              SET
                status = ${input.status},
                finished_at = ${input.finishedAt ?? new Date()},
                output = ${null},
                error = ${input.error ?? null}
              WHERE project_id = ${input.projectId} AND id = ${input.id}
              RETURNING *
            `) as WorkflowNodeRunDatabaseRow[])

      return rowToWorkflowNodeRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<WorkflowNodeRunRecord | null> {
    const [row] = (await this.sql`
      SELECT * FROM workflow_node_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `) as WorkflowNodeRunDatabaseRow[]

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
    const params: unknown[] = [input.projectId]
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
    workflowId: row.workflow_id,
    status: row.status,
    input: parseRecord(row.input),
    queuedAt: row.queued_at ? new Date(row.queued_at) : undefined,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    error: row.error ?? undefined,
    source: parseSource(row.source),
  }
}

function parseSource(value: WorkflowRunSource | string | null): WorkflowRunSource | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  return typeof value === "string" ? (JSON.parse(value) as WorkflowRunSource) : value
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
    throw new WorkflowRunError(
      `[ParioPg] Workflow run ${fieldName} must be a non-negative integer.`
    )
  }
}

function canFinishWorkflowRun(
  current: WorkflowRunRecord["status"],
  next: FinishWorkflowRunInput["status"]
): boolean {
  return current === "running" || (current === "queued" && next !== "succeeded")
}

interface WorkflowRunDatabaseRow {
  project_id: string
  id: string
  workflow_id: string
  status: WorkflowRunRecord["status"]
  input: WorkflowIOSnapshot | string
  queued_at: Date | string | null
  started_at: Date | string
  finished_at: Date | string | null
  error: string | null
  source: WorkflowRunSource | string | null
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
