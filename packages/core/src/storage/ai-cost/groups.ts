import type { AiAccountingRecordSetItem } from "./analytics"
import { aiAccountingItemMatchesQuery, normalizeAiModelCallAccountingQuery } from "./analytics"
import type {
  AiAccountingAttribution,
  AiBillingIdentity,
  AiCostSummary,
  AiModelCallExecutionSummary,
  AiModelCallGroup,
  AiModelCallGroupSummary,
  AiMoney,
  ListAiModelCallGroupsInput,
  ListAiModelCallGroupsResult,
} from "./types"

export interface AiAccountingGroupIdentity {
  readonly executionId: string
  readonly attribution?: AiAccountingAttribution
}

/** A compact SQL aggregate, never the raw provider response or a page of individual calls. */
export interface AiModelCallGroupFragment {
  readonly root: AiAccountingGroupIdentity
  readonly execution: AiAccountingGroupIdentity
  readonly model: AiBillingIdentity
  readonly firstCallAt: Date
  readonly lastCallAt: Date
  readonly callCount: string
  readonly tokenCount: string
  readonly totalTokens: string | null
  readonly valuationStatus: "reported" | "rated" | "unpriceable" | "unvalued"
  readonly money?: AiMoney
}

/** Common provider projection; SQL groups meters before returning rows to the runtime. */
export interface AiModelCallGroupRow {
  readonly root_execution_id: string
  readonly execution_id: string
  readonly provider_id: string
  readonly requested_model_id: string
  readonly first_call_at: Date | string
  readonly last_call_at: Date | string
  readonly call_count: string
  readonly token_count: string
  readonly total_tokens: string | null
  readonly valuation_status: AiModelCallGroupFragment["valuationStatus"]
  readonly amount_currency: string | null
  readonly amount_high: string | null
  readonly amount_middle: string | null
  readonly amount_low: string | null
  readonly root_agent_run_id: string | null
  readonly root_thread_id: string | null
  readonly direct_kind: string | null
  readonly direct_run_id: string | null
  readonly parent_run_id: string | null
  readonly workflow_agent_step_id: string | null
  readonly workflow_node_run_id: string | null
  readonly workflow_id: string | null
  readonly workflow_run_id: string | null
}

export function aiModelCallGroupFragmentFromRow(
  row: AiModelCallGroupRow
): AiModelCallGroupFragment {
  let attribution: AiAccountingAttribution | undefined
  if (row.root_agent_run_id && row.root_thread_id) {
    attribution = {
      kind: "agent",
      agentRunId: row.root_agent_run_id,
      threadId: row.root_thread_id,
    }
  } else if (
    row.workflow_agent_step_id &&
    row.workflow_node_run_id &&
    row.workflow_id &&
    row.workflow_run_id
  ) {
    attribution = {
      kind: "workflowAgent",
      agentStepId: row.workflow_agent_step_id,
      nodeRunId: row.workflow_node_run_id,
      workflowId: row.workflow_id,
      workflowRunId: row.workflow_run_id,
    }
  }
  const executionAttribution: AiAccountingAttribution | undefined =
    row.direct_kind === "subagent" && row.direct_run_id && row.parent_run_id
      ? { kind: "subagent", subagentRunId: row.direct_run_id, parentRunId: row.parent_run_id }
      : attribution
  return {
    root: { executionId: row.root_execution_id, attribution },
    execution: { executionId: row.execution_id, attribution: executionAttribution },
    model: { providerId: row.provider_id, modelId: row.requested_model_id },
    firstCallAt: new Date(row.first_call_at),
    lastCallAt: new Date(row.last_call_at),
    callCount: row.call_count,
    tokenCount: row.token_count,
    totalTokens: row.total_tokens,
    valuationStatus: row.valuation_status,
    ...(row.amount_currency === null
      ? {}
      : {
          money: {
            currency: row.amount_currency,
            amountNanos: (
              BigInt(row.amount_high ?? "0") * 1_000_000_000_000n +
              BigInt(row.amount_middle ?? "0") * 1_000_000n +
              BigInt(row.amount_low ?? "0")
            ).toString(),
          },
        }),
  }
}

export function buildAiModelCallGroupsFromFragments(
  fragments: readonly AiModelCallGroupFragment[]
): readonly AiModelCallGroup[] {
  const roots = new Map<string, AiModelCallGroupFragment[]>()
  for (const fragment of fragments) append(roots, fragment.root.executionId, fragment)
  return [...roots.values()]
    .map((rootFragments): AiModelCallGroup => {
      const first = rootFragments[0]!
      const executions = new Map<string, AiModelCallGroupFragment[]>()
      for (const fragment of rootFragments)
        append(executions, fragment.execution.executionId, fragment)
      return {
        ...first.root,
        ...summarize(rootFragments),
        ...timeRange(rootFragments),
        executions: [...executions.values()]
          .map(
            (items): AiModelCallExecutionSummary => ({
              ...items[0]!.execution,
              ...summarize(items),
              ...timeRange(items),
              models: [
                ...new Map(items.map(({ model }) => [JSON.stringify(model), model])).values(),
              ].sort(
                (a, b) =>
                  compareText(a.providerId, b.providerId) || compareText(a.modelId, b.modelId)
              ),
            })
          )
          .sort(
            (a, b) =>
              a.firstCallAt.getTime() - b.firstCallAt.getTime() ||
              compareText(a.executionId, b.executionId)
          ),
      }
    })
    .sort(
      (a, b) =>
        b.lastCallAt.getTime() - a.lastCallAt.getTime() || compareText(a.executionId, b.executionId)
    )
}

export function buildAiModelCallGroups(
  input: ListAiModelCallGroupsInput,
  source: readonly (AiAccountingRecordSetItem & { readonly root: AiAccountingGroupIdentity })[]
): ListAiModelCallGroupsResult {
  const query = normalizeAiModelCallAccountingQuery(input)
  const fragments = source
    .filter(
      (item) =>
        aiAccountingItemMatchesQuery(item, query) &&
        (query.valuationStatus === undefined ||
          (item.cost?.status ?? "unvalued") === query.valuationStatus)
    )
    .map(
      (item): AiModelCallGroupFragment => ({
        root: item.root,
        execution: { executionId: item.usage.executionId, attribution: item.attribution },
        model: { providerId: item.usage.providerId, modelId: item.usage.requestedModelId },
        firstCallAt: item.usage.occurredAt,
        lastCallAt: item.usage.occurredAt,
        callCount: "1",
        tokenCount: item.usage.usage.totalTokens === undefined ? "0" : "1",
        totalTokens: item.usage.usage.totalTokens?.toString() ?? null,
        valuationStatus: item.cost?.status ?? "unvalued",
        ...(item.cost && item.cost.status !== "unpriceable" ? { money: item.cost.money } : {}),
      })
    )
  const groups = buildAiModelCallGroupsFromFragments(fragments)
  const items = groups.slice(query.offset, query.offset + query.limit)
  return structuredClone({
    items,
    total: groups.length,
    hasMore: query.offset + items.length < groups.length,
  })
}

function summarize(items: readonly AiModelCallGroupFragment[]): AiModelCallGroupSummary {
  let calls = 0n
  let tokenCount = 0n
  let tokens = 0n
  const counts = { reported: 0n, rated: 0n, unpriceable: 0n, unvalued: 0n }
  const money = new Map<string, bigint>()
  for (const item of items) {
    const count = BigInt(item.callCount)
    calls += count
    tokenCount += BigInt(item.tokenCount)
    tokens += BigInt(item.totalTokens ?? "0")
    counts[item.valuationStatus] += count
    if (item.money)
      money.set(
        item.money.currency,
        (money.get(item.money.currency) ?? 0n) + BigInt(item.money.amountNanos)
      )
  }
  const costs: AiCostSummary = {
    amounts: [...money]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({ currency, amountNanos: amount.toString() })),
    reportedCallCount: safeCount(counts.reported),
    ratedCallCount: safeCount(counts.rated),
    unpriceableCallCount: safeCount(counts.unpriceable),
    unvaluedCallCount: safeCount(counts.unvalued),
  }
  return {
    modelCallCount: safeCount(calls),
    ...(calls === tokenCount ? { totalTokens: safeCount(tokens) } : {}),
    costs,
  }
}

function timeRange(items: readonly AiModelCallGroupFragment[]) {
  let first = items[0]!.firstCallAt.getTime()
  let last = items[0]!.lastCallAt.getTime()
  for (const item of items) {
    first = Math.min(first, item.firstCallAt.getTime())
    last = Math.max(last, item.lastCallAt.getTime())
  }
  return { firstCallAt: new Date(first), lastCallAt: new Date(last) }
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}

function safeCount(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("[Sixb] AI accounting group count exceeds the safe integer range.")
  return Number(value)
}

function append<T>(map: Map<string, T[]>, key: string, item: T): void {
  const items = map.get(key)
  if (items) items.push(item)
  else map.set(key, [item])
}
