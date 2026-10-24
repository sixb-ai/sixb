import {
  compareExecutionCreation,
  type ExecutionStorageRow,
  executionRecordFromStorageRow,
  executionRecordToStorageRow,
  prepareExecutionRecord,
} from "@sixb/core/internal/execution-storage"
import type {
  CreateExecutionInput,
  ExecutionDescendant,
  ExecutionRecord,
  ExecutionStorage,
  ListExecutionDescendantsInput,
  ListSessionExecutionsInput,
  SessionExecutions,
  ShareSessionStorage,
} from "@sixb/core/storage"
import { ExecutionStorageError } from "@sixb/core/storage"
import type { PgAuthStorage } from "./auth-storage"
import { isUniqueViolation } from "./storage-errors"
import type { PgStoreClient } from "./transactions"

export class PgExecutionStorage implements ExecutionStorage {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly auth: PgAuthStorage,
    private readonly shareSessions: Pick<ShareSessionStorage, "getById">
  ) {}

  async create(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const record = await prepareExecutionRecord(input, {
      auth: this.auth,
      getExecution: (params) => this.getById(params),
      getShareSession: (params) => this.shareSessions.getById(params),
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
          requester_group_ids,
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
        ) VALUES (
          ${row.projectId},
          ${row.id},
          ${row.executorKind},
          ${row.executorId},
          ${row.sourceKind},
          ${row.sourceId},
          ${row.requestedByUserId},
          ${row.requestedByServiceAccountId},
          ${JSON.stringify(row.requesterGroupIds)}::text::jsonb,
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
          ${row.authorityDelegationKind},
          ${row.authorityDelegationId},
          ${row.authorityDelegationSessionId},
          ${row.createdAt}
        )
        RETURNING *
      `

      if (!created) {
        throw new Error("[SixbPg] Execution insert returned no row.")
      }
      return pgExecutionRecord(created)
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
    return row ? pgExecutionRecord(row) : null
  }

  async listBySession(input: ListSessionExecutionsInput): Promise<SessionExecutions> {
    const session =
      input.session.type === "user"
        ? this.sql`authority_session_id = ${input.session.id}`
        : this.sql`authority_delegation_session_id = ${input.session.id}`

    // Each iteration of a recursive query reads the rows the previous one produced, so the walk goes
    // level by level, roots first; with no ORDER BY outside, PostgreSQL evaluates only the rows the
    // limit returns. Within the last level reached, which rows come first is unspecified.
    const rows = await this.sql<(PgExecutionRow & { readonly depth: number })[]>`
      WITH RECURSIVE tree AS (
        (
          SELECT *, 0 AS depth
          FROM executions
          WHERE project_id = ${input.projectId}
            AND ${session}
            AND parent_execution_id IS NULL
            AND created_at >= ${input.from}
            AND created_at < ${input.to}
          ORDER BY created_at, id
          LIMIT ${input.limit + 1}
        )
        UNION ALL
        SELECT child.*, tree.depth + 1
        FROM tree
        JOIN executions child
          ON child.project_id = tree.project_id
          AND child.parent_execution_id = tree.id
      )
      SELECT * FROM tree
      LIMIT ${input.limit + 1}
    `

    // Keep the first `limit` by depth, then oldest first, as the contract keeps them.
    const records = rows
      .map((row) => ({ depth: row.depth, record: pgExecutionRecord(row) }))
      .sort(
        (left, right) =>
          left.depth - right.depth || compareExecutionCreation(left.record, right.record)
      )
      .slice(0, input.limit)
      .map(({ record }) => record)

    return {
      executions: records.sort(compareExecutionCreation),
      truncated: rows.length > input.limit,
    }
  }

  async listDescendants(
    input: ListExecutionDescendantsInput
  ): Promise<readonly ExecutionDescendant[]> {
    if (input.executionIds.length === 0) return []
    const ids = this.sql.array([...new Set(input.executionIds)])

    // UNION, not UNION ALL: an execution asked about may sit below another one asked about, and
    // the walk would otherwise reach what it caused twice.
    const rows = await this.sql<{ id: string; parent_id: string }[]>`
      WITH RECURSIVE tree(id, parent_id) AS (
        SELECT child.id, child.parent_execution_id
        FROM executions child
        WHERE child.project_id = ${input.projectId}
          AND child.parent_execution_id = ANY(${ids}::text[])
        UNION
        SELECT child.id, child.parent_execution_id
        FROM tree
        JOIN executions child
          ON child.project_id = ${input.projectId}
          AND child.parent_execution_id = tree.id
      )
      SELECT id, parent_id
      FROM tree
      WHERE id <> ALL(${ids}::text[])
      ORDER BY id COLLATE "C"
    `
    return rows.map((row) => ({ id: row.id, parentId: row.parent_id }))
  }
}

/** An `executions` row as its record, for any store that reads executions alongside its own rows. */
export function pgExecutionRecord(row: PgExecutionRow): ExecutionRecord {
  return executionRecordFromStorageRow(toStorageRow(row))
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
    requesterGroupIds: row.requester_group_ids,
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

export interface PgExecutionRow {
  readonly project_id: string
  readonly id: string
  readonly executor_kind: ExecutionStorageRow["executorKind"]
  readonly executor_id: string
  readonly source_kind: ExecutionStorageRow["sourceKind"]
  readonly source_id: string
  readonly requested_by_user_id: string | null
  readonly requested_by_service_account_id: string | null
  readonly requester_group_ids: string[]
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
  readonly created_at: Date | string
}
