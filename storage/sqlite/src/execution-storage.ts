import type { Database } from "bun:sqlite"
import {
  type ExecutionStorageRow,
  executionRecordFromStorageRow,
  executionRecordToStorageRow,
  normalizeExecutionRecord,
  validateExecutionRecordReferences,
} from "@sixb/core/internal/execution-storage"
import type {
  CreateExecutionInput,
  ExecutionRecord,
  ExecutionStorage,
  ShareSessionStorage,
} from "@sixb/core/storage"
import { ExecutionStorageError } from "@sixb/core/storage"
import type { SqliteAuthStorage } from "./auth-storage"

export class SqliteExecutionStorage implements ExecutionStorage {
  constructor(
    private readonly db: Database,
    private readonly auth: SqliteAuthStorage,
    private readonly shareSessions: Pick<ShareSessionStorage, "getById">
  ) {}

  async create(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const record = normalizeExecutionRecord(input)
    await validateExecutionRecordReferences(record, {
      auth: this.auth,
      getExecution: (params) => this.getById(params),
      getShareSession: (params) => this.shareSessions.getById(params),
    })
    const row = executionRecordToStorageRow(record)

    try {
      this.db
        .query(
          `
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
            authority_delegation_kind,
            authority_delegation_id,
            authority_delegation_session_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          row.projectId,
          row.id,
          row.executorKind,
          row.executorId,
          row.sourceKind,
          row.sourceId,
          row.requestedByUserId,
          row.requestedByServiceAccountId,
          row.correlationId,
          row.parentExecutionId,
          row.authorityKind,
          row.authorityUserId,
          row.authorityServiceAccountId,
          row.authoritySessionId,
          row.authorityAccessTokenId,
          row.authorityPrimitiveKind,
          row.authorityPrimitiveId,
          row.authorityKernelOperation,
          row.authorityDelegationKind,
          row.authorityDelegationId,
          row.authorityDelegationSessionId,
          row.createdAt.toISOString()
        )
    } catch (error) {
      if (isDuplicateExecutionError(error)) {
        throw new ExecutionStorageError(
          "duplicate_execution",
          `[SixbSqlite] Execution '${record.id}' already exists in project '${record.projectId}'.`,
          { cause: error }
        )
      }
      throw error
    }

    return executionRecordFromStorageRow(row)
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ExecutionRecord | null> {
    const row = this.db
      .query(
        `
        SELECT *
        FROM executions
        WHERE project_id = ? AND id = ?
      `
      )
      .get(params.projectId, params.id) as SqliteExecutionRow | null

    return row ? executionRecordFromStorageRow(toStorageRow(row)) : null
  }
}

function toStorageRow(row: SqliteExecutionRow): ExecutionStorageRow {
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
    authorityDelegationKind: row.authority_delegation_kind,
    authorityDelegationId: row.authority_delegation_id,
    authorityDelegationSessionId: row.authority_delegation_session_id,
    createdAt: new Date(row.created_at),
  }
}

function isDuplicateExecutionError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed: executions.project_id, executions.id")
  )
}

interface SqliteExecutionRow {
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
  readonly authority_delegation_kind: ExecutionStorageRow["authorityDelegationKind"]
  readonly authority_delegation_id: string | null
  readonly authority_delegation_session_id: string | null
  readonly created_at: string
}
