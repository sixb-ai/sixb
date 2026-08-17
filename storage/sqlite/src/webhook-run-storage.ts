import type { Database } from "bun:sqlite"
import { parseSixbFailure, serializeSixbFailure } from "@sixb/core/internal/errors"
import { assertWebhookRunExecution } from "@sixb/core/internal/webhook-run-storage-provider"
import type {
  ExecutionStorage,
  FinishWebhookRunInput,
  GetWebhookRunByDeliveryInput,
  ListWebhookRunsInput,
  ListWebhookRunsResult,
  RestartWebhookRunInput,
  StartWebhookRunInput,
  WebhookRunRecord,
  WebhookRunStorage,
} from "@sixb/core/storage"
import { canRetryWebhookRun, WEBHOOK_RUN_FAILURE_CODES, WebhookRunError } from "@sixb/core/storage"
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
  /** Execution lookup sharing the same provider transaction. */
  executions: ExecutionStorage
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
  /** Internal shared connection used by bundled SqliteStorage. */
  connection?: SqliteStoreConnection
}

export class SqliteWebhookRunStorage implements WebhookRunStorage {
  private readonly connection: SqliteStoreConnection
  private readonly db: Database
  private readonly executions: ExecutionStorage

  constructor(options: SqliteWebhookRunStorageOptions) {
    this.connection = openSqliteStoreConnection(options)
    this.db = this.connection.db
    this.executions = options.executions

    if (this.connection.installFreshSchema) installFreshSqliteSchema(this.db)
  }

  async start(input: StartWebhookRunInput): Promise<WebhookRunRecord> {
    const startedAt = input.startedAt ?? new Date()
    await assertWebhookRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      route: input.route,
    })

    try {
      this.db
        .query(
          `
          INSERT INTO webhook_runs (
            project_id, id, execution_id, connector_id, webhook_id, status, method, route,
            started_at, request_body_bytes, request_body_sha256, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.projectId,
          input.id,
          input.executionId,
          input.connectorId,
          input.webhookId,
          "running",
          input.method,
          input.route,
          startedAt.toISOString(),
          input.requestBodyBytes,
          input.requestBodySha256,
          input.idempotencyKey ?? null
        )
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new WebhookRunError(
          `[SixbSqlite] Webhook run '${input.id}' or delivery key already exists for project '${input.projectId}'.`,
          "duplicate_run"
        )
      }
      throw error
    }

    return this.requireWebhookRun(input.projectId, input.id)
  }

  async restart(input: RestartWebhookRunInput): Promise<WebhookRunRecord> {
    return this.db.transaction(() => {
      const existing = this.getWebhookRunRow(input.projectId, input.id)
      if (!existing) {
        throw new WebhookRunError(
          `[SixbSqlite] Webhook run '${input.id}' not found for project '${input.projectId}'.`,
          "not_found"
        )
      }
      if (!canRetryWebhookRun(rowToWebhookRunRecord(existing))) {
        throw new WebhookRunError(
          `[SixbSqlite] Webhook run '${input.id}' cannot restart from status '${existing.status}'.`,
          "invalid_transition"
        )
      }

      const result = this.db
        .query(
          `
          UPDATE webhook_runs
          SET status = 'running', started_at = ?, finished_at = NULL,
              response_status = NULL, error = NULL
          WHERE project_id = ? AND id = ? AND status = 'failed'
        `
        )
        .run((input.startedAt ?? new Date()).toISOString(), input.projectId, input.id)
      if (result.changes === 0) {
        throw new WebhookRunError(
          `[SixbSqlite] Webhook run '${input.id}' changed while restarting.`,
          "invalid_transition"
        )
      }
      return this.requireWebhookRun(input.projectId, input.id)
    })()
  }

  async finish(input: FinishWebhookRunInput): Promise<WebhookRunRecord> {
    return this.db.transaction(() => {
      const existing = this.getWebhookRunRow(input.projectId, input.id)
      if (!existing) {
        throw new WebhookRunError(
          `[SixbSqlite] Webhook run '${input.id}' not found for project '${input.projectId}'.`,
          "not_found"
        )
      }
      if (existing.status !== "running") {
        throw new WebhookRunError(
          `[SixbSqlite] Webhook run '${input.id}' for project '${input.projectId}' is already terminal.`,
          "invalid_transition"
        )
      }

      this.db
        .query(
          `
          UPDATE webhook_runs
          SET status = ?, finished_at = ?, response_status = ?, error = ?
          WHERE project_id = ? AND id = ?
        `
        )
        .run(
          input.status,
          (input.finishedAt ?? new Date()).toISOString(),
          input.responseStatus ?? null,
          input.status === "succeeded"
            ? null
            : serializeSixbFailure(input.error, WEBHOOK_RUN_FAILURE_CODES),
          input.projectId,
          input.id
        )
      return this.requireWebhookRun(input.projectId, input.id)
    })()
  }

  async getById(params: { projectId: string; id: string }): Promise<WebhookRunRecord | null> {
    const row = this.getWebhookRunRow(params.projectId, params.id)
    return row ? rowToWebhookRunRecord(row) : null
  }

  async getByDelivery(input: GetWebhookRunByDeliveryInput): Promise<WebhookRunRecord | null> {
    const row = this.db
      .query(
        `
        SELECT * FROM webhook_runs
        WHERE project_id = ? AND connector_id = ? AND webhook_id = ? AND idempotency_key = ?
      `
      )
      .get(
        input.projectId,
        input.connectorId,
        input.webhookId,
        input.idempotencyKey
      ) as WebhookRunDatabaseRow | null
    return row ? rowToWebhookRunRecord(row) : null
  }

  async list(input: ListWebhookRunsInput): Promise<ListWebhookRunsResult> {
    if (hasEmptyStatuses(input)) return { runs: [], hasMore: false, total: 0 }

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
    return { runs: rows.map(rowToWebhookRunRecord), hasMore, total }
  }

  close(): void {
    closeSqliteStoreConnection(this.connection)
  }

  private getWebhookRunRow(projectId: string, id: string): WebhookRunDatabaseRow | null {
    return this.db
      .query("SELECT * FROM webhook_runs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as WebhookRunDatabaseRow | null
  }

  private requireWebhookRun(projectId: string, id: string): WebhookRunRecord {
    const row = this.getWebhookRunRow(projectId, id)
    if (!row) {
      throw new WebhookRunError(
        `[SixbSqlite] Failed to load webhook run '${id}' for project '${projectId}'.`,
        "not_found"
      )
    }
    return rowToWebhookRunRecord(row)
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
    method: row.method,
    route: row.route,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    requestBodyBytes: row.request_body_bytes,
    requestBodySha256: row.request_body_sha256,
    responseStatus: row.response_status ?? undefined,
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
  readonly method: string
  readonly route: string
  readonly started_at: string
  readonly finished_at: string | null
  readonly request_body_bytes: number
  readonly request_body_sha256: string
  readonly response_status: number | null
  readonly idempotency_key: string | null
  readonly error: string | null
}
