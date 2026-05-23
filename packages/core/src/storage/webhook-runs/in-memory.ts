import {
  cloneRecord,
  compareStartedAt,
  hasEmptyStatuses,
  matchesRunListDateFilters,
  paginate,
  storageKey,
  toStatusSet,
} from "../run-listing"
import { WebhookRunError } from "./errors"
import type {
  FinishWebhookRunInput,
  ListWebhookRunsInput,
  ListWebhookRunsResult,
  StartWebhookRunInput,
  WebhookRunRecord,
  WebhookRunStorage,
} from "./types"

export class InMemoryWebhookRunStorage implements WebhookRunStorage {
  private readonly runs = new Map<string, WebhookRunRecord>()

  async start(input: StartWebhookRunInput): Promise<WebhookRunRecord> {
    const key = storageKey(input.projectId, input.id)
    if (this.runs.has(key)) {
      throw new WebhookRunError(
        `[Sixb] Webhook run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const record: WebhookRunRecord = {
      id: input.id,
      projectId: input.projectId,
      connectorId: input.connectorId,
      webhookId: input.webhookId,
      status: "running",
      method: input.method,
      route: input.route,
      startedAt: new Date(input.startedAt ?? new Date()),
    }

    this.runs.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async finish(input: FinishWebhookRunInput): Promise<WebhookRunRecord> {
    const existing = this.requireRunningWebhookRun(input.projectId, input.id)
    const next: WebhookRunRecord = {
      ...existing,
      status: input.status,
      finishedAt: new Date(input.finishedAt ?? new Date()),
      requestBodyBytes: input.requestBodyBytes,
      responseStatus: input.responseStatus,
      idempotencyKey: input.idempotencyKey,
      deliveryClaimResult: input.deliveryClaimResult,
      error: input.status === "succeeded" ? undefined : input.error,
    }

    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<WebhookRunRecord | null> {
    const record = this.runs.get(storageKey(params.projectId, params.id))
    return record ? cloneRecord(record) : null
  }

  async list(input: ListWebhookRunsInput): Promise<ListWebhookRunsResult> {
    if (hasEmptyStatuses(input)) {
      return {
        runs: [],
        hasMore: false,
        total: 0,
      }
    }

    const order = input.order ?? "desc"
    const statuses = toStatusSet(input.statuses)
    const filtered = [...this.runs.values()]
      .filter((record) => record.projectId === input.projectId)
      .filter((record) => (input.connectorId ? record.connectorId === input.connectorId : true))
      .filter((record) => (input.webhookId ? record.webhookId === input.webhookId : true))
      .filter((record) =>
        input.idempotencyKey ? record.idempotencyKey === input.idempotencyKey : true
      )
      .filter((record) =>
        matchesRunListDateFilters(record, {
          statuses,
          startedAfter: input.startedAfter,
          startedBefore: input.startedBefore,
        })
      )
      .sort((left, right) => compareStartedAt(left, right, order))

    const { page, total, hasMore } = paginate(filtered, input)

    return {
      runs: page.map(cloneRecord),
      hasMore,
      total,
    }
  }

  private requireRunningWebhookRun(projectId: string, id: string): WebhookRunRecord {
    const record = this.runs.get(storageKey(projectId, id))
    if (!record) {
      throw new WebhookRunError(`[Sixb] Webhook run '${id}' not found for project '${projectId}'.`)
    }

    if (record.status !== "running") {
      throw new WebhookRunError(
        `[Sixb] Webhook run '${id}' for project '${projectId}' is already terminal.`
      )
    }

    return record
  }
}
