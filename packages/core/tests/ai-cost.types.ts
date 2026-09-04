import type { AiCostSummary } from "@sixb/core"
import type { AiModelCallCostRecord, AiPricingContext } from "../src/storage/ai-cost"

const context = {
  serviceTier: "standard",
  mode: "fast",
} as const satisfies AiPricingContext

const cost = {
  projectId: "project_1",
  usageRecordId: "usage_1",
  status: "unpriceable",
  billingIdentity: { providerId: "anthropic", modelId: "claude-opus-4-8" },
  pricingContext: context,
  priceSource: {
    sourceId: "models.dev",
    sourceEntryId: "anthropic/claude-opus-4-8",
    sourceVersion: "sha256:test",
    sourceUrl: "https://models.dev/api.json",
    observedAt: new Date(),
  },
  reason: "unsupportedPricingDimension",
  ratedAt: new Date(),
} as const satisfies AiModelCallCostRecord

const summary = {
  amounts: [{ currency: "USD", amountNanos: "10000000" }],
  reportedCallCount: 0,
  ratedCallCount: 1,
  unpriceableCallCount: 0,
  unvaluedCallCount: 0,
} as const satisfies AiCostSummary

void cost
void summary
