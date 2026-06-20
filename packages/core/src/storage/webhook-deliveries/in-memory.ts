import type {
  WebhookDeliveryClaimRecord,
  WebhookDeliveryKey,
  WebhookDeliveryRecord,
  WebhookDeliveryStorage,
} from "./types"

function cloneDeliveryRecord(record: WebhookDeliveryRecord): WebhookDeliveryRecord {
  return structuredClone(record)
}

export class InMemoryWebhookDeliveryStorage implements WebhookDeliveryStorage {
  private readonly deliveries = new Map<string, WebhookDeliveryRecord>()

  snapshot(): InMemoryWebhookDeliveryStorageSnapshot {
    return structuredClone(this.deliveries)
  }

  restore(snapshot: InMemoryWebhookDeliveryStorageSnapshot): void {
    this.deliveries.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.deliveries.set(key, record)
    }
  }

  async claim(
    input: WebhookDeliveryKey & { receivedAt: string }
  ): Promise<WebhookDeliveryClaimRecord> {
    const key = serializeKey(input)
    const existing = this.deliveries.get(key)

    if (existing?.status === "completed") {
      return {
        ...cloneDeliveryRecord(existing),
        claimResult: "duplicate",
      }
    }

    if (existing?.status === "in_progress") {
      return {
        ...cloneDeliveryRecord(existing),
        claimResult: "in_progress",
      }
    }

    // New and failed deliveries both get a fresh handler attempt.
    const next: WebhookDeliveryRecord = {
      projectId: input.projectId,
      connectorId: input.connectorId,
      webhookId: input.webhookId,
      idempotencyKey: input.idempotencyKey,
      status: "in_progress",
      receivedAt: input.receivedAt,
    }
    this.deliveries.set(key, structuredClone(next))

    return {
      ...cloneDeliveryRecord(next),
      claimResult: "claimed",
    }
  }

  async complete(
    input: WebhookDeliveryKey & { completedAt: string }
  ): Promise<WebhookDeliveryRecord> {
    const key = serializeKey(input)
    const next: WebhookDeliveryRecord = {
      projectId: input.projectId,
      connectorId: input.connectorId,
      webhookId: input.webhookId,
      idempotencyKey: input.idempotencyKey,
      ...this.deliveries.get(key),
      status: "completed",
      completedAt: input.completedAt,
      failedAt: undefined,
      error: undefined,
    }

    this.deliveries.set(key, structuredClone(next))
    return cloneDeliveryRecord(next)
  }

  async fail(
    input: WebhookDeliveryKey & { failedAt: string; error: string }
  ): Promise<WebhookDeliveryRecord> {
    const key = serializeKey(input)
    const next: WebhookDeliveryRecord = {
      projectId: input.projectId,
      connectorId: input.connectorId,
      webhookId: input.webhookId,
      idempotencyKey: input.idempotencyKey,
      ...this.deliveries.get(key),
      status: "failed",
      failedAt: input.failedAt,
      error: input.error,
      completedAt: undefined,
    }

    this.deliveries.set(key, structuredClone(next))
    return cloneDeliveryRecord(next)
  }
}

export type InMemoryWebhookDeliveryStorageSnapshot = Map<string, WebhookDeliveryRecord>

function serializeKey(key: WebhookDeliveryKey): string {
  return JSON.stringify([key.projectId, key.connectorId, key.webhookId, key.idempotencyKey])
}
