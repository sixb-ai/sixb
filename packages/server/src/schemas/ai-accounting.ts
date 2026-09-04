import { z } from "zod"
import { AiUsageSummarySchema } from "./ai-usage"

const IntegerStringSchema = z.string().regex(/^\d+$/)
const IsoDateSchema = z.string().datetime({ offset: true })

export const AiAccountingBucketSchema = z.enum(["hour", "day", "week"])
export const AiValuationStatusSchema = z.enum(["rated", "unpriceable", "unvalued"])

export const AiAccountingRangeQuerySchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  providerId: z.string().trim().min(1).optional(),
  modelId: z.string().trim().min(1).optional(),
})

export const AiAccountingOverviewQuerySchema = AiAccountingRangeQuerySchema.extend({
  bucket: AiAccountingBucketSchema,
})

export const AiModelCallAccountingListQuerySchema = AiAccountingRangeQuerySchema.extend({
  executionId: z.string().trim().min(1).optional(),
  valuationStatus: AiValuationStatusSchema.optional(),
  limit: IntegerStringSchema.optional(),
  offset: IntegerStringSchema.optional(),
})

export const AiMoneySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountNanos: IntegerStringSchema,
})

export const AiCostSummarySchema = z.object({
  amounts: z.array(AiMoneySchema),
  ratedCallCount: z.number().int().nonnegative(),
  unpriceableCallCount: z.number().int().nonnegative(),
  unvaluedCallCount: z.number().int().nonnegative(),
})

const AiAccountingAggregateSchema = z.object({
  modelCallCount: z.number().int().nonnegative(),
  usage: AiUsageSummarySchema,
  costs: AiCostSummarySchema,
})

export const AiAccountingOverviewResponseSchema = z.object({
  range: z.object({ from: IsoDateSchema, to: IsoDateSchema }),
  bucket: AiAccountingBucketSchema,
  totals: AiAccountingAggregateSchema,
  series: z.array(
    AiAccountingAggregateSchema.extend({
      start: IsoDateSchema,
      end: IsoDateSchema,
    })
  ),
  models: z.array(
    AiAccountingAggregateSchema.extend({
      providerId: z.string(),
      modelId: z.string(),
    })
  ),
  agents: z.array(
    AiAccountingAggregateSchema.extend({
      agentId: z.string(),
    })
  ),
  workflows: z.array(
    AiAccountingAggregateSchema.extend({
      workflowId: z.string(),
    })
  ),
})

export const AiPricingContextSchema = z.object({
  serviceTier: z.string().optional(),
  batch: z.boolean().optional(),
  region: z.string().optional(),
  inferenceGeo: z.string().optional(),
  routedProviderId: z.string().optional(),
  deploymentId: z.string().optional(),
  inferenceProfileId: z.string().optional(),
  cacheWriteTtlSeconds: z.number().int().positive().optional(),
  mode: z.string().optional(),
})

const AiCostComponentSchema = z.object({
  meter: z.enum([
    "tokens.input.total",
    "tokens.input.uncached",
    "tokens.input.cacheRead",
    "tokens.input.cacheWrite",
    "tokens.output.total",
    "tokens.output.text",
    "tokens.output.reasoning",
  ]),
  quantity: IntegerStringSchema,
  rateAmountNanosPerMillion: IntegerStringSchema,
  chargeAmountNanos: IntegerStringSchema,
})

const AiBillingIdentitySchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
})

const AiPriceSourceSchema = z.object({
  sourceId: z.string(),
  sourceEntryId: z.string(),
  sourceVersion: z.string(),
  sourceUrl: z.string().url(),
  observedAt: IsoDateSchema,
})

const AiModelCallCostSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("rated"),
    billingIdentity: AiBillingIdentitySchema,
    pricingContext: AiPricingContextSchema,
    priceSource: AiPriceSourceSchema,
    money: AiMoneySchema,
    components: z.array(AiCostComponentSchema),
    ratedAt: IsoDateSchema,
  }),
  z.object({
    status: z.literal("unpriceable"),
    billingIdentity: AiBillingIdentitySchema.optional(),
    pricingContext: AiPricingContextSchema,
    priceSource: AiPriceSourceSchema,
    reason: z.enum([
      "missingBillingIdentity",
      "missingCatalogEntry",
      "missingUsageMeter",
      "unsupportedPricingDimension",
      "invalidUsageForFormula",
    ]),
    missingMeters: z.array(AiCostComponentSchema.shape.meter).optional(),
    ratedAt: IsoDateSchema,
  }),
])

const AiModelCallUsageRecordSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  attempt: z.number().int().positive(),
  callId: z.string(),
  providerId: z.string(),
  requestedModelId: z.string(),
  responseModelId: z.string().optional(),
  responseId: z.string(),
  usage: AiUsageSummarySchema,
  occurredAt: IsoDateSchema,
  recordedAt: IsoDateSchema,
})

export const AiModelCallAccountingItemSchema = z.object({
  usage: AiModelCallUsageRecordSchema,
  attribution: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("agent"),
        agentId: z.string(),
        agentRunId: z.string(),
        threadId: z.string(),
      }),
      z.object({
        kind: z.literal("workflowAgent"),
        agentId: z.string(),
        nodeRunId: z.string(),
        workflowId: z.string(),
        workflowRunId: z.string(),
      }),
      z.object({
        kind: z.literal("subagent"),
        subagentRunId: z.string(),
        parentRunId: z.string(),
      }),
    ])
    .optional(),
  cost: AiModelCallCostSchema.optional(),
  valuationStatus: AiValuationStatusSchema,
})

export const AiModelCallAccountingListResponseSchema = z.object({
  items: z.array(AiModelCallAccountingItemSchema),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative(),
})
