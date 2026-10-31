import type {
  AiModelCallUsageInput,
  AiModelCallUsageRecord,
  AiUsageReportingStatus,
} from "../ai-usage"

/** Meters supported by deterministic local rate cards. */
export type AiBillableMeter =
  | "audio.input.milliseconds"
  | "characters.input"
  | "images.output"
  | "tokens.input.total"
  | "tokens.input.uncached"
  | "tokens.input.cacheRead"
  | "tokens.input.cacheWrite"
  | "tokens.input.cacheWrite5m"
  | "tokens.input.cacheWrite1h"
  | "tokens.output.total"
  | "tokens.output.text"
  | "tokens.output.reasoning"
  | "tokens.output.image"
  | "tokens.output.audio"

/** Exact money in nanounits of a currency's major unit. */
export interface AiMoney {
  readonly currency: string
  /** Canonical non-negative integer string. One USD is 1,000,000,000 nanounits. */
  readonly amountNanos: string
}

/** Provider and model identity used for billing. */
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

/** Immutable provenance of the provider report or rate card applied to a valuation. */
export interface AiPriceSource {
  readonly sourceId: string
  readonly sourceEntryId: string
  readonly sourceVersion: string
  readonly sourceUrl?: string
  readonly observedAt: Date
}

export interface AiCostComponent {
  readonly meter: AiBillableMeter
  readonly quantity: string
  readonly rateAmountNanosPerMillion: string
  readonly chargeAmountNanos: string
  /** The price variant that applied, such as `1024x1024 · high`. Display only. */
  readonly variant?: string
}

export type AiUnpriceableReason =
  | "missingBillingIdentity"
  | "missingRateCard"
  | "missingUsageMeter"
  | "unsupportedPricingDimension"
  | "invalidUsageForFormula"

interface AiModelCallCostRecordBase {
  /** Local estimate retained independently when an inline provider cost is selected. */
  readonly estimate?: AiCostEstimate
  readonly projectId: string
  readonly usageRecordId: string
  readonly pricingContext: AiPricingContext
  readonly ratedAt: Date
}

export type AiCostEstimate =
  | {
      readonly status: "rated"
      readonly money: AiMoney
      readonly components: readonly AiCostComponent[]
    }
  | {
      readonly status: "unpriceable"
      readonly reason: AiUnpriceableReason
      readonly missingMeters?: readonly AiBillableMeter[]
    }

/** Selected monetary valuation; its observation/provenance distinguishes estimates from reports. */
export interface AiRatedModelCallCostRecord extends AiModelCallCostRecordBase {
  readonly status: "rated"
  readonly billingIdentity: AiBillingIdentity
  readonly priceSource: AiPriceSource
  readonly money: AiMoney
  readonly components: readonly AiCostComponent[]
}

/** Explicit result when a call cannot be completely and safely valued. */
export interface AiUnpriceableModelCallCostRecord extends AiModelCallCostRecordBase {
  readonly status: "unpriceable"
  readonly billingIdentity?: AiBillingIdentity
  readonly priceSource?: AiPriceSource
  readonly reason: AiUnpriceableReason
  readonly missingMeters?: readonly AiBillableMeter[]
}

export type AiModelCallCostRecord = AiRatedModelCallCostRecord | AiUnpriceableModelCallCostRecord

export interface SummarizeAiCostExecutionsInput {
  readonly projectId: string
  readonly executionIds: readonly string[]
}

export interface AiCostSummary {
  /** Selected request valuations, never the sum of competing observations or period reports. */
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

/** Who started the work a model call was for: the requester of its execution. */
export interface AiAccountingRequester {
  readonly type: "user" | "serviceAccount"
  readonly id: string
}

/**
 * Where a model call came from: an agent conversation with the sub-agents it started, a workflow,
 * an action, or anything else, such as a request of the project's own code.
 */
export type AiAccountingSource =
  | { readonly kind: "agent" }
  /** As a filter, without `workflowId`: any workflow. */
  | { readonly kind: "workflow"; readonly workflowId?: string }
  | { readonly kind: "action" }
  | { readonly kind: "other" }

/** What every accounting read can narrow its range to. */
export interface AiAccountingFilters {
  readonly providerId?: string
  readonly modelId?: string
  /** `"none"` keeps the calls nobody requested, such as a schedule's. */
  readonly requester?: AiAccountingRequester | "none"
  readonly source?: AiAccountingSource
  readonly modelKind?: import("../../models/definitions").ModelKind
}

export interface QueryAiAccountingOverviewInput extends AiAccountingRange, AiAccountingFilters {
  readonly projectId: string
  readonly bucket: AiAccountingBucket
}

export interface ListAiModelCallAccountingInput extends AiAccountingRange, AiAccountingFilters {
  readonly projectId: string
  readonly executionId?: string
  readonly valuationStatus?: "rated" | "unpriceable" | "unvalued"
  readonly limit?: number
  readonly offset?: number
}

/** Observed meter sums. Unreported meters are absent; incomplete sums are lower bounds. */
export interface AiAccountingUsage extends AiModelCallUsageInput {
  /** Sum of available input and output counts, including one-sided reports. */
  readonly totalTokens?: number
  /** Complete only when every call reports both input and output; details have separate coverage. */
  readonly reportingStatus: AiUsageReportingStatus
}

export interface AiAccountingAggregate {
  readonly modelCallCount: number
  readonly usage: AiAccountingUsage
  readonly usageCoverage: {
    /** Calls reporting both inputTokens and outputTokens. */
    readonly completeCallCount: number
    readonly fieldCallCounts: Readonly<Record<keyof AiModelCallUsageInput, number>>
  }
  readonly costs: AiCostSummary
}

export interface AiAccountingTimeBucket extends AiAccountingAggregate {
  readonly start: Date
  readonly end: Date
}

export type AiAccountingAgentBreakdown = AiAccountingAggregate &
  (
    | { readonly kind: "agent" }
    | {
        readonly kind: "workflowAgent"
        readonly workflowId: string
        readonly agentStepId: string
      }
  )

export interface AiAccountingWorkflowBreakdown extends AiAccountingAggregate {
  readonly workflowId: string
}

export interface AiAccountingModelBreakdown extends AiAccountingAggregate {
  readonly providerId: string
  readonly modelId: string
}

export interface AiAccountingPersonBreakdown extends AiAccountingAggregate {
  /** Absent for the calls nobody requested, such as a schedule's. */
  readonly requester?: AiAccountingRequester
}

/** One model's share of each period, every period of the range included. */
export interface AiAccountingModelSeries {
  readonly providerId: string
  readonly modelId: string
  readonly series: readonly AiAccountingTimeBucket[]
}

export interface AiAccountingKindBreakdown extends AiAccountingAggregate {
  /** Absent for calls recorded before their kind was captured. */
  readonly modelKind?: import("../../models/definitions").ModelKind
}

export interface AiAccountingOverview {
  readonly range: AiAccountingRange
  readonly bucket: AiAccountingBucket
  readonly totals: AiAccountingAggregate
  readonly series: readonly AiAccountingTimeBucket[]
  /** Each model's own series, for spend stacked by model. */
  readonly modelSeries: readonly AiAccountingModelSeries[]
  readonly models: readonly AiAccountingModelBreakdown[]
  readonly kinds: readonly AiAccountingKindBreakdown[]
  readonly people: readonly AiAccountingPersonBreakdown[]
  readonly agents: readonly AiAccountingAgentBreakdown[]
  readonly workflows: readonly AiAccountingWorkflowBreakdown[]
}

/**
 * The execution that made the model call, rather than the request that triggered its work.
 * `request` identifies a direct call from a request-bound SDK, outside an action or workflow.
 */
export type AiAccountingAttribution =
  | { readonly kind: "request"; readonly requestId: string }
  | { readonly kind: "action"; readonly actionId: string; readonly actionRunId: string }
  | { readonly kind: "workflow"; readonly workflowId: string; readonly workflowRunId: string }
  | {
      readonly kind: "agent"
      readonly agentRunId: string
      readonly threadId: string
    }
  | {
      readonly kind: "workflowAgent"
      readonly agentStepId: string
      readonly nodeRunId: string
      readonly workflowId: string
      readonly workflowRunId: string
    }
  | {
      readonly kind: "subagent"
      readonly subagentRunId: string
      readonly parentRunId: string
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

export type ListAiModelCallGroupsInput = Omit<ListAiModelCallAccountingInput, "executionId"> & {
  /** Most recent first, the default, or costliest first. */
  readonly sort?: "recent" | "cost"
}

/** Filtered usage; an absent token total means at least one call did not report it. */
export interface AiModelCallGroupSummary {
  readonly modelCallCount: number
  /** Present when every call that reports tokens did; tokenless kinds such as images don't. */
  readonly totalTokens?: number
  /** Sums over the calls that reported them. */
  readonly inputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly outputImages?: number
  readonly inputCharacters?: number
  readonly audioDurationMs?: number
  readonly costs: AiCostSummary
}

/** One model's calls within an execution. */
export interface AiModelCallModelSummary extends AiBillingIdentity {
  readonly modelCallCount: number
  readonly costs: AiCostSummary
}

export interface AiModelCallExecutionSummary extends AiModelCallGroupSummary {
  readonly executionId: string
  readonly attribution?: AiAccountingAttribution
  readonly firstCallAt: Date
  readonly lastCallAt: Date
  readonly models: readonly AiModelCallModelSummary[]
}

/**
 * One conversation, workflow run or other initiating execution, including only calls matching the
 * accounting filters. A conversation's executions are its turns and their sub-agents; a workflow
 * run's are its agent steps.
 */
export interface AiModelCallGroup extends AiModelCallGroupSummary {
  /** The group's first initiating execution in the range, such as a conversation's first turn. */
  readonly executionId: string
  readonly attribution?: AiAccountingAttribution
  /** Who started it; absent when nobody did, such as a schedule. */
  readonly requester?: AiAccountingRequester
  readonly firstCallAt: Date
  readonly lastCallAt: Date
  readonly executions: readonly AiModelCallExecutionSummary[]
}

export interface ListAiModelCallGroupsResult {
  readonly items: readonly AiModelCallGroup[]
  readonly total: number
  readonly hasMore: boolean
}

/** Immutable call-time costs. Inline provider costs take precedence over local estimates. */
export interface AiCostStorage {
  recordModelCallCost(input: AiModelCallCostRecord): Promise<void>
  summarizeExecutions(input: SummarizeAiCostExecutionsInput): Promise<readonly AiCostSummary[]>
  queryProjectOverview(input: QueryAiAccountingOverviewInput): Promise<AiAccountingOverview>
  listModelCalls(input: ListAiModelCallAccountingInput): Promise<ListAiModelCallAccountingResult>
  listModelCallGroups(input: ListAiModelCallGroupsInput): Promise<ListAiModelCallGroupsResult>
}
