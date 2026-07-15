import type { Database } from "bun:sqlite"
import type {
  FinishWebhookRunInput,
  ListWebhookRunsInput,
  ListWebhookRunsResult,
  StartWebhookRunInput,
  WebhookRunRecord,
  WebhookRunStorage,
} from "@sixb/core/storage"
import { WebhookRunError } from "@sixb/core/storage"
import { installFreshSqliteSchema } from "./migrations"
import {
  appendRunListFilters,
  hasEmptyStatuses,
  queryRunList,
  type SqliteValue,
} from "./run-list-query"
import { isUniqueConstraintError } from "./storage-errors"
import {
  closeSqliteStoreConnection,
  openSqliteStoreConnection,
  type SqliteStoreConnection,
} from "./transactions"

export interface SqliteWebhookRunStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteWebhookRunStorage implements WebhookRunStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database

  constructor(options: SqliteWebhookRunStorageOptions = {}) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db

    if (this.connection.installFreshSchema) {
      installFreshSqliteSchema(this.db)
    }
  }

  async start(input: StartWebhookRunInput): Promise<WebhookRunRecord> {
    const startedAt = input.startedAt ?? new Date()

    try {
      this.db
        .query(
          `
          INSERT INTO webhook_runs (
            project_id,
            id,
            connector_id,
            webhook_id,
            status,
            method,
            route,
            started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.connectorId,
          input.webhookId,
          "running",
          input.method,
          input.route,
          startedAt.toISOString()
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new WebhookRunError(
          `[SixbSqlite] Webhook run '${input.id}' already exists for project '${input.projectId}'.`
        )
      }

      throw error
    }

    const record = await this.getById({ projectId: input.projectId, id: input.id })
    if (!record) {
      throw new WebhookRunError(
        `[SixbSqlite] Failed to load webhook run '${input.id}' for project '${input.projectId}'.`
      )
    }

    return record
  }

  async finish(input: FinishWebhookRunInput): Promise<WebhookRunRecord> {
    return this.db.transaction(() => {
      const existing = this.db
        .query("SELECT * FROM webhook_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WebhookRunDatabaseRow | null

      if (!existing) {
        throw new WebhookRunError(
          `[SixbSqlite] Webhook run '${input.id}' not found for project '${input.projectId}'.`
        )
      }

      if (existing.status !== "running") {
        throw new WebhookRunError(
          `[SixbSqlite] Webhook run '${input.id}' for project '${input.projectId}' is already terminal.`
        )
      }

      this.db
        .query(
          `
          UPDATE webhook_runs
          SET
            status = ?,
            finished_at = ?,
            request_body_bytes = ?,
            response_status = ?,
            idempotency_key = ?,
            delivery_claim_result = ?,
            error = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          input.requestBodyBytes ?? null,
          input.responseStatus ?? null,
          input.idempotencyKey ?? null,
          input.deliveryClaimResult ?? null,
          input.status === "succeeded" ? null : (input.error ?? null),
          input.projectId,
          input.id
        )

      const updated = this.db
        .query("SELECT * FROM webhook_runs WHERE project_id = ? AND id = ?")
        .get(input.projectId, input.id) as WebhookRunDatabaseRow

      return rowToWebhookRunRecord(updated)
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<WebhookRunRecord | null> {
    const row = this.db
      .query("SELECT * FROM webhook_runs WHERE project_id = ? AND id = ?")
      .get(params.projectId, params.id) as WebhookRunDatabaseRow | null

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

    const whereClauses = ["project_id = ?"]
    const args: SqliteValue[] = [input.projectId]

    if (input.connectorId) {
      whereClauses.push("connector_id = ?")
      args.push(input.connectorId)
    }

    if (input.webhookId) {
      whereClauses.push("webhook_id = ?")
      args.push(input.webhookId)
    }

    if (input.idempotencyKey) {
      whereClauses.push("idempotency_key = ?")
      args.push(input.idempotencyKey)
    }

    appendRunListFilters(whereClauses, args, input)

    const { rows, total, hasMore } = queryRunList<WebhookRunDatabaseRow>({
      db: this.db,
      tableName: "webhook_runs",
      whereClauses,
      args,
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

  close(): void {
    closeSqliteStoreConnection(this.connection)
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
    requestBodyBytes: row.request_body_bytes ?? undefined,
    responseStatus: row.response_status ?? undefined,
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
  readonly started_at: string
  readonly finished_at: string | null
  readonly request_body_bytes: number | null
  readonly response_status: number | null
  readonly idempotency_key: string | null
  readonly delivery_claim_result: WebhookRunRecord["deliveryClaimResult"] | null
  readonly error: string | null
}
