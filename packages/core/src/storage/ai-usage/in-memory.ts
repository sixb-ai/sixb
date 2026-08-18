import type { ExecutionStorage } from "../executions"
import { AiUsageStorageError } from "./errors"
import { assertAiUsageExecutionId, normalizeAiModelCallRecord } from "./record"
import type {
  AiModelCallUsageRecord,
  AiUsageExecutionSummary,
  AiUsageStorage,
  RecordAiModelCallInput,
  RecordAiModelCallResult,
  SummarizeAiUsageExecutionInput,
  SummarizeAiUsageExecutionsInput,
} from "./types"
import { aggregateAiModelCallUsage } from "./usage"

export interface InMemoryAiUsageGroupRow {
  readonly projectId: string
  readonly usageRecordId: string
  readonly groupId: string
  readonly occurredAt: Date
}

export interface InMemoryAiUsageStorageSnapshot {
  readonly records: Map<string, AiModelCallUsageRecord>
  readonly recordKeysByIdempotencyKey: Map<string, string>
  readonly groupRows: Map<string, InMemoryAiUsageGroupRow>
}

/** In-memory model-call ledger used by development runtimes and storage contract tests. */
export class InMemoryAiUsageStorage implements AiUsageStorage {
  private readonly records = new Map<string, AiModelCallUsageRecord>()
  private readonly recordKeysByIdempotencyKey = new Map<string, string>()
  private readonly groupRows = new Map<string, InMemoryAiUsageGroupRow>()

  constructor(private readonly executions: Pick<ExecutionStorage, "getById">) {}

  async recordModelCall(input: RecordAiModelCallInput): Promise<RecordAiModelCallResult> {
    const record = normalizeAiModelCallRecord(input)
    await this.assertExecutionExists(record.projectId, record.executionId)
    const idempotencyKey = modelCallIdempotencyKey(record)
    const existingRecordKey = this.recordKeysByIdempotencyKey.get(idempotencyKey)
    if (existingRecordKey !== undefined) {
      const existing = this.records.get(existingRecordKey)
      if (!existing) {
        throw new Error("[Sixb] In-memory AI usage idempotency index is inconsistent.")
      }
      return { record: structuredClone(existing), created: false }
    }

    const recordKey = modelCallRecordKey(record.projectId, record.id)
    if (this.records.has(recordKey)) {
      throw new AiUsageStorageError(
        "duplicate_id",
        `[Sixb] AI usage record '${record.id}' already exists for project '${record.projectId}'.`
      )
    }

    this.records.set(recordKey, structuredClone(record))
    this.recordKeysByIdempotencyKey.set(idempotencyKey, recordKey)
    for (const groupId of record.requesterGroupIds) {
      const row: InMemoryAiUsageGroupRow = {
        projectId: record.projectId,
        usageRecordId: record.id,
        groupId,
        occurredAt: record.occurredAt,
      }
      this.groupRows.set(groupRowKey(row), row)
    }

    return { record: structuredClone(record), created: true }
  }

  async summarizeExecution(
    input: SummarizeAiUsageExecutionInput
  ): Promise<AiUsageExecutionSummary> {
    const [summary] = await this.summarizeExecutions({
      projectId: input.projectId,
      executionIds: [input.executionId],
    })
    return summary!
  }

  async summarizeExecutions(
    input: SummarizeAiUsageExecutionsInput
  ): Promise<readonly AiUsageExecutionSummary[]> {
    if (typeof input.projectId !== "string" || input.projectId.trim().length === 0) {
      throw new TypeError("[Sixb] AI usage projectId must be nonblank.")
    }

    const usageByExecutionId = new Map<string, AiModelCallUsageRecord["usage"][]>()
    for (const executionId of input.executionIds) {
      assertAiUsageExecutionId(executionId)
      usageByExecutionId.set(executionId, [])
    }
    if (usageByExecutionId.size === 0) return []

    for (const record of this.records.values()) {
      if (record.projectId !== input.projectId) continue
      usageByExecutionId.get(record.executionId)?.push(record.usage)
    }

    return input.executionIds.map((executionId) => {
      const usages = usageByExecutionId.get(executionId) ?? []
      return {
        modelCallCount: usages.length,
        usage: aggregateAiModelCallUsage(usages),
      }
    })
  }

  snapshot(): InMemoryAiUsageStorageSnapshot {
    return structuredClone({
      records: this.records,
      recordKeysByIdempotencyKey: this.recordKeysByIdempotencyKey,
      groupRows: this.groupRows,
    })
  }

  restore(snapshot: InMemoryAiUsageStorageSnapshot): void {
    replaceMap(this.records, snapshot.records)
    replaceMap(this.recordKeysByIdempotencyKey, snapshot.recordKeysByIdempotencyKey)
    replaceMap(this.groupRows, snapshot.groupRows)
  }

  private async assertExecutionExists(projectId: string, executionId: string): Promise<void> {
    const execution = await this.executions.getById({ projectId, id: executionId })
    if (execution) return
    throw new AiUsageStorageError(
      "missing_execution",
      `[Sixb] AI usage execution '${executionId}' does not exist in project '${projectId}'.`
    )
  }
}

function modelCallRecordKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function modelCallIdempotencyKey(
  record: Pick<
    AiModelCallUsageRecord,
    "projectId" | "executionId" | "attempt" | "callId" | "responseId"
  >
): string {
  return JSON.stringify([
    record.projectId,
    record.executionId,
    record.attempt,
    record.callId,
    record.responseId,
  ])
}

function groupRowKey(row: InMemoryAiUsageGroupRow): string {
  return JSON.stringify([row.projectId, row.usageRecordId, row.groupId])
}

function replaceMap<TKey, TValue>(target: Map<TKey, TValue>, source: Map<TKey, TValue>): void {
  target.clear()
  for (const [key, value] of structuredClone(source)) {
    target.set(key, value)
  }
}
