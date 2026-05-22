import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type {
  WebhookDeliveryClaimRecord,
  WebhookDeliveryClaimResult,
  WebhookDeliveryKey,
  WebhookDeliveryRecord,
  WebhookDeliveryStorage,
} from "@pario/core"
import { installFreshSqliteSchema } from "./migrations"

export interface SqliteWebhookDeliveryStorageOptions {
  /** Path to SQLite database file. Defaults to ':memory:' for in-memory database. */
  path?: string
}

export class SqliteWebhookDeliveryStorage implements WebhookDeliveryStorage {
  private readonly db: Database

  constructor(options: SqliteWebhookDeliveryStorageOptions = {}) {
    const path = options.path ?? ":memory:"
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)

    if (path === ":memory:") {
      installFreshSqliteSchema(this.db)
    }
  }

  async claim(
    input: WebhookDeliveryKey & { receivedAt: string }
  ): Promise<WebhookDeliveryClaimRecord> {
    return this.db.transaction(() => {
      // Atomic first claim: only one request can insert this scoped delivery key.
      const inserted = this.db
        .query(
          `
          INSERT OR IGNORE INTO webhook_deliveries (
            project_id,
            connector_id,
            webhook_id,
            idempotency_key,
            status,
            received_at
          ) VALUES (?, ?, ?, ?, 'in_progress', ?)
        `
        )
        .run(
          input.projectId,
          input.connectorId,
          input.webhookId,
          input.idempotencyKey,
          input.receivedAt
        ) as { changes: number }

      if (inserted.changes > 0) {
        return toWebhookDeliveryClaimRecord(
          {
            projectId: input.projectId,
            connectorId: input.connectorId,
            webhookId: input.webhookId,
            idempotencyKey: input.idempotencyKey,
            status: "in_progress",
            receivedAt: input.receivedAt,
          },
          "claimed"
        )
      }

      const existing = this.getDeliveryRecord(input)

      if (existing?.status === "completed") {
        return toWebhookDeliveryClaimRecord(existing, "duplicate")
      }

      if (existing?.status === "in_progress") {
        return toWebhookDeliveryClaimRecord(existing, "in_progress")
      }

      if (existing?.status !== "failed") {
        throw new Error("[ParioSqlite] Webhook delivery row disappeared during claim.")
      }

      // Failed deliveries are intentionally claimable so provider retries can run again.
      const claimed = this.db
        .query(
          `
          UPDATE webhook_deliveries
          SET status = 'in_progress',
              received_at = ?,
              completed_at = NULL,
              failed_at = NULL,
              error = NULL
          WHERE project_id = ?
            AND connector_id = ?
            AND webhook_id = ?
            AND idempotency_key = ?
            AND status = 'failed'
        `
        )
        .run(
          input.receivedAt,
          input.projectId,
          input.connectorId,
          input.webhookId,
          input.idempotencyKey
        ) as { changes: number }

      if (claimed.changes > 0) {
        return toWebhookDeliveryClaimRecord(this.requireDeliveryRecord(input, "claim"), "claimed")
      }

      const current = this.requireDeliveryRecord(input, "claim")
      return toWebhookDeliveryClaimRecord(
        current,
        current.status === "completed" ? "duplicate" : "in_progress"
      )
    })()
  }

  async complete(
    input: WebhookDeliveryKey & { completedAt: string }
  ): Promise<WebhookDeliveryRecord> {
    this.db
      .query(
        `
        UPDATE webhook_deliveries
        SET status = 'completed',
            completed_at = ?,
            failed_at = NULL,
            error = NULL
        WHERE project_id = ?
          AND connector_id = ?
          AND webhook_id = ?
          AND idempotency_key = ?
      `
      )
      .run(
        input.completedAt,
        input.projectId,
        input.connectorId,
        input.webhookId,
        input.idempotencyKey
      )

    return this.requireDeliveryRecord(input, "complete")
  }

  async fail(
    input: WebhookDeliveryKey & { failedAt: string; error: string }
  ): Promise<WebhookDeliveryRecord> {
    this.db
      .query(
        `
        UPDATE webhook_deliveries
        SET status = 'failed',
            failed_at = ?,
            error = ?
        WHERE project_id = ?
          AND connector_id = ?
          AND webhook_id = ?
          AND idempotency_key = ?
      `
      )
      .run(
        input.failedAt,
        input.error,
        input.projectId,
        input.connectorId,
        input.webhookId,
        input.idempotencyKey
      )

    return this.requireDeliveryRecord(input, "fail")
  }

  close(): void {
    this.db.close()
  }

  private getDeliveryRecord(key: WebhookDeliveryKey): WebhookDeliveryRecord | null {
    const row = this.db
      .query(
        `
        SELECT
          project_id,
          connector_id,
          webhook_id,
          idempotency_key,
          status,
          received_at,
          completed_at,
          failed_at,
          error
        FROM webhook_deliveries
        WHERE project_id = ?
          AND connector_id = ?
          AND webhook_id = ?
          AND idempotency_key = ?
      `
      )
      .get(
        key.projectId,
        key.connectorId,
        key.webhookId,
        key.idempotencyKey
      ) as SqliteWebhookDeliveryRow | null

    return row ? toWebhookDeliveryRecord(row) : null
  }

  private requireDeliveryRecord(
    key: WebhookDeliveryKey,
    action: "claim" | "complete" | "fail"
  ): WebhookDeliveryRecord {
    const record = this.getDeliveryRecord(key)

    if (!record) {
      throw new Error(
        `[ParioSqlite] Missing webhook delivery row after ${action} for ${serializeKey(key)}.`
      )
    }

    return record
  }
}

interface SqliteWebhookDeliveryRow {
  readonly project_id: string
  readonly connector_id: string
  readonly webhook_id: string
  readonly idempotency_key: string
  readonly status: WebhookDeliveryRecord["status"]
  readonly received_at: string
  readonly completed_at: string | null
  readonly failed_at: string | null
  readonly error: string | null
}

function toWebhookDeliveryRecord(row: SqliteWebhookDeliveryRow): WebhookDeliveryRecord {
  return {
    projectId: row.project_id,
    connectorId: row.connector_id,
    webhookId: row.webhook_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    receivedAt: row.received_at,
    completedAt: row.completed_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    error: row.error ?? undefined,
  }
}

function toWebhookDeliveryClaimRecord(
  record: WebhookDeliveryRecord,
  claimResult: WebhookDeliveryClaimResult
): WebhookDeliveryClaimRecord {
  return {
    ...record,
    claimResult,
  }
}

function serializeKey(key: WebhookDeliveryKey): string {
  return JSON.stringify([key.projectId, key.connectorId, key.webhookId, key.idempotencyKey])
}
