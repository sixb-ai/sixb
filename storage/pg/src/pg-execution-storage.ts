import {
  type ExecutionStorageRow,
  executionRecordFromStorageRow,
  executionRecordToStorageRow,
  normalizeExecutionRecord,
  validateExecutionRecordReferences,
} from "@sixb/core/internal/execution-storage"
import type { CreateExecutionInput, ExecutionRecord, ExecutionStorage } from "@sixb/core/storage"
import { ExecutionStorageError } from "@sixb/core/storage"
import type { PgAuthStorage } from "./auth-storage"
import { isUniqueViolation } from "./storage-errors"
import type { PgStoreClient } from "./transactions"

export class PgExecutionStorage implements ExecutionStorage {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly auth: PgAuthStorage
  ) {}

  async create(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const record = normalizeExecutionRecord(input)
    await validateExecutionRecordReferences(record, {
      auth: this.auth,
      getExecution: (params) => this.getById(params),
    })
    const row = executionRecordToStorageRow(record)

    try {
      const [created] = await this.sql<PgExecutionRow[]>`
        INSERT INTO executions (
          project_id,
          id,
          executor_kind,
          executor_id,
          source_kind,
          source_id,
          requested_by_user_id,
          requested_by_service_account_id,
          correlation_id,
          parent_execution_id,
          authority_kind,
          authority_user_id,
          authority_service_account_id,
          authority_session_id,
          authority_access_token_id,
          authority_primitive_kind,
          authority_primitive_id,
          authority_kernel_operation,
          created_at
        ) VALUES (
          ${row.projectId},
          ${row.id},
          ${row.executorKind},
          ${row.executorId},
          ${row.sourceKind},
          ${row.sourceId},
          ${row.requestedByUserId},
          ${row.requestedByServiceAccountId},
          ${row.correlationId},
          ${row.parentExecutionId},
          ${row.authorityKind},
          ${row.authorityUserId},
          ${row.authorityServiceAccountId},
          ${row.authoritySessionId},
          ${row.authorityAccessTokenId},
          ${row.authorityPrimitiveKind},
          ${row.authorityPrimitiveId},
          ${row.authorityKernelOperation},
          ${row.createdAt}
        )
        RETURNING *
      `

      if (!created) {
        throw new Error("[SixbPg] Execution insert returned no row.")
      }
      return executionRecordFromStorageRow(toStorageRow(created))
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ExecutionStorageError(
          "duplicate_execution",
          `[SixbPg] Execution '${record.id}' already exists in project '${record.projectId}'.`,
          { cause: error }
        )
      }
      throw error
    }
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ExecutionRecord | null> {
    const [row] = await this.sql<PgExecutionRow[]>`
      SELECT *
      FROM executions
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `
    return row ? executionRecordFromStorageRow(toStorageRow(row)) : null
  }
}

function toStorageRow(row: PgExecutionRow): ExecutionStorageRow {
  return {
    projectId: row.project_id,
    id: row.id,
    executorKind: row.executor_kind,
    executorId: row.executor_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    requestedByUserId: row.requested_by_user_id,
    requestedByServiceAccountId: row.requested_by_service_account_id,
    correlationId: row.correlation_id,
    parentExecutionId: row.parent_execution_id,
    authorityKind: row.authority_kind,
    authorityUserId: row.authority_user_id,
    authorityServiceAccountId: row.authority_service_account_id,
    authoritySessionId: row.authority_session_id,
    authorityAccessTokenId: row.authority_access_token_id,
    authorityPrimitiveKind: row.authority_primitive_kind,
    authorityPrimitiveId: row.authority_primitive_id,
    authorityKernelOperation: row.authority_kernel_operation,
    createdAt: new Date(row.created_at),
  }
}

interface PgExecutionRow {
  readonly project_id: string
  readonly id: string
  readonly executor_kind: ExecutionStorageRow["executorKind"]
  readonly executor_id: string
  readonly source_kind: ExecutionStorageRow["sourceKind"]
  readonly source_id: string
  readonly requested_by_user_id: string | null
  readonly requested_by_service_account_id: string | null
  readonly correlation_id: string
  readonly parent_execution_id: string | null
  readonly authority_kind: ExecutionStorageRow["authorityKind"]
  readonly authority_user_id: string | null
  readonly authority_service_account_id: string | null
  readonly authority_session_id: string | null
  readonly authority_access_token_id: string | null
  readonly authority_primitive_kind: ExecutionStorageRow["authorityPrimitiveKind"]
  readonly authority_primitive_id: string | null
  readonly authority_kernel_operation: ExecutionStorageRow["authorityKernelOperation"]
  readonly created_at: Date | string
}
