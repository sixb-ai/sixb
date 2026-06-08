import type {
  CancelWorkflowInterventionInput,
  CreateWorkflowInterventionInput,
  ExpireWorkflowInterventionInput,
  ListWorkflowInterventionsInput,
  ListWorkflowInterventionsResult,
  SubmitWorkflowInterventionInput,
  WorkflowInterventionActor,
  WorkflowInterventionRecord,
  WorkflowInterventionStorage,
  WorkflowIOSnapshot,
} from "@sixb/core"
import { WorkflowInterventionError } from "@sixb/core"
import type { SQL, SQLClient, SqlParameter } from "./pg-client"
import { isUniqueViolation } from "./storage-errors"

export class PgWorkflowInterventionStorage implements WorkflowInterventionStorage {
  constructor(private readonly sql: SQL) {}

  async create(input: CreateWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    assertNonNegativeInteger(input.nodeIndex, "nodeIndex")

    try {
      const [row] = await this.sql<WorkflowInterventionDatabaseRow[]>`
        INSERT INTO workflow_interventions (
          project_id,
          id,
          workflow_id,
          workflow_run_id,
          node_run_id,
          node_index,
          node_id,
          node_key,
          intervention_id,
          input,
          default_response,
          status,
          requested_at,
          expires_at
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.workflowId},
          ${input.workflowRunId},
          ${input.nodeRunId},
          ${input.nodeIndex},
          ${input.nodeId},
          ${input.nodeKey},
          ${input.interventionId},
          ${serializeRecord(input.input)}::text::jsonb,
          ${serializeRecord(input.defaultResponse)}::text::jsonb,
          ${"pending"},
          ${input.requestedAt ?? new Date()},
          ${input.expiresAt ?? null}
        )
        RETURNING *
      `

      return rowToWorkflowInterventionRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkflowInterventionError(
          `[SixbPg] Workflow intervention '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
  }

  async submit(input: SubmitWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    return this.sql.begin(async (tx) => {
      await requirePendingIntervention(tx, input.projectId, input.id)

      const [updated] = await tx<WorkflowInterventionDatabaseRow[]>`
        UPDATE workflow_interventions
        SET
          status = ${"submitted"},
          submitted_at = ${input.submittedAt ?? new Date()},
          submitted_by = ${serializeActor(input.submittedBy)}::text::jsonb,
          response = ${serializeRecord(input.response)}::text::jsonb
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToWorkflowInterventionRecord(updated)
    })
  }

  async cancel(input: CancelWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    return this.sql.begin(async (tx) => {
      await requirePendingIntervention(tx, input.projectId, input.id)

      const [updated] = await tx<WorkflowInterventionDatabaseRow[]>`
        UPDATE workflow_interventions
        SET
          status = ${"cancelled"},
          cancelled_at = ${input.cancelledAt ?? new Date()},
          cancelled_by = ${serializeActor(input.cancelledBy)}::text::jsonb
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToWorkflowInterventionRecord(updated)
    })
  }

  async expire(input: ExpireWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    return this.sql.begin(async (tx) => {
      await requirePendingIntervention(tx, input.projectId, input.id)

      const [updated] = await tx<WorkflowInterventionDatabaseRow[]>`
        UPDATE workflow_interventions
        SET
          status = ${"expired"},
          expired_at = ${input.expiredAt ?? new Date()}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `

      return rowToWorkflowInterventionRecord(updated)
    })
  }

  async getById(params: {
    projectId: string
    id: string
  }): Promise<WorkflowInterventionRecord | null> {
    const [row] = await this.sql<WorkflowInterventionDatabaseRow[]>`
      SELECT * FROM workflow_interventions
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `

    return row ? rowToWorkflowInterventionRecord(row) : null
  }

  async list(input: ListWorkflowInterventionsInput): Promise<ListWorkflowInterventionsResult> {
    if (input.statuses && input.statuses.length === 0) {
      return {
        interventions: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2

    if (input.statuses) {
      const placeholders = input.statuses.map(() => `$${index++}`)
      whereClauses.push(`status IN (${placeholders.join(", ")})`)
      params.push(...input.statuses)
    }

    if (input.workflowId) {
      whereClauses.push(`workflow_id = $${index++}`)
      params.push(input.workflowId)
    }

    if (input.workflowRunId) {
      whereClauses.push(`workflow_run_id = $${index++}`)
      params.push(input.workflowRunId)
    }

    if (input.nodeRunId) {
      whereClauses.push(`node_run_id = $${index++}`)
      params.push(input.nodeRunId)
    }

    if (input.nodeId) {
      whereClauses.push(`node_id = $${index++}`)
      params.push(input.nodeId)
    }

    if (input.nodeKey) {
      whereClauses.push(`node_key = $${index++}`)
      params.push(input.nodeKey)
    }

    if (input.interventionId) {
      whereClauses.push(`intervention_id = $${index++}`)
      params.push(input.interventionId)
    }

    if (input.requestedAfter) {
      whereClauses.push(`requested_at >= $${index++}`)
      params.push(input.requestedAfter)
    }

    if (input.requestedBefore) {
      whereClauses.push(`requested_at <= $${index++}`)
      params.push(input.requestedBefore)
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0
    const [totalRow] = await this.sql.unsafe<{ count: string | number }[]>(
      `SELECT COUNT(*)::bigint AS count FROM workflow_interventions ${where}`,
      params
    )

    const queryParams = [...params]
    let query = `
      SELECT * FROM workflow_interventions
      ${where}
      ORDER BY requested_at ${order}, id ${order}
    `

    if (input.limit !== undefined) {
      query += ` LIMIT $${index++} OFFSET $${index++}`
      queryParams.push(input.limit, offset)
    } else if (offset > 0) {
      query += ` OFFSET $${index++}`
      queryParams.push(offset)
    }

    const rows = await this.sql.unsafe<WorkflowInterventionDatabaseRow[]>(query, queryParams)
    const total = Number(totalRow?.count ?? 0)

    return {
      interventions: rows.map(rowToWorkflowInterventionRecord),
      hasMore: offset + rows.length < total,
      total,
    }
  }
}

async function requirePendingIntervention(
  sql: SQLClient,
  projectId: string,
  id: string
): Promise<WorkflowInterventionDatabaseRow> {
  const [row] = await sql<WorkflowInterventionDatabaseRow[]>`
    SELECT * FROM workflow_interventions
    WHERE project_id = ${projectId} AND id = ${id}
    FOR UPDATE
  `

  if (!row) {
    throw new WorkflowInterventionError(
      `[SixbPg] Workflow intervention '${id}' not found for project '${projectId}'.`
    )
  }

  if (row.status !== "pending") {
    throw new WorkflowInterventionError(
      `[SixbPg] Workflow intervention '${id}' for project '${projectId}' is not pending.`
    )
  }

  return row
}

function serializeRecord(value: WorkflowIOSnapshot): string {
  return JSON.stringify(value)
}

function parseRecord(value: WorkflowIOSnapshot | string): WorkflowIOSnapshot {
  return typeof value === "string" ? (JSON.parse(value) as WorkflowIOSnapshot) : value
}

function serializeActor(actor: WorkflowInterventionActor | undefined): string | null {
  return actor ? JSON.stringify(actor) : null
}

function parseActor(
  value: WorkflowInterventionActor | string | null
): WorkflowInterventionActor | undefined {
  return typeof value === "string"
    ? (JSON.parse(value) as WorkflowInterventionActor)
    : (value ?? undefined)
}

function rowToWorkflowInterventionRecord(
  row: WorkflowInterventionDatabaseRow
): WorkflowInterventionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowId: row.workflow_id,
    workflowRunId: row.workflow_run_id,
    nodeRunId: row.node_run_id,
    nodeIndex: Number(row.node_index),
    nodeId: row.node_id,
    nodeKey: row.node_key,
    interventionId: row.intervention_id,
    input: parseRecord(row.input),
    defaultResponse: parseRecord(row.default_response),
    status: row.status,
    requestedAt: new Date(row.requested_at),
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    submittedAt: row.submitted_at ? new Date(row.submitted_at) : undefined,
    submittedBy: parseActor(row.submitted_by),
    response: row.response ? parseRecord(row.response) : undefined,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : undefined,
    cancelledBy: parseActor(row.cancelled_by),
    expiredAt: row.expired_at ? new Date(row.expired_at) : undefined,
  }
}

function assertNonNegativeInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowInterventionError(
      `[SixbPg] Workflow intervention ${fieldName} must be a non-negative integer.`
    )
  }
}

interface WorkflowInterventionDatabaseRow {
  project_id: string
  id: string
  workflow_id: string
  workflow_run_id: string
  node_run_id: string
  node_index: number | string
  node_id: string
  node_key: string
  intervention_id: string
  input: WorkflowIOSnapshot | string
  default_response: WorkflowIOSnapshot | string
  status: WorkflowInterventionRecord["status"]
  requested_at: Date | string
  expires_at: Date | string | null
  submitted_at: Date | string | null
  submitted_by: WorkflowInterventionActor | string | null
  response: WorkflowIOSnapshot | string | null
  cancelled_at: Date | string | null
  cancelled_by: WorkflowInterventionActor | string | null
  expired_at: Date | string | null
}
