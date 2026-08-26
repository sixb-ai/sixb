import type { AiModelCallUsageRecord, InMemoryAiUsageStorageSnapshot } from "../ai-usage"
import type { AiAccountingRecordSetItem } from "./analytics"
import { buildAiAccountingOverview, buildAiModelCallAccountingList } from "./analytics"
import { AiCostStorageError } from "./errors"
import type {
  AiAccountingAttribution,
  AiAccountingOverview,
  AiCostStorage,
  AiCostSummary,
  AiModelCallCostRecord,
  AiMoney,
  ListAiModelCallAccountingInput,
  ListAiModelCallAccountingResult,
  QueryAiAccountingOverviewInput,
  SummarizeAiCostExecutionsInput,
} from "./types"
import { aiModelCallCostMatchesUsage, normalizeAiModelCallCostRecord } from "./validation"

export interface InMemoryAiCostStorageSnapshot {
  readonly recordsByUsage: Map<string, AiModelCallCostRecord>
}

interface InMemoryAiCostUsageSource {
  snapshot(): InMemoryAiUsageStorageSnapshot
}

export interface InMemoryAiAccountingAttributionSource {
  resolve(input: {
    readonly projectId: string
    readonly executionId: string
  }): Promise<AiAccountingAttribution | undefined>
}

/** In-memory immutable model-call costs and accounting reads. */
export class InMemoryAiCostStorage implements AiCostStorage {
  private readonly recordsByUsage = new Map<string, AiModelCallCostRecord>()

  constructor(
    private readonly usage: InMemoryAiCostUsageSource,
    private readonly attribution?: InMemoryAiAccountingAttributionSource
  ) {}

  async recordModelCallCost(input: AiModelCallCostRecord): Promise<void> {
    const record = normalizeAiModelCallCostRecord(input)
    const usage = this.usageRecord(record.projectId, record.usageRecordId)
    if (!usage) throw missingUsage(record)
    if (!aiModelCallCostMatchesUsage(record, usage)) {
      throw new AiCostStorageError(
        "cost_mismatch",
        `[Sixb] AI valuation for usage '${record.usageRecordId}' does not match its usage record.`
      )
    }
    const key = usageRecordKey(record.projectId, record.usageRecordId)
    if (!this.recordsByUsage.has(key)) this.recordsByUsage.set(key, structuredClone(record))
  }

  async summarizeExecutions(
    input: SummarizeAiCostExecutionsInput
  ): Promise<readonly AiCostSummary[]> {
    assertNonBlank(input.projectId, "cost summary projectId")
    for (const id of input.executionIds) assertNonBlank(id, "cost summary executionId")
    const requested = new Set(input.executionIds)
    const usageByExecution = new Map(input.executionIds.map((id) => [id, [] as string[]]))
    for (const usage of this.usage.snapshot().records.values()) {
      if (usage.projectId === input.projectId && requested.has(usage.executionId)) {
        usageByExecution.get(usage.executionId)!.push(usage.id)
      }
    }
    return input.executionIds.map((id) =>
      this.summarizeUsageIds(input.projectId, usageByExecution.get(id) ?? [])
    )
  }

  async queryProjectOverview(input: QueryAiAccountingOverviewInput): Promise<AiAccountingOverview> {
    return buildAiAccountingOverview(input, await this.accountingItems())
  }

  async listModelCalls(
    input: ListAiModelCallAccountingInput
  ): Promise<ListAiModelCallAccountingResult> {
    return buildAiModelCallAccountingList(input, await this.accountingItems())
  }

  snapshot(): InMemoryAiCostStorageSnapshot {
    return structuredClone({ recordsByUsage: this.recordsByUsage })
  }

  restore(snapshot: InMemoryAiCostStorageSnapshot): void {
    replaceMap(this.recordsByUsage, snapshot.recordsByUsage)
  }

  private usageRecord(projectId: string, id: string): AiModelCallUsageRecord | undefined {
    return [...this.usage.snapshot().records.values()].find(
      (record) => record.projectId === projectId && record.id === id
    )
  }

  private async accountingItems(): Promise<readonly AiAccountingRecordSetItem[]> {
    return Promise.all(
      [...this.usage.snapshot().records.values()].map(async (usage) => {
        const cost = this.recordsByUsage.get(usageRecordKey(usage.projectId, usage.id))
        const attribution = await this.attribution?.resolve({
          projectId: usage.projectId,
          executionId: usage.executionId,
        })
        return {
          usage,
          ...(attribution ? { attribution } : {}),
          ...(cost ? { cost } : {}),
        }
      })
    )
  }

  private summarizeUsageIds(projectId: string, ids: readonly string[]): AiCostSummary {
    const amounts = new Map<string, bigint>()
    let ratedCallCount = 0
    let unpriceableCallCount = 0
    let unvaluedCallCount = 0
    for (const id of ids) {
      const cost = this.recordsByUsage.get(usageRecordKey(projectId, id))
      if (!cost) unvaluedCallCount += 1
      else if (cost.status === "unpriceable") unpriceableCallCount += 1
      else {
        ratedCallCount += 1
        addMoney(amounts, cost.money)
      }
    }
    return {
      amounts: [...amounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amount]) => ({ currency, amountNanos: amount.toString() })),
      ratedCallCount,
      unpriceableCallCount,
      unvaluedCallCount,
    }
  }
}

function missingUsage(record: { readonly projectId: string; readonly usageRecordId: string }) {
  return new AiCostStorageError(
    "missing_usage",
    `[Sixb] AI usage '${record.usageRecordId}' does not exist in project '${record.projectId}'.`
  )
}

function addMoney(amounts: Map<string, bigint>, money: AiMoney): void {
  amounts.set(money.currency, (amounts.get(money.currency) ?? 0n) + BigInt(money.amountNanos))
}

function usageRecordKey(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`[Sixb] AI ${field} must be nonblank.`)
  }
}

function replaceMap<TKey, TValue>(target: Map<TKey, TValue>, source: Map<TKey, TValue>): void {
  target.clear()
  for (const [key, value] of structuredClone(source)) target.set(key, value)
}
