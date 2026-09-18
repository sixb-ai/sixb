import { expect, test } from "bun:test"
import type { JsonObject, LanguageModelRequest } from "@sixb/core/models"
import { createAzureAIFoundry } from "./provider-fixture"

const request = (reasoning: LanguageModelRequest["reasoning"] = "high"): LanguageModelRequest => ({
  callId: "summary",
  messages: [],
  tools: [],
  reasoning,
  maxOutputTokens: 100,
  signal: AbortSignal.timeout(1000),
})

function fixture(modelName: string, publisher = "OpenAI", reasoning = true) {
  let body: JsonObject | undefined
  const provider = createAzureAIFoundry({
    endpoint: "https://resource.services.ai.azure.com/api/projects/test",
    apiKey: "key",
    providerId: "custom-foundry",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(
        [
          {
            type: "response.reasoning_summary_text.delta",
            item_id: "r",
            summary_index: 0,
            delta: "Summary",
          },
          { type: "response.completed", response: { status: "completed", output: [] } },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("")
      )
    },
  })
  const options = {
    identity: { publisher, modelName },
    definition: {
      capabilities: {
        reasoning: reasoning ? { canDisable: true, efforts: ["high"] as const } : (false as const),
      },
    },
  }
  return { provider, options, body: () => body }
}

// Removal proof: remove the automatic summary selection; the outgoing request loses
// summary:auto. Run with -t "defaults reasoning summaries".
test.each([
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "o3",
  "o4-mini",
])("defaults reasoning summaries for verified OpenAI %s Responses deployments", async (modelName) => {
  const f = fixture(modelName)
  const model = f.provider.responses("production", f.options)
  const events = []
  for await (const event of (await model.stream(request())).events) events.push(event)
  expect(f.body()?.reasoning).toEqual({ effort: "high", summary: "auto" })
  expect(events).toContainEqual({ type: "reasoning-delta", id: "r:reasoning:0", delta: "Summary" })
  await model.stream(request("provider-default"))
  expect(f.body()?.reasoning).toEqual({ summary: "auto" })
  await model.stream(request("none"))
  expect(f.body()?.reasoning).toEqual({ effort: "none" })
})

test("preserves explicit summary opt-out and requested summary formats", async () => {
  const f = fixture("gpt-5-mini")
  for (const reasoningSummary of [false, "auto", "concise", "detailed"] as const) {
    await f.provider.responses("production", { ...f.options, reasoningSummary }).stream(request())
    expect(f.body()?.reasoning).toEqual({
      effort: "high",
      ...(reasoningSummary ? { summary: reasoningSummary } : {}),
    })
  }
})

test("does not infer summaries for unknown, nonreasoning, partner or Chat deployments", async () => {
  for (const [modelName, publisher, reasoning] of [
    ["future-model", "OpenAI", true],
    ["gpt-4.1-mini", "OpenAI", false],
    ["gpt-5-mini", "Partner", true],
    ["gpt-5-mini", "OpenAI", false],
  ] as const) {
    const f = fixture(modelName, publisher, reasoning)
    await f.provider.responses("production", f.options).stream(request("provider-default"))
    expect(f.body()?.reasoning).toBeUndefined()
  }
  const f = fixture("gpt-5-mini")
  await f.provider.chat("production", f.options).stream(request())
  expect(f.body()?.reasoning).toBeUndefined()
  expect(f.body()?.reasoning_effort).toBe("high")
  const unknown = fixture("future-model")
  await unknown.provider
    .responses("production", { ...unknown.options, reasoningSummary: "auto" })
    .stream(request())
  expect(unknown.body()?.reasoning).toEqual({ effort: "high", summary: "auto" })
})
