import { expect, test } from "bun:test"
import { createVercelGateway } from "../src"
import { decisionQuestions, decisionRuntime } from "./decision-fixture"

const enabled = process.env.SIXB_VERCEL_GATEWAY_DECISION_E2E === "1"
const credential = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN

// One bounded inference request. Opt in explicitly, even when local credentials exist.
test.skipIf(!enabled || !credential)(
  "evaluates all decision primitives through live Gateway and persists usage and cost",
  async () => {
    let inferenceCalls = 0
    const gateway = createVercelGateway({
      fetch: (url, init) => {
        if (String(url).endsWith("/evaluate")) inferenceCalls++
        return fetch(url, init)
      },
    })
    const { host, sixb, storage, identity } = decisionRuntime(gateway.decision("typesafe-ai/jev"))
    await storage.aiLimits.createPolicy({
      id: "live-budget",
      projectId: host.id,
      subject: { type: "project" },
      limit: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "10000000" },
      },
    })
    const result = await sixb.models.decision.evaluate({
      input: {
        message: "I was billed twice for one subscription. Please refund the duplicate payment.",
      },
      questions: decisionQuestions,
      signal: AbortSignal.timeout(40_000),
    })
    // Assert the contract, not non-deterministic model quality or a decision threshold.
    expect(["billing", "technical"]).toContain(result.output.category.choice)
    expect(result.output.impact.probabilities).toHaveLength(3)
    expect(result.output.refund.probability).toBeGreaterThanOrEqual(0)
    expect(result.output.refund.probability).toBeLessThanOrEqual(1)
    expect(result.usage.inputTokens).toBeGreaterThan(0)
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0)
    expect(result.cost.status).toBe("reported")
    expect(inferenceCalls).toBe(1)
    const recorded = await storage.aiUsage.getLatestForExecution(identity)
    expect(recorded).toMatchObject({
      callId: result.callId,
      providerId: "vercel-ai-gateway",
      requestedModelId: "typesafe-ai/jev",
      responseModelId: result.responseModelId,
    })
    expect(recorded?.providerIds?.generationId).toBeDefined()
    console.info("[SixbVercelGateway] Live decision verified:", {
      model: result.responseModelId,
      usage: result.usage,
      cost: result.cost,
      inferenceCalls,
    })
  },
  45_000
)
