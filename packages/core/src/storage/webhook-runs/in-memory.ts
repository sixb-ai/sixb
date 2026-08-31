import { parseSixbFailure } from "../../errors/internal"
import type { ExecutionStorage } from "../executions"
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
import { assertWebhookRunExecution } from "./provider"
import type {
  FinishWebhookRunInput,
  ListWebhookRunsInput,
  ListWebhookRunsResult,
  RestartWebhookRunInput,
  StartWebhookRunInput,
  WebhookRunRecord,
  WebhookRunStorage,
} from "./types"
import { canRetryWebhookRun, WEBHOOK_RUN_FAILURE_CODES } from "./types"

export class InMemoryWebhookRunStorage implements WebhookRunStorage {
  private readonly runs = new Map<string, WebhookRunRecord>()

  constructor(private readonly executions: ExecutionStorage) {}

  snapshot(): InMemoryWebhookRunStorageSnapshot {
    return structuredClone(this.runs)
  }

  restore(snapshot: InMemoryWebhookRunStorageSnapshot): void {
    this.runs.clear()
    for (const [key, record] of structuredClone(snapshot)) {
      this.runs.set(key, record)
    }
  }

  async start(input: StartWebhookRunInput): Promise<WebhookRunRecord> {
    await assertWebhookRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      route: input.route,
    })
    const key = storageKey(input.projectId, input.id)
    if (this.runs.has(key) || this.findByDelivery(input)) {
      throw new WebhookRunError(
        `[Sixb] Webhook run '${input.id}' or delivery key already exists for project '${input.projectId}'.`,
        "duplicate_run"
      )
    }

    const record: WebhookRunRecord = {
      id: input.id,
      projectId: input.projectId,
      executionId: input.executionId,
      connectorId: input.connectorId,
      webhookId: input.webhookId,
      status: "running",
      method: input.method,
      route: input.route,
      startedAt: new Date(input.startedAt ?? new Date()),
      requestBodyBytes: input.requestBodyBytes,
      requestBodySha256: input.requestBodySha256,
      idempotencyKey: input.idempotencyKey,
    }

    this.runs.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async restart(input: RestartWebhookRunInput): Promise<WebhookRunRecord> {
    const existing = this.requireWebhookRun(input.projectId, input.id)
    if (!canRetryWebhookRun(existing)) {
      throw new WebhookRunError(
        `[Sixb] Webhook run '${input.id}' cannot restart from status '${existing.status}'.`,
        "invalid_transition"
      )
    }
    const next: WebhookRunRecord = {
      ...existing,
      status: "running",
      startedAt: new Date(input.startedAt ?? new Date()),
      finishedAt: undefined,
      responseStatus: undefined,
      error: undefined,
    }
    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async finish(input: FinishWebhookRunInput): Promise<WebhookRunRecord> {
    const existing = this.requireRunningWebhookRun(input.projectId, input.id)
    const next: WebhookRunRecord = {
      ...existing,
      status: input.status,
      finishedAt: new Date(input.finishedAt ?? new Date()),
      responseStatus: input.responseStatus,
      error:
        input.status === "failed"
          ? parseSixbFailure(input.error, WEBHOOK_RUN_FAILURE_CODES)
          : undefined,
    }

    this.runs.set(storageKey(input.projectId, input.id), cloneRecord(next))
    return cloneRecord(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<WebhookRunRecord | null> {
    const record = this.runs.get(storageKey(params.projectId, params.id))
    return record ? cloneRecord(record) : null
  }

  async getByDelivery(input: {
    projectId: string
    connectorId: string
    webhookId: string
    idempotencyKey: string
  }): Promise<WebhookRunRecord | null> {
    const record = this.findByDelivery(input)
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

  private requireWebhookRun(projectId: string, id: string): WebhookRunRecord {
    const record = this.runs.get(storageKey(projectId, id))
    if (!record) {
      throw new WebhookRunError(
        `[Sixb] Webhook run '${id}' not found for project '${projectId}'.`,
        "not_found"
      )
    }

    return record
  }

  private requireRunningWebhookRun(projectId: string, id: string): WebhookRunRecord {
    const record = this.requireWebhookRun(projectId, id)

    if (record.status !== "running") {
      throw new WebhookRunError(
        `[Sixb] Webhook run '${id}' for project '${projectId}' is already terminal.`,
        "invalid_transition"
      )
    }

    return record
  }

  private findByDelivery(input: {
    readonly projectId: string
    readonly connectorId: string
    readonly webhookId: string
    readonly idempotencyKey?: string
  }): WebhookRunRecord | undefined {
    if (input.idempotencyKey === undefined) return undefined
    return [...this.runs.values()].find(
      (run) =>
        run.projectId === input.projectId &&
        run.connectorId === input.connectorId &&
        run.webhookId === input.webhookId &&
        run.idempotencyKey === input.idempotencyKey
    )
  }
}

export type InMemoryWebhookRunStorageSnapshot = Map<string, WebhookRunRecord>
