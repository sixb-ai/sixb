import type {
  FinishWebhookRunInput,
  ListWebhookRunsInput,
  ListWebhookRunsResult,
  StartWebhookRunInput,
  WebhookRunRecord,
  WebhookRunStorage,
} from "@sixb/core/storage"
import { WebhookRunError } from "@sixb/core/storage"
import type { SqlParameter } from "./pg-client"
import { appendRunListFilters, hasEmptyStatuses, queryRunList } from "./run-list-query"
import { isUniqueViolation } from "./storage-errors"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgWebhookRunStorage implements WebhookRunStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async start(input: StartWebhookRunInput): Promise<WebhookRunRecord> {
    try {
      const [row] = await this.sql<WebhookRunDatabaseRow[]>`
        INSERT INTO webhook_runs (
          project_id,
          id,
          connector_id,
          webhook_id,
          status,
          method,
          route,
          started_at
        ) VALUES (
          ${input.projectId},
          ${input.id},
          ${input.connectorId},
          ${input.webhookId},
          ${"running"},
          ${input.method},
          ${input.route},
          ${input.startedAt ?? new Date()}
        )
        RETURNING *
      `

      return rowToWebhookRunRecord(row)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WebhookRunError(
          `[SixbPg] Webhook run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }
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
          `[SixbPg] Webhook run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "running") {
        throw new WebhookRunError(
          `[SixbPg] Webhook run '${input.id}' for project '${input.projectId}' is already terminal.`
        )
      }

      const [updated] = await tx<WebhookRunDatabaseRow[]>`
        UPDATE webhook_runs
        SET
          status = ${input.status},
          finished_at = ${input.finishedAt ?? new Date()},
          request_body_bytes = ${input.requestBodyBytes ?? null},
          response_status = ${input.responseStatus ?? null},
          idempotency_key = ${input.idempotencyKey ?? null},
          delivery_claim_result = ${input.deliveryClaimResult ?? null},
          error = ${input.status === "succeeded" ? null : (input.error ?? null)}
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

  async list(input: ListWebhookRunsInput): Promise<ListWebhookRunsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

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

    return {
      runs: rows.map(rowToWebhookRunRecord),
      hasMore,
      total,
    }
  }
}

function rowToWebhookRunRecord(row: WebhookRunDatabaseRow): WebhookRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    connectorId: row.connector_id,
    webhookId: row.webhook_id,
    status: row.status,
    method: row.method,
    route: row.route,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    requestBodyBytes: row.request_body_bytes != null ? Number(row.request_body_bytes) : undefined,
    responseStatus: row.response_status != null ? Number(row.response_status) : undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    deliveryClaimResult: row.delivery_claim_result ?? undefined,
    error: row.error ?? undefined,
  }
}

interface WebhookRunDatabaseRow {
  readonly project_id: string
  readonly id: string
  readonly connector_id: string
  readonly webhook_id: string
  readonly status: WebhookRunRecord["status"]
  readonly method: string
  readonly route: string
  readonly started_at: Date | string
  readonly finished_at: Date | string | null
  readonly request_body_bytes: number | string | null
  readonly response_status: number | string | null
  readonly idempotency_key: string | null
  readonly delivery_claim_result: WebhookRunRecord["deliveryClaimResult"] | null
  readonly error: string | null
}
