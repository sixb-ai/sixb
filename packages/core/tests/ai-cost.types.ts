import type { AiCostSummary } from "@sixb/core"

// Agent and workflow run views expose `cost?: AiCostSummary`, so authors must be able to name it
// from the package root.
const summary = {
  amounts: [{ currency: "USD", amountNanos: "10000000" }],
  ratedCallCount: 1,
  unpriceableCallCount: 0,
  unvaluedCallCount: 0,
} as const satisfies AiCostSummary

void summary
