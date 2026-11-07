import { parseSixbFailure, serializeSixbFailure } from "@sixb/core/internal/errors"
import { assertWebhookRunExecution } from "@sixb/core/internal/webhook-run-storage-provider"
import type {
  ExecutionStorage,
  FinishWebhookRunInput,
  GetWebhookRunByDeliveryInput,
  ListWebhookRunsInput,
  ListWebhookRunsResult,
  RenewWebhookRunInput,
  RestartWebhookRunInput,
  StartWebhookRunInput,
  WebhookRunRecord,
  WebhookRunStorage,
} from "@sixb/core/storage"
import { canRetryWebhookRun, WEBHOOK_RUN_FAILURE_CODES, WebhookRunError } from "@sixb/core/storage"
import type { SqlParameter } from "./pg-client"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "./run-list-query"
import { isUniqueViolation } from "./storage-errors"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgWebhookRunStorage implements WebhookRunStorage {
  constructor(
    private readonly sql: PgStoreClient,
    private readonly executions: ExecutionStorage
  ) {}

  async start(input: StartWebhookRunInput): Promise<WebhookRunRecord> {
    await assertWebhookRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      route: input.route,
    })
    try {
      const [row] = await this.sql<WebhookRunDatabaseRow[]>`
        INSERT INTO webhook_runs (
          project_id, id, execution_id, connector_id, webhook_id, status, method, route,
          execution_token, execution_lease_expires_at,
          started_at, request_body_bytes, request_body_sha256, idempotency_key
        ) VALUES (
          ${input.projectId}, ${input.id}, ${input.executionId}, ${input.connectorId},
          ${input.webhookId}, ${"running"}, ${input.method}, ${input.route},
          ${input.execution.token}, ${input.execution.leaseExpiresAt},
          ${input.startedAt ?? new Date()}, ${input.requestBodyBytes},
          ${input.requestBodySha256}, ${input.idempotencyKey ?? null}
        )
        RETURNING *
      `
      return rowToWebhookRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WebhookRunError(
          `[SixbPg] Webhook run '${input.id}' or delivery key already exists for project '${input.projectId}'.`,
          "duplicate_run"
        )
      }
      throw error
    }
  }

  async restart(input: RestartWebhookRunInput): Promise<WebhookRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<WebhookRunDatabaseRow[]>`
        SELECT * FROM webhook_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      if (!existing) {
        throw new WebhookRunError(
          `[SixbPg] Webhook run '${input.id}' not found for project '${input.projectId}'.`,
          "not_found"
        )
      }
      const startedAt = input.startedAt ?? new Date()
      if (!canRetryWebhookRun(rowToWebhookRunRecord(existing), startedAt)) {
        throw new WebhookRunError(
          `[SixbPg] Webhook run '${input.id}' cannot restart from status '${existing.status}'.`,
          "invalid_transition"
        )
      }

      const [updated] = await tx<WebhookRunDatabaseRow[]>`
        UPDATE webhook_runs
        SET status = ${"running"}, execution_token = ${input.execution.token},
            execution_lease_expires_at = ${input.execution.leaseExpiresAt},
            started_at = ${startedAt}, finished_at = ${null}, response_status = ${null},
            error = ${null}
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `
      return rowToWebhookRunRecord(updated)
    })
  }

  async renewLease(input: RenewWebhookRunInput): Promise<boolean> {
    const updated = await this.sql<WebhookRunDatabaseRow[]>`
      UPDATE webhook_runs SET execution_lease_expires_at = ${input.leaseExpiresAt}
      WHERE project_id = ${input.projectId} AND id = ${input.id} AND status = ${"running"}
        AND execution_token = ${input.executionToken}
      RETURNING *
    `
    return updated.length > 0
  }

  async finish(input: FinishWebhookRunInput): Promise<WebhookRunRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const [existing] = await tx<WebhookRunDatabaseRow[]>`
        SELECT * FROM webhook_runs
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        FOR UPDATE
      `
      if (!existing) {
        throw new WebhookRunError(
          `[SixbPg] Webhook run '${input.id}' not found for project '${input.projectId}'.`,
          "not_found"
        )
      }
      if (existing.status !== "running") {
        throw new WebhookRunError(
          `[SixbPg] Webhook run '${input.id}' for project '${input.projectId}' is already terminal.`,
          "invalid_transition"
        )
      }
      if (existing.execution_token !== input.executionToken) {
        throw new WebhookRunError(
          `[SixbPg] Execution token is no longer current on webhook run '${input.id}'.`,
          "invalid_transition"
        )
      }

      const [updated] = await tx<WebhookRunDatabaseRow[]>`
        UPDATE webhook_runs
        SET status = ${input.status}, execution_token = ${null},
            execution_lease_expires_at = ${null}, finished_at = ${input.finishedAt ?? new Date()},
            response_status = ${input.responseStatus ?? null},
            error = ${input.status === "succeeded" ? null : serializeSixbFailure(input.error, WEBHOOK_RUN_FAILURE_CODES)}::text::jsonb
        WHERE project_id = ${input.projectId} AND id = ${input.id}
        RETURNING *
      `
      return rowToWebhookRunRecord(updated)
    })
  }

  async getById(params: { projectId: string; id: string }): Promise<WebhookRunRecord | null> {
    const [row] = await this.sql<WebhookRunDatabaseRow[]>`
      SELECT * FROM webhook_runs
      WHERE project_id = ${params.projectId} AND id = ${params.id}
    `
    return row ? rowToWebhookRunRecord(row) : null
  }

  async getByDelivery(input: GetWebhookRunByDeliveryInput): Promise<WebhookRunRecord | null> {
    const [row] = await this.sql<WebhookRunDatabaseRow[]>`
      SELECT * FROM webhook_runs
      WHERE project_id = ${input.projectId}
        AND connector_id = ${input.connectorId}
        AND webhook_id = ${input.webhookId}
        AND idempotency_key = ${input.idempotencyKey}
    `
    return row ? rowToWebhookRunRecord(row) : null
  }

  async list(input: ListWebhookRunsInput): Promise<ListWebhookRunsResult> {
    if (hasEmptyStatuses(input)) return { runs: [], hasMore: false, total: 0 }

    const whereClauses = ["project_id = $1"]
    const params: SqlParameter[] = [input.projectId]
    let index = 2
    if (input.connectorId) {
      whereClauses.push(`connector_id = $${index++}`)
      params.push(input.connectorId)
    }
    if (input.webhookId) {
      whereClauses.push(`webhook_id = $${index++}`)
      params.push(input.webhookId)
    }
    if (input.idempotencyKey) {
      whereClauses.push(`idempotency_key = $${index++}`)
      params.push(input.idempotencyKey)
    }
    index = appendRunListFilters(whereClauses, params, index, input)

    const { rows, total, hasMore } = await queryRunList<WebhookRunDatabaseRow>({
      sql: this.sql,
      tableName: "webhook_runs",
      whereClauses,
      params,
      nextIndex: index,
      order: input.order,
      limit: input.limit,
      offset: input.offset,
    })
    return { runs: rows.map(rowToWebhookRunRecord), hasMore, total }
  }
}

function rowToWebhookRunRecord(row: WebhookRunDatabaseRow): WebhookRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    executionId: row.execution_id,
    connectorId: row.connector_id,
    webhookId: row.webhook_id,
    status: row.status,
    execution:
      row.execution_token && row.execution_lease_expires_at
        ? {
            token: row.execution_token,
            leaseExpiresAt: new Date(row.execution_lease_expires_at),
          }
        : undefined,
    method: row.method,
    route: row.route,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    requestBodyBytes: Number(row.request_body_bytes),
    requestBodySha256: row.request_body_sha256,
    responseStatus: row.response_status != null ? Number(row.response_status) : undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    error: row.error === null ? undefined : parseSixbFailure(row.error, WEBHOOK_RUN_FAILURE_CODES),
  }
}

interface WebhookRunDatabaseRow {
  readonly project_id: string
  readonly id: string
  readonly execution_id: string
  readonly connector_id: string
  readonly webhook_id: string
  readonly status: WebhookRunRecord["status"]
  readonly execution_token: string | null
  readonly execution_lease_expires_at: Date | string | null
  readonly method: string
  readonly route: string
  readonly started_at: Date | string
  readonly finished_at: Date | string | null
  readonly request_body_bytes: number | string
  readonly request_body_sha256: string
  readonly response_status: number | string | null
  readonly idempotency_key: string | null
  readonly error: unknown | null
}
