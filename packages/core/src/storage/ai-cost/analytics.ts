import {
  type AiModelCallUsage,
  type AiModelCallUsageRecord,
  aggregateAiModelCallUsage,
  normalizeAiModelCallUsage,
} from "../ai-usage"
import type {
  AiAccountingAgentBreakdown,
  AiAccountingAggregate,
  AiAccountingAttribution,
  AiAccountingBucket,
  AiAccountingModelBreakdown,
  AiAccountingOverview,
  AiAccountingTimeBucket,
  AiAccountingWorkflowBreakdown,
  AiCostSummary,
  AiModelCallAccountingItem,
  AiModelCallCostRecord,
  AiMoney,
  ListAiModelCallAccountingInput,
  ListAiModelCallAccountingResult,
  QueryAiAccountingOverviewInput,
} from "./types"

const DEFAULT_MODEL_CALL_PAGE_SIZE = 50
const MAX_MODEL_CALL_PAGE_SIZE = 200
const MAX_CHART_BUCKETS = 10_000

/** One joined immutable model-call row used by in-memory analytics and bounded SQL pages. */
export interface AiAccountingRecordSetItem {
  readonly usage: AiModelCallUsageRecord
  readonly attribution?: AiAccountingAttribution
  readonly cost?: AiModelCallCostRecord
}

export interface NormalizedAiAccountingQuery {
  readonly projectId: string
  readonly from: Date
  readonly to: Date
  readonly providerId?: string
  readonly modelId?: string
}

export interface NormalizedAiModelCallAccountingQuery extends NormalizedAiAccountingQuery {
  readonly executionId?: string
  readonly valuationStatus?: ListAiModelCallAccountingInput["valuationStatus"]
  readonly limit: number
  readonly offset: number
}

interface AiAccountingUsageMeterFragment {
  readonly presentCallCount: string
  readonly total: string | null
}

/** One SQL-aggregated currency fragment; providers merge fragments without loading model calls. */
export interface AiAccountingAggregateFragment {
  readonly dimension: "totals" | "series" | "model" | "agent" | "workflow"
  readonly start?: Date
  readonly providerId?: string
  readonly modelId?: string
  readonly agentId?: string
  readonly workflowId?: string
  readonly modelCallCount: string
  readonly usage: {
    readonly reportedCallCount: string
    readonly inputTokens: AiAccountingUsageMeterFragment
    readonly outputTokens: AiAccountingUsageMeterFragment
    readonly uncachedInputTokens: AiAccountingUsageMeterFragment
    readonly cacheReadInputTokens: AiAccountingUsageMeterFragment
    readonly cacheWriteInputTokens: AiAccountingUsageMeterFragment
    readonly textOutputTokens: AiAccountingUsageMeterFragment
    readonly reasoningOutputTokens: AiAccountingUsageMeterFragment
  }
  readonly costs: {
    readonly amount?: AiMoney
    readonly ratedCallCount: string
    readonly unpriceableCallCount: string
    readonly unvaluedCallCount: string
  }
}

export function normalizeAiAccountingQuery(
  input: Omit<QueryAiAccountingOverviewInput, "bucket"> | ListAiModelCallAccountingInput
): NormalizedAiAccountingQuery {
  assertNonBlank(input.projectId, "accounting projectId")
  assertDate(input.from, "accounting from")
  assertDate(input.to, "accounting to")
  if (input.from.getTime() >= input.to.getTime()) {
    throw new TypeError("[Sixb] AI accounting from must be before to.")
  }
  if (input.providerId !== undefined) assertNonBlank(input.providerId, "accounting providerId")
  if (input.modelId !== undefined) assertNonBlank(input.modelId, "accounting modelId")
  return {
    projectId: input.projectId,
    from: new Date(input.from),
    to: new Date(input.to),
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
  }
}

export function normalizeAiModelCallAccountingQuery(
  input: ListAiModelCallAccountingInput
): NormalizedAiModelCallAccountingQuery {
  const query = normalizeAiAccountingQuery(input)
  if (input.executionId !== undefined) {
    assertNonBlank(input.executionId, "accounting executionId")
  }
  const { limit, offset } = normalizePage(input.limit, input.offset)
  return {
    ...query,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    ...(input.valuationStatus === undefined ? {} : { valuationStatus: input.valuationStatus }),
    limit,
    offset,
  }
}

export function aiAccountingItemMatchesQuery(
  item: AiAccountingRecordSetItem,
  query: NormalizedAiAccountingQuery
): boolean {
  const occurredAt = item.usage.occurredAt.getTime()
  return (
    item.usage.projectId === query.projectId &&
    occurredAt >= query.from.getTime() &&
    occurredAt < query.to.getTime() &&
    (query.providerId === undefined || item.usage.providerId === query.providerId) &&
    (query.modelId === undefined || item.usage.requestedModelId === query.modelId)
  )
}

export function buildAiAccountingOverview(
  input: QueryAiAccountingOverviewInput,
  source: Iterable<AiAccountingRecordSetItem>
): AiAccountingOverview {
  const query = normalizeAiAccountingQuery(input)
  assertAiAccountingBucket(input.bucket)
  const items = Array.from(source).filter((item) => aiAccountingItemMatchesQuery(item, query))
  const periods = accountingPeriods(query.from, query.to, input.bucket)
  const periodItems = new Map<number, AiAccountingRecordSetItem[]>(
    periods.map((period) => [period.start.getTime(), []])
  )
  const modelItems = new Map<string, AiAccountingRecordSetItem[]>()
  const agentItems = new Map<string, AiAccountingRecordSetItem[]>()
  const workflowItems = new Map<string, AiAccountingRecordSetItem[]>()

  for (const item of items) {
    const periodStart = aiAccountingBucketStart(item.usage.occurredAt, input.bucket).getTime()
    periodItems.get(periodStart)?.push(item)
    appendGrouped(
      modelItems,
      JSON.stringify([item.usage.providerId, item.usage.requestedModelId]),
      item
    )
    if (item.attribution?.kind === "agent" || item.attribution?.kind === "workflowAgent") {
      appendGrouped(agentItems, item.attribution.agentId, item)
    }
    if (item.attribution?.kind === "workflowAgent") {
      appendGrouped(workflowItems, item.attribution.workflowId, item)
    }
  }

  const series: AiAccountingTimeBucket[] = periods.map((period) => ({
    ...period,
    ...aggregateAccountingItems(periodItems.get(period.start.getTime()) ?? []),
  }))
  const models: AiAccountingModelBreakdown[] = [...modelItems]
    .map(([key, grouped]) => {
      const [providerId, modelId] = JSON.parse(key) as [string, string]
      return { providerId, modelId, ...aggregateAccountingItems(grouped) }
    })
    .sort(compareModelBreakdowns)
  const agents: AiAccountingAgentBreakdown[] = [...agentItems]
    .map(([agentId, grouped]) => ({ agentId, ...aggregateAccountingItems(grouped) }))
    .sort(compareAgentBreakdowns)
  const workflows: AiAccountingWorkflowBreakdown[] = [...workflowItems]
    .map(([workflowId, grouped]) => ({ workflowId, ...aggregateAccountingItems(grouped) }))
    .sort(compareWorkflowBreakdowns)

  return structuredClone({
    range: { from: query.from, to: query.to },
    bucket: input.bucket,
    totals: aggregateAccountingItems(items),
    series,
    models,
    agents,
    workflows,
  })
}

export function buildAiAccountingOverviewFromFragments(
  input: QueryAiAccountingOverviewInput,
  fragments: Iterable<AiAccountingAggregateFragment>
): AiAccountingOverview {
  const query = normalizeAiAccountingQuery(input)
  const periods = accountingPeriods(query.from, query.to, input.bucket)
  const totals = aggregateFragmentAccumulator()
  const series = new Map<number, AggregateFragmentAccumulator>(
    periods.map((period) => [period.start.getTime(), aggregateFragmentAccumulator()])
  )
  const models = new Map<string, AggregateFragmentAccumulator>()
  const agents = new Map<string, AggregateFragmentAccumulator>()
  const workflows = new Map<string, AggregateFragmentAccumulator>()

  for (const fragment of fragments) {
    let target: AggregateFragmentAccumulator
    switch (fragment.dimension) {
      case "totals":
        target = totals
        break
      case "series": {
        const start = requiredFragmentDate(fragment.start, "series start")
        const existing = series.get(start.getTime())
        if (!existing) {
          throw new TypeError("[Sixb] AI accounting SQL series returned an unexpected bucket.")
        }
        target = existing
        break
      }
      case "model":
        target = getFragmentAccumulator(
          models,
          JSON.stringify([
            requiredFragmentString(fragment.providerId, "providerId"),
            requiredFragmentString(fragment.modelId, "modelId"),
          ])
        )
        break
      case "agent":
        target = getFragmentAccumulator(agents, requiredFragmentString(fragment.agentId, "agentId"))
        break
      case "workflow":
        target = getFragmentAccumulator(
          workflows,
          requiredFragmentString(fragment.workflowId, "workflowId")
        )
        break
    }
    appendAggregateFragment(target, fragment)
  }

  return structuredClone({
    range: { from: query.from, to: query.to },
    bucket: input.bucket,
    totals: finishAggregateFragment(totals),
    series: periods.map((period) => ({
      ...period,
      ...finishAggregateFragment(series.get(period.start.getTime())!),
    })),
    models: [...models]
      .map(([key, value]) => {
        const [providerId, modelId] = JSON.parse(key) as [string, string]
        return { providerId, modelId, ...finishAggregateFragment(value) }
      })
      .sort(compareModelBreakdowns),
    agents: [...agents]
      .map(([agentId, value]) => ({ agentId, ...finishAggregateFragment(value) }))
      .sort(compareAgentBreakdowns),
    workflows: [...workflows]
      .map(([workflowId, value]) => ({ workflowId, ...finishAggregateFragment(value) }))
      .sort(compareWorkflowBreakdowns),
  })
}

export function buildAiModelCallAccountingList(
  input: ListAiModelCallAccountingInput,
  source: Iterable<AiAccountingRecordSetItem>
): ListAiModelCallAccountingResult {
  const query = normalizeAiModelCallAccountingQuery(input)
  const { limit, offset } = query
  const items = Array.from(source)
    .filter((item) => aiAccountingItemMatchesQuery(item, query))
    .map(toAccountingItem)
    .filter(
      (item) =>
        (input.executionId === undefined || item.usage.executionId === input.executionId) &&
        (input.valuationStatus === undefined || item.valuationStatus === input.valuationStatus)
    )
    .sort(compareAccountingItems)
  const page = items.slice(offset, offset + limit)
  return structuredClone({
    items: page,
    hasMore: offset + page.length < items.length,
    total: items.length,
  })
}

export function toAccountingItem(item: AiAccountingRecordSetItem): AiModelCallAccountingItem {
  return {
    usage: item.usage,
    ...(item.attribution === undefined ? {} : { attribution: item.attribution }),
    ...(item.cost === undefined ? {} : { cost: item.cost }),
    valuationStatus: item.cost?.status ?? "unvalued",
  }
}

export function aiAccountingBucketStart(at: Date, bucket: AiAccountingBucket): Date {
  assertDate(at, "accounting bucket timestamp")
  assertAiAccountingBucket(bucket)
  const start = new Date(at)
  start.setUTCMinutes(0, 0, 0)
  if (bucket === "hour") return start
  start.setUTCHours(0)
  if (bucket === "day") return start
  const mondayOffset = (start.getUTCDay() + 6) % 7
  start.setUTCDate(start.getUTCDate() - mondayOffset)
  return start
}

function aggregateAccountingItems(
  items: readonly AiAccountingRecordSetItem[]
): AiAccountingAggregate {
  return {
    modelCallCount: items.length,
    usage: aggregateAiModelCallUsage(items.map((item) => item.usage.usage)),
    costs: aggregateCosts(items),
  }
}

function aggregateCosts(items: readonly AiAccountingRecordSetItem[]): AiCostSummary {
  const amounts = new Map<string, bigint>()
  let ratedCallCount = 0
  let unpriceableCallCount = 0
  let unvaluedCallCount = 0
  for (const item of items) {
    if (item.cost?.status === "rated") {
      ratedCallCount += 1
      addAmount(amounts, item.cost.money.currency, item.cost.money.amountNanos)
    } else if (item.cost?.status === "unpriceable") {
      unpriceableCallCount += 1
    } else {
      unvaluedCallCount += 1
    }
  }
  return {
    amounts: [...amounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amountNanos]) => ({ currency, amountNanos: amountNanos.toString() })),
    ratedCallCount,
    unpriceableCallCount,
    unvaluedCallCount,
  }
}

const AGGREGATE_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "uncachedInputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "textOutputTokens",
  "reasoningOutputTokens",
] as const

type AggregateUsageField = (typeof AGGREGATE_USAGE_FIELDS)[number]

interface AggregateFragmentAccumulator {
  modelCallCount: bigint
  reportedUsageCallCount: bigint
  usage: Record<AggregateUsageField, { presentCallCount: bigint; total: bigint }>
  amounts: Map<string, bigint>
  ratedCallCount: bigint
  unpriceableCallCount: bigint
  unvaluedCallCount: bigint
}

function aggregateFragmentAccumulator(): AggregateFragmentAccumulator {
  return {
    modelCallCount: 0n,
    reportedUsageCallCount: 0n,
    usage: Object.fromEntries(
      AGGREGATE_USAGE_FIELDS.map((field) => [field, { presentCallCount: 0n, total: 0n }])
    ) as AggregateFragmentAccumulator["usage"],
    amounts: new Map(),
    ratedCallCount: 0n,
    unpriceableCallCount: 0n,
    unvaluedCallCount: 0n,
  }
}

function getFragmentAccumulator(
  values: Map<string, AggregateFragmentAccumulator>,
  key: string
): AggregateFragmentAccumulator {
  const existing = values.get(key)
  if (existing) return existing
  const created = aggregateFragmentAccumulator()
  values.set(key, created)
  return created
}

function appendAggregateFragment(
  target: AggregateFragmentAccumulator,
  fragment: AiAccountingAggregateFragment
): void {
  target.modelCallCount += naturalBigInt(fragment.modelCallCount, "modelCallCount")
  target.reportedUsageCallCount += naturalBigInt(
    fragment.usage.reportedCallCount,
    "reported usage call count"
  )
  for (const field of AGGREGATE_USAGE_FIELDS) {
    const source = fragment.usage[field]
    const presentCallCount = naturalBigInt(source.presentCallCount, `${field} call count`)
    target.usage[field].presentCallCount += presentCallCount
    if (source.total !== null) {
      target.usage[field].total += naturalBigInt(source.total, `${field} total`)
    } else if (presentCallCount !== 0n) {
      throw new TypeError(`[Sixb] AI accounting SQL ${field} total is missing.`)
    }
  }
  target.ratedCallCount += naturalBigInt(fragment.costs.ratedCallCount, "rated call count")
  target.unpriceableCallCount += naturalBigInt(
    fragment.costs.unpriceableCallCount,
    "unpriceable call count"
  )
  target.unvaluedCallCount += naturalBigInt(fragment.costs.unvaluedCallCount, "unvalued call count")
  if (fragment.costs.amount) {
    addAmount(target.amounts, fragment.costs.amount.currency, fragment.costs.amount.amountNanos)
  }
}

function finishAggregateFragment(value: AggregateFragmentAccumulator): AiAccountingAggregate {
  const classifiedCallCount =
    value.ratedCallCount + value.unpriceableCallCount + value.unvaluedCallCount
  if (
    classifiedCallCount !== value.modelCallCount ||
    value.reportedUsageCallCount > value.modelCallCount ||
    AGGREGATE_USAGE_FIELDS.some(
      (field) => value.usage[field].presentCallCount > value.modelCallCount
    )
  ) {
    throw new TypeError("[Sixb] AI accounting SQL aggregate counts are inconsistent.")
  }
  const modelCallCount = safeAggregateNumber(value.modelCallCount, "model-call count")
  const usageInput: Partial<Record<AggregateUsageField, number>> = {}
  if (value.modelCallCount > 0n) {
    for (const field of AGGREGATE_USAGE_FIELDS) {
      const aggregate = value.usage[field]
      if (aggregate.presentCallCount === value.modelCallCount) {
        usageInput[field] = safeAggregateNumber(aggregate.total, field)
      }
    }
  }
  let usage: AiModelCallUsage = normalizeAiModelCallUsage(usageInput)
  if (usage.reportingStatus === "unavailable" && value.reportedUsageCallCount > 0n) {
    usage = { ...usage, reportingStatus: "partial" }
  }
  return {
    modelCallCount,
    usage,
    costs: {
      amounts: [...value.amounts]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amountNanos]) => ({ currency, amountNanos: amountNanos.toString() })),
      ratedCallCount: safeAggregateNumber(value.ratedCallCount, "rated call count"),
      unpriceableCallCount: safeAggregateNumber(
        value.unpriceableCallCount,
        "unpriceable call count"
      ),
      unvaluedCallCount: safeAggregateNumber(value.unvaluedCallCount, "unvalued call count"),
    },
  }
}

function naturalBigInt(value: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`[Sixb] AI accounting SQL ${field} must be a natural integer.`)
  }
  return BigInt(value)
}

function safeAggregateNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`[Sixb] AI accounting ${field} exceeds the safe integer range.`)
  }
  return Number(value)
}

function requiredFragmentString(value: string | undefined, field: string): string {
  if (value === undefined || value.length === 0) {
    throw new TypeError(`[Sixb] AI accounting SQL ${field} is missing.`)
  }
  return value
}

function requiredFragmentDate(value: Date | undefined, field: string): Date {
  if (value === undefined) throw new TypeError(`[Sixb] AI accounting SQL ${field} is missing.`)
  assertDate(value, field)
  return value
}

function accountingPeriods(
  from: Date,
  to: Date,
  bucket: AiAccountingBucket
): Array<{ start: Date; end: Date }> {
  const result: Array<{ start: Date; end: Date }> = []
  let cursor = aiAccountingBucketStart(from, bucket)
  while (cursor.getTime() < to.getTime()) {
    if (result.length >= MAX_CHART_BUCKETS) {
      throw new RangeError(`[Sixb] AI accounting query exceeds ${MAX_CHART_BUCKETS} chart buckets.`)
    }
    const next = nextBucket(cursor, bucket)
    result.push({ start: new Date(cursor), end: next })
    cursor = next
  }
  return result
}

function nextBucket(start: Date, bucket: AiAccountingBucket): Date {
  const next = new Date(start)
  if (bucket === "hour") next.setUTCHours(next.getUTCHours() + 1)
  else if (bucket === "day") next.setUTCDate(next.getUTCDate() + 1)
  else next.setUTCDate(next.getUTCDate() + 7)
  return next
}

function appendGrouped(
  groups: Map<string, AiAccountingRecordSetItem[]>,
  key: string,
  item: AiAccountingRecordSetItem
): void {
  const existing = groups.get(key)
  if (existing) existing.push(item)
  else groups.set(key, [item])
}

function addAmount(amounts: Map<string, bigint>, currency: string, amountNanos: string): void {
  amounts.set(currency, (amounts.get(currency) ?? 0n) + BigInt(amountNanos))
}

function normalizePage(
  requestedLimit: number | undefined,
  requestedOffset: number | undefined
): { limit: number; offset: number } {
  const limit = requestedLimit ?? DEFAULT_MODEL_CALL_PAGE_SIZE
  const offset = requestedOffset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MODEL_CALL_PAGE_SIZE) {
    throw new TypeError(
      `[Sixb] AI accounting list limit must be an integer between 1 and ${MAX_MODEL_CALL_PAGE_SIZE}.`
    )
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("[Sixb] AI accounting list offset must be a non-negative integer.")
  }
  return { limit, offset }
}

function compareAccountingItems(
  left: AiModelCallAccountingItem,
  right: AiModelCallAccountingItem
): number {
  return (
    right.usage.occurredAt.getTime() - left.usage.occurredAt.getTime() ||
    left.usage.id.localeCompare(right.usage.id)
  )
}

function compareAgentBreakdowns(
  left: AiAccountingAgentBreakdown,
  right: AiAccountingAgentBreakdown
): number {
  return right.modelCallCount - left.modelCallCount || left.agentId.localeCompare(right.agentId)
}

function compareWorkflowBreakdowns(
  left: AiAccountingWorkflowBreakdown,
  right: AiAccountingWorkflowBreakdown
): number {
  return (
    right.modelCallCount - left.modelCallCount || left.workflowId.localeCompare(right.workflowId)
  )
}

function compareModelBreakdowns(
  left: AiAccountingModelBreakdown,
  right: AiAccountingModelBreakdown
): number {
  return (
    right.modelCallCount - left.modelCallCount ||
    left.providerId.localeCompare(right.providerId) ||
    left.modelId.localeCompare(right.modelId)
  )
}

function assertAiAccountingBucket(bucket: AiAccountingBucket): void {
  if (bucket !== "hour" && bucket !== "day" && bucket !== "week") {
    throw new TypeError("[Sixb] AI accounting bucket must be hour, day, or week.")
  }
}

function assertDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`[Sixb] AI ${label} must be a valid Date.`)
  }
}

function assertNonBlank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`[Sixb] AI ${label} must be nonblank.`)
  }
}
