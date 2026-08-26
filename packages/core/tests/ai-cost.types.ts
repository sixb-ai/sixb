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

void cost
