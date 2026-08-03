import type { Database } from "bun:sqlite"
import { SixbError } from "@sixb/core/errors"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
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
} from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import { isUniqueConstraintError } from "./storage-errors"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteWorkflowInterventionStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteWorkflowInterventionStorage implements WorkflowInterventionStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteWorkflowInterventionStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async create(input: CreateWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    assertNonNegativeInteger(input.nodeIndex, "nodeIndex")

    try {
      this.db
        .query(
          `
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.workflowId,
          input.workflowRunId,
          input.nodeRunId,
          input.nodeIndex,
          input.nodeId,
          input.nodeKey,
          input.interventionId,
          serializeRecord(input.input),
          serializeRecord(input.defaultResponse),
          "pending",
          (input.requestedAt ?? new Date()).toISOString(),
          input.expiresAt?.toISOString() ?? null
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new SixbError(
          "storage.conflict",
          `[SixbSqlite] Workflow intervention '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }

    return this.requireIntervention(input.projectId, input.id)
  }

  async submit(input: SubmitWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    return this.db.transaction(() => {
      const existing = this.requirePendingIntervention(input.projectId, input.id)

      this.db
        .query(
          `
          UPDATE workflow_interventions
          SET
            status = ?,
            submitted_at = ?,
            submitted_by = ?,
            response = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          "submitted",
          (input.submittedAt ?? new Date()).toISOString(),
          serializeActor(input.submittedBy),
          serializeRecord(input.response),
          existing.project_id,
          existing.id
        )

      return this.requireIntervention(input.projectId, input.id)
    })()
  }

  async cancel(input: CancelWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    return this.db.transaction(() => {
      const existing = this.requirePendingIntervention(input.projectId, input.id)

      this.db
        .query(
          `
          UPDATE workflow_interventions
          SET
            status = ?,
            cancelled_at = ?,
            cancelled_by = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          "cancelled",
          (input.cancelledAt ?? new Date()).toISOString(),
          serializeActor(input.cancelledBy),
          existing.project_id,
          existing.id
        )

      return this.requireIntervention(input.projectId, input.id)
    })()
  }

  async expire(input: ExpireWorkflowInterventionInput): Promise<WorkflowInterventionRecord> {
    return this.db.transaction(() => {
      const existing = this.requirePendingIntervention(input.projectId, input.id)

      this.db
        .query(
          `
          UPDATE workflow_interventions
          SET
            status = ?,
            expired_at = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          "expired",
          (input.expiredAt ?? new Date()).toISOString(),
          existing.project_id,
          existing.id
        )

      return this.requireIntervention(input.projectId, input.id)
    })()
  }

  async getById(params: {
    projectId: string
    id: string
  }): Promise<WorkflowInterventionRecord | null> {
    const row = this.db
      .query("SELECT * FROM workflow_interventions WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as WorkflowInterventionDatabaseRow | null

    return row ? rowToWorkflowInterventionRecord(row) : null
  }

  async list(input: ListWorkflowInterventionsInput): Promise<ListWorkflowInterventionsResult> {
    if ((input.statuses && input.statuses.length === 0) || input.workflowIds?.length === 0) {
      return {
        interventions: [],
        hasMore: false,
        total: 0,
      }
    }

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.statuses) {
      whereClauses.push(`status IN (${input.statuses.map(() => "?").join(", ")})`)
      args.push(...input.statuses)
    }

    if (input.workflowId) {
      whereClauses.push("workflow_id = ?")
      args.push(input.workflowId)
    }

    if (input.workflowIds) {
      whereClauses.push(`workflow_id IN (${input.workflowIds.map(() => "?").join(", ")})`)
      args.push(...input.workflowIds)
    }

    if (input.workflowRunId) {
      whereClauses.push("workflow_run_id = ?")
      args.push(input.workflowRunId)
    }

    if (input.nodeRunId) {
      whereClauses.push("node_run_id = ?")
      args.push(input.nodeRunId)
    }

    if (input.nodeId) {
      whereClauses.push("node_id = ?")
      args.push(input.nodeId)
    }

    if (input.nodeKey) {
      whereClauses.push("node_key = ?")
      args.push(input.nodeKey)
    }

    if (input.interventionId) {
      whereClauses.push("intervention_id = ?")
      args.push(input.interventionId)
    }

    if (input.requestedAfter) {
      whereClauses.push("requested_at >= ?")
      args.push(input.requestedAfter.toISOString())
    }

    if (input.requestedBefore) {
      whereClauses.push("requested_at <= ?")
      args.push(input.requestedBefore.toISOString())
    }

    const where = `WHERE ${whereClauses.join(" AND ")}`
    const order = input.order === "asc" ? "ASC" : "DESC"
    const offset = input.offset ?? 0
    const totalRow = this.db
      .query(`SELECT COUNT(*) AS count FROM workflow_interventions ${where}`)
      .get(...args) as { count: number }

    let query = `
      SELECT * FROM workflow_interventions
      ${where}
      ORDER BY requested_at ${order}, id ${order}
    `
    const queryArgs = [...args]

    if (input.limit !== undefined) {
      query += " LIMIT ? OFFSET ?"
      queryArgs.push(input.limit, offset)
    } else if (offset > 0) {
      query += " LIMIT -1 OFFSET ?"
      queryArgs.push(offset)
    }

    const rows = this.db.query(query).all(...queryArgs) as WorkflowInterventionDatabaseRow[]

    return {
      interventions: rows.map(rowToWorkflowInterventionRecord),
      hasMore: offset + rows.length < totalRow.count,
      total: totalRow.count,
    }
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private requirePendingIntervention(
    projectId: string,
    id: string
  ): WorkflowInterventionDatabaseRow {
    const row = this.db
      .query("SELECT * FROM workflow_interventions WHERE project_id = ? AND id = ?")
      .get(projectId, id) as WorkflowInterventionDatabaseRow | null

    if (!row) {
      throw new SixbError(
        "workflow.intervention_not_found",
        `[SixbSqlite] Workflow intervention '${id}' not found for project '${projectId}'.`
      )
    }

    if (row.status !== "pending") {
      throw new SixbError(
        "storage.conflict",
        `[SixbSqlite] Workflow intervention '${id}' for project '${projectId}' is not pending.`
      )
    }

    return row
  }

  private requireIntervention(projectId: string, id: string): WorkflowInterventionRecord {
    const row = this.db
      .query("SELECT * FROM workflow_interventions WHERE project_id = ? AND id = ?")
      .get(projectId, id) as WorkflowInterventionDatabaseRow | null

    if (!row) {
      throw new SixbError(
        "runtime.invalid_input",
        `[SixbSqlite] Failed to load workflow intervention '${id}' for project '${projectId}'.`
      )
    }

    return rowToWorkflowInterventionRecord(row)
  }
}

type SqliteValue = string | number | null

function serializeRecord(value: WorkflowIOSnapshot): string {
  return JSON.stringify(value)
}

function parseRecord(value: string): WorkflowIOSnapshot {
  return JSON.parse(value) as WorkflowIOSnapshot
}

function serializeActor(actor: WorkflowInterventionActor | undefined): string | null {
  return actor ? JSON.stringify(actor) : null
}

function parseActor(value: string | null): WorkflowInterventionActor | undefined {
  return value ? (JSON.parse(value) as WorkflowInterventionActor) : undefined
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
    nodeIndex: row.node_index,
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
    throw new SixbError(
      "runtime.invalid_input",
      `[SixbSqlite] Workflow intervention ${fieldName} must be a non-negative integer.`
    )
  }
}

interface WorkflowInterventionDatabaseRow {
  project_id: string
  id: string
  workflow_id: string
  workflow_run_id: string
  node_run_id: string
  node_index: number
  node_id: string
  node_key: string
  intervention_id: string
  input: string
  default_response: string
  status: WorkflowInterventionRecord["status"]
  requested_at: string
  expires_at: string | null
  submitted_at: string | null
  submitted_by: string | null
  response: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  expired_at: string | null
}
