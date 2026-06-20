import type {
  WebhookDeliveryClaimRecord,
  WebhookDeliveryClaimResult,
  WebhookDeliveryKey,
  WebhookDeliveryRecord,
  WebhookDeliveryStorage,
} from "@sixb/core"
import { type PgStoreClient, runPgTransaction } from "./transactions"

export class PgWebhookDeliveryStorage implements WebhookDeliveryStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async claim(
    input: WebhookDeliveryKey & { receivedAt: string }
  ): Promise<WebhookDeliveryClaimRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      // Atomic first claim: only one transaction can insert this scoped delivery key.
      const [inserted] = await tx<WebhookDeliveryRow[]>`
        INSERT INTO webhook_deliveries (
          project_id,
          connector_id,
          webhook_id,
          idempotency_key,
          status,
          received_at
        ) VALUES (
          ${input.projectId},
          ${input.connectorId},
          ${input.webhookId},
          ${input.idempotencyKey},
          ${"in_progress"},
          ${input.receivedAt}
        )
        ON CONFLICT (project_id, connector_id, webhook_id, idempotency_key) DO NOTHING
        RETURNING *
      `

      if (inserted) {
        return toWebhookDeliveryClaimRecord(inserted, "claimed")
      }

      const [existing] = await tx<WebhookDeliveryRow[]>`
        SELECT * FROM webhook_deliveries
        WHERE project_id = ${input.projectId}
          AND connector_id = ${input.connectorId}
          AND webhook_id = ${input.webhookId}
          AND idempotency_key = ${input.idempotencyKey}
        FOR UPDATE
      `

      if (existing?.status === "completed") {
        return toWebhookDeliveryClaimRecord(existing, "duplicate")
      }

      if (existing?.status === "in_progress") {
        return toWebhookDeliveryClaimRecord(existing, "in_progress")
      }

      if (existing?.status !== "failed") {
        throw new Error("[SixbPg] Webhook delivery row disappeared during claim.")
      }

      // Failed deliveries are intentionally claimable so provider retries can run again.
      const [updated] = await tx<WebhookDeliveryRow[]>`
        UPDATE webhook_deliveries
        SET status = ${"in_progress"},
            received_at = ${input.receivedAt},
            completed_at = ${null},
            failed_at = ${null},
            error = ${null}
        WHERE project_id = ${input.projectId}
          AND connector_id = ${input.connectorId}
          AND webhook_id = ${input.webhookId}
          AND idempotency_key = ${input.idempotencyKey}
        RETURNING *
      `

      if (!updated) {
        throw new Error(
          `[SixbPg] Missing webhook delivery row after claim for ${serializeKey(input)}.`
        )
      }

      return toWebhookDeliveryClaimRecord(updated, "claimed")
    })
  }

  async complete(
    input: WebhookDeliveryKey & { completedAt: string }
  ): Promise<WebhookDeliveryRecord> {
    const [updated] = await this.sql<WebhookDeliveryRow[]>`
      UPDATE webhook_deliveries
      SET status = ${"completed"},
          completed_at = ${input.completedAt},
          failed_at = ${null},
          error = ${null}
      WHERE project_id = ${input.projectId}
        AND connector_id = ${input.connectorId}
        AND webhook_id = ${input.webhookId}
        AND idempotency_key = ${input.idempotencyKey}
      RETURNING *
    `

    if (!updated) {
      throw new Error(
        `[SixbPg] Missing webhook delivery row after complete for ${serializeKey(input)}.`
      )
    }

    return toWebhookDeliveryRecord(updated)
  }

  async fail(
    input: WebhookDeliveryKey & { failedAt: string; error: string }
  ): Promise<WebhookDeliveryRecord> {
    const [updated] = await this.sql<WebhookDeliveryRow[]>`
      UPDATE webhook_deliveries
      SET status = ${"failed"},
          failed_at = ${input.failedAt},
          error = ${input.error}
      WHERE project_id = ${input.projectId}
        AND connector_id = ${input.connectorId}
        AND webhook_id = ${input.webhookId}
        AND idempotency_key = ${input.idempotencyKey}
      RETURNING *
    `

    if (!updated) {
      throw new Error(
        `[SixbPg] Missing webhook delivery row after fail for ${serializeKey(input)}.`
      )
    }

    return toWebhookDeliveryRecord(updated)
  }
}

function toWebhookDeliveryClaimRecord(
  row: WebhookDeliveryRow,
  claimResult: WebhookDeliveryClaimResult
): WebhookDeliveryClaimRecord {
  return {
    ...toWebhookDeliveryRecord(row),
    claimResult,
  }
}

function toWebhookDeliveryRecord(row: WebhookDeliveryRow): WebhookDeliveryRecord {
  return {
    projectId: row.project_id,
    connectorId: row.connector_id,
    webhookId: row.webhook_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    receivedAt: toIsoString(row.received_at),
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    failedAt: row.failed_at ? toIsoString(row.failed_at) : undefined,
    error: row.error ?? undefined,
  }
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function serializeKey(key: WebhookDeliveryKey): string {
  return JSON.stringify([key.projectId, key.connectorId, key.webhookId, key.idempotencyKey])
}

interface WebhookDeliveryRow {
  readonly project_id: string
  readonly connector_id: string
  readonly webhook_id: string
  readonly idempotency_key: string
  readonly status: WebhookDeliveryRecord["status"]
  readonly received_at: Date | string
  readonly completed_at: Date | string | null
  readonly failed_at: Date | string | null
  readonly error: string | null
}
