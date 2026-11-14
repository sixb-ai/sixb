import { afterAll, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type ModelCatalogInput,
  question,
  SixbHost,
} from "@sixb/core"
import { ModelProviderError } from "@sixb/core/models"
import { createTestSixb } from "@sixb/core/testing"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

// Opt-in: billable decision calls, at most 16, serial and without retries. Each one bills its
// input tokens only (USD 0.042 per million); the context-limit case sends about 40k tokens.
const env = process.env
const enabled = env.SIXB_FOUNDRY_E2E === "1"
const endpoint = env.AZURE_FOUNDRY_PROJECT_ENDPOINT
const apiKey = env.AZURE_FOUNDRY_API_KEY
const deployment = env.AZURE_FOUNDRY_DECISION_DEPLOYMENT
const light = env.AZURE_FOUNDRY_FAST_DEPLOYMENT
const standard = env.AZURE_FOUNDRY_STANDARD_DEPLOYMENT
const live = (skip = false) => test.skipIf(!enabled || !endpoint || !apiKey || !deployment || skip)

let evaluations = 0
const report: unknown[] = []

const boundedFetch: NonNullable<AzureAIFoundryOptions["fetch"]> = async (input, init) => {
  if (new URL(String(input)).pathname.endsWith("/systemone")) {
    if (++evaluations > 16) throw new Error("Live test decision allowance exhausted")
  }
  return fetch(input, init)
}

function foundry() {
  return createAzureAIFoundry({ endpoint: endpoint!, apiKey, maxRetries: 0, fetch: boundedFetch })
}

function project(models: ModelCatalogInput) {
  return new SixbHost({
    id: "foundry-decision-live",
    ontology: [],
    models,
    storage: new InMemoryStorage(),
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
  })
}

const triage = {
  category: question.choice({
    instructions: "Identify the main issue in description.",
    options: {
      maintenance: "Breakdowns, leaks, and repairs",
      billing: "Invoices, payments, and refunds",
      other: "Any other request",
    },
  }),
  severity: question.score({
    instructions: "Assess the operational impact described in description.",
    levels: [
      "No operational impact",
      "Degraded operation; workaround available",
      "Operation stopped; no workaround",
    ],
  }),
  blocked: question.probability(
    "Does description explicitly report equipment that cannot operate?"
  ),
}

afterAll(() => {
  if (evaluations) console.info("[FoundryDecisionLive]", JSON.stringify({ evaluations, report }))
})

live()(
  "answers choice, score and probability questions and records usage and cost",
  async () => {
    const host = project({ decision: [foundry().decision(deployment!)] })
    const sixb = createTestSixb(host)
    const cases = [
      ["The cooling unit has stopped and the production line is down.", "maintenance"],
      ["We were charged twice on invoice 4411; please refund one charge.", "billing"],
      ["Could you send me your product brochure?", "other"],
    ] as const
    const results = []

    for (const [description, expected] of cases) {
      const started = performance.now()
      const result = await sixb.models.decision.evaluate({
        input: { description },
        questions: triage,
      })
      const ms = Math.round(performance.now() - started)
      report.push({
        description,
        ms,
        output: result.output,
        usage: result.usage,
        cost: result.cost,
      })
      results.push(result)

      expect(result.output.category.choice).toBe(expected)
      expect(result.responseModelId).toBe("microsoft-decision-1")
      expect(result.usage.inputTokens).toBeGreaterThan(0)
      expect(result.cost).toMatchObject({ status: "rated", money: { currency: "USD" } })
    }

    const [stopped, , brochure] = results
    expect(stopped!.output.severity.score).toBeGreaterThan(brochure!.output.severity.score)
    expect(stopped!.output.blocked.probability).toBeGreaterThan(0.5)
    expect(brochure!.output.blocked.probability).toBeLessThan(0.5)
    expect(
      await host.storage.aiUsage!.getLatestForExecution({
        projectId: host.id,
        executionId: sixb.execution.id,
      })
    ).toMatchObject({ modelKind: "decision", requestedModelId: deployment })
  },
  30_000
)

live()(
  "Azure's rejections and the timeout surface as errors",
  async () => {
    const model = await foundry().decision(deployment!).resolve()

    // Sixb allows a one-option choice; Microsoft-Decision-1 asks for 2–255.
    const single = await model
      .evaluate({
        input: "x",
        questions: { q: question.choice({ instructions: "Pick", options: { a: null } }) },
      })
      .catch((error: unknown) => error)
    expect(single).toBeInstanceOf(ModelProviderError)
    expect(single).toMatchObject({
      status: 400,
      code: "unsupported_request_argument",
      retryable: false,
    })

    const oversized = await model
      .evaluate({ input: "word ".repeat(40_000), questions: { q: question.probability("Spam?") } })
      .catch((error: unknown) => error)
    expect(oversized).toMatchObject({ status: 422, retryable: false })
    expect(String(oversized)).toContain("32768-token context limit")

    const timed = await foundry().decision(deployment!, { timeoutMs: 1 }).resolve()
    const timeout = await timed
      .evaluate({ input: "x", questions: { q: question.probability("Spam?") } })
      .catch((error: unknown) => error)
    expect(timeout).toMatchObject({ name: "TimeoutError" })
    report.push({ single: String(single), oversized: String(oversized), timeout: String(timeout) })
  },
  30_000
)

live(!light || !standard)(
  "picks the tier of each chat message",
  async () => {
    const provider = foundry()
    const host = project({
      language: { light: provider.chat(light!), standard: provider.chat(standard!) },
      decision: [provider.decision(deployment!)],
    })
    const sixb = createTestSixb(host)
    const ask = async (text: string) => {
      const started = performance.now()
      const { run } = await sixb.agent.runs.request({ text })
      report.push({ text, ms: Math.round(performance.now() - started), spec: run.spec })
      return run.spec!
    }

    const heavy = await ask(
      "Investigate why energy use rose at our three sites last quarter, weigh the likely causes, and write a remediation plan."
    )
    const thanks = await ask("Thanks, that's all!")

    // A tier comes from Foundry's answer only; a failed or late answer leaves no probabilities.
    // Without a heavy tier, standard stands in for it.
    expect(heavy.tierProbabilities!.heavy).toBeGreaterThanOrEqual(0.4)
    expect(heavy.model.modelId).toBe(standard!)
    expect(thanks.tierProbabilities!.light).toBeGreaterThanOrEqual(0.8)
    expect(thanks).toMatchObject({ tier: "light", model: { modelId: light } })
  },
  30_000
)
