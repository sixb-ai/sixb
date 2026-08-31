import type { AiModelCallUsageRecord } from "../ai-usage"

/** Token meters supported by the deterministic local catalog rater. */
export type AiBillableMeter =
  | "tokens.input.total"
  | "tokens.input.uncached"
  | "tokens.input.cacheRead"
  | "tokens.input.cacheWrite"
  | "tokens.input.cacheWrite5m"
  | "tokens.input.cacheWrite1h"
  | "tokens.output.total"
  | "tokens.output.text"
  | "tokens.output.reasoning"

/** Exact money in nanounits of a currency's major unit. */
export interface AiMoney {
  readonly currency: string
  /** Canonical non-negative integer string. One USD is 1,000,000,000 nanounits. */
  readonly amountNanos: string
}

/** Provider and model key in a pricing catalog. */
export interface AiBillingIdentity {
  readonly providerId: string
  readonly modelId: string
}

/** Allowlisted response/request dimensions retained for audit and strict fail-closed pricing. */
export interface AiPricingContext {
  readonly serviceTier?: string
  readonly batch?: boolean
  readonly region?: string
  readonly inferenceGeo?: string
  readonly routedProviderId?: string
  readonly routedModelId?: string
  readonly deploymentId?: string
  readonly inferenceProfileId?: string
  readonly cacheWriteTtlSeconds?: number
  readonly mode?: string
}

/** Immutable provenance of the compact catalog entry applied to a valuation. */
export interface AiPriceSource {
  readonly sourceId: string
  readonly sourceEntryId: string
  readonly sourceVersion: string
  readonly sourceUrl: string
  readonly observedAt: Date
}

export interface AiCostComponent {
  readonly meter: AiBillableMeter
  readonly quantity: string
  readonly rateAmountNanosPerMillion: string
  readonly chargeAmountNanos: string
}

export type AiUnpriceableReason =
  | "missingBillingIdentity"
  | "missingCatalogEntry"
  | "missingUsageMeter"
  | "unsupportedPricingDimension"
  | "invalidUsageForFormula"

interface AiModelCallCostRecordBase {
  readonly projectId: string
  readonly usageRecordId: string
  readonly pricingContext: AiPricingContext
  readonly priceSource: AiPriceSource
  readonly ratedAt: Date
}

/** Exact cost from an immutable price source. Provider-reported totals may omit components. */
export interface AiRatedModelCallCostRecord extends AiModelCallCostRecordBase {
  readonly status: "rated"
  readonly billingIdentity: AiBillingIdentity
  readonly money: AiMoney
  readonly components: readonly AiCostComponent[]
}

/** Explicit result when the compact catalog cannot completely and safely value a call. */
export interface AiUnpriceableModelCallCostRecord extends AiModelCallCostRecordBase {
  readonly status: "unpriceable"
  readonly billingIdentity?: AiBillingIdentity
  readonly reason: AiUnpriceableReason
  readonly missingMeters?: readonly AiBillableMeter[]
}

export type AiModelCallCostRecord = AiRatedModelCallCostRecord | AiUnpriceableModelCallCostRecord

export interface SummarizeAiCostExecutionsInput {
  readonly projectId: string
  readonly executionIds: readonly string[]
}

export interface AiCostSummary {
  readonly amounts: readonly AiMoney[]
  readonly ratedCallCount: number
  readonly unpriceableCallCount: number
  readonly unvaluedCallCount: number
}

export type AiAccountingBucket = "hour" | "day" | "week"

/** Inclusive start and exclusive end for project accounting reads. */
export interface AiAccountingRange {
  readonly from: Date
  readonly to: Date
}

export interface QueryAiAccountingOverviewInput extends AiAccountingRange {
  readonly projectId: string
  readonly bucket: AiAccountingBucket
  readonly providerId?: string
  readonly modelId?: string
}

export interface ListAiModelCallAccountingInput extends AiAccountingRange {
  readonly projectId: string
  readonly providerId?: string
  readonly modelId?: string
  readonly executionId?: string
  readonly valuationStatus?: "rated" | "unpriceable" | "unvalued"
  readonly limit?: number
  readonly offset?: number
}

export interface AiAccountingAggregate {
  readonly modelCallCount: number
  readonly usage: AiModelCallUsageRecord["usage"]
  readonly costs: AiCostSummary
}

export interface AiAccountingTimeBucket extends AiAccountingAggregate {
  readonly start: Date
  readonly end: Date
}

export interface AiAccountingAgentBreakdown extends AiAccountingAggregate {
  readonly agentId: string
}

export interface AiAccountingWorkflowBreakdown extends AiAccountingAggregate {
  readonly workflowId: string
}

export interface AiAccountingModelBreakdown extends AiAccountingAggregate {
  readonly providerId: string
  readonly modelId: string
}

export interface AiAccountingOverview {
  readonly range: AiAccountingRange
  readonly bucket: AiAccountingBucket
  readonly totals: AiAccountingAggregate
  readonly series: readonly AiAccountingTimeBucket[]
  readonly models: readonly AiAccountingModelBreakdown[]
  readonly agents: readonly AiAccountingAgentBreakdown[]
  readonly workflows: readonly AiAccountingWorkflowBreakdown[]
}

export type AiAccountingAttribution =
  | {
      readonly kind: "agent"
      readonly agentId: string
      readonly agentRunId: string
      readonly threadId: string
    }
  | {
      readonly kind: "workflowAgent"
      readonly agentId: string
      readonly nodeRunId: string
      readonly workflowId: string
      readonly workflowRunId: string
    }

export interface AiModelCallAccountingItem {
  readonly usage: AiModelCallUsageRecord
  readonly attribution?: AiAccountingAttribution
  readonly cost?: AiModelCallCostRecord
  readonly valuationStatus: "rated" | "unpriceable" | "unvalued"
}

export interface ListAiModelCallAccountingResult {
  readonly items: readonly AiModelCallAccountingItem[]
  readonly hasMore: boolean
  readonly total: number
}

/** Immutable model-call costs plus execution and project accounting reads. */
export interface AiCostStorage {
  recordModelCallCost(input: AiModelCallCostRecord): Promise<void>
  summarizeExecutions(input: SummarizeAiCostExecutionsInput): Promise<readonly AiCostSummary[]>
  queryProjectOverview(input: QueryAiAccountingOverviewInput): Promise<AiAccountingOverview>
  listModelCalls(input: ListAiModelCallAccountingInput): Promise<ListAiModelCallAccountingResult>
}
