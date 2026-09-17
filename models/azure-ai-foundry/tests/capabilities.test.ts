import { expect, test } from "bun:test"
import { createAzureAIFoundry } from "../src"

const definition = {
  maxOutputTokens: 4096,
  capabilities: {
    inputMediaTypes: "any" as const,
    reasoning: {
      canDisable: true,
      efforts: ["minimal", "low", "high"] as const,
      budgetTokens: { min: 1, max: 8192 },
    },
    localTools: true,
    nativeStructuredOutput: true,
  },
}
const provider = () =>
  createAzureAIFoundry({
    endpoint: "https://example.test/api/projects/test",
    apiKey: "test",
    fetch: async () =>
      Response.json({
        value: [
          {
            type: "ModelDeployment",
            name: "deployment",
            modelName: "future",
            modelVersion: "1",
            modelPublisher: "partner",
            capabilities: {},
            sku: { name: "GlobalStandard" },
          },
        ],
      }),
    catalog: { fetch: async () => Response.json({ azure: { models: {} } }) },
  })

// Regression proof: remove effective capability intersection in resolveModel. The
// Chat binding again advertises budgets/PDFs it cannot serialize (observed on Kimi).
test("effective capabilities reflect protocol limits even with explicit definitions", async () => {
  const p = provider()
  const chat = (await p.chat("deployment", { definition }).resolve()).definition.capabilities
  expect(chat.reasoning).toEqual({ canDisable: true, efforts: ["minimal", "low", "high"] })
  expect(chat.inputMediaTypes).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif"])
  const responses = (await p.responses("deployment", { definition }).resolve()).definition
    .capabilities
  expect(responses.reasoning).toEqual(chat.reasoning)
  expect(responses.inputMediaTypes).toContain("application/pdf")
  const deepseek = await p.chat("deployment", { definition, profile: "deepseek" }).resolve()
  expect(deepseek.definition.capabilities.nativeStructuredOutput).toBe(false)
  const manual = (await p.messages("deployment", { definition, thinkingMode: "manual" }).resolve())
    .definition.capabilities
  expect(manual.reasoning).toEqual({ canDisable: true, budgetTokens: { min: 1024, max: 4095 } })
  const adaptive = (
    await p.messages("deployment", { definition, thinkingMode: "adaptive" }).resolve()
  ).definition.capabilities
  expect(adaptive.reasoning).toEqual({ canDisable: true, efforts: ["low", "high"] })
})

test("catalog listing and binding resolution agree on protocol capability intersection", async () => {
  const p = createAzureAIFoundry({
    endpoint: "https://example.test/api/projects/test",
    apiKey: () => "test",
    fetch: async () =>
      Response.json({
        value: [
          {
            type: "ModelDeployment",
            name: "deployment",
            modelName: "future",
            modelVersion: "1",
            modelPublisher: "partner",
            capabilities: { chat_completion: "true" },
            sku: { name: "GlobalStandard" },
          },
        ],
      }),
    catalog: {
      fetch: async () =>
        Response.json({
          azure: {
            models: {
              future: {
                id: "future",
                modalities: { input: ["text", "image", "pdf"], output: ["text"] },
                reasoning: true,
                reasoning_options: [{ type: "budget_tokens", min: 1024 }],
                provider: { npm: "@ai-sdk/openai-compatible" },
              },
            },
          },
        }),
    },
  })
  const model = await p("deployment").resolve()
  expect(model.definition.capabilities.reasoning).toEqual({})
  expect(model.definition.capabilities.inputMediaTypes).not.toContain("application/pdf")
  expect((await p.catalog.get("deployment"))?.capabilities).toEqual(model.definition.capabilities)
  await expect(
    model.stream({
      callId: "test",
      messages: [],
      tools: [],
      reasoning: { budgetTokens: 1024 },
      signal: AbortSignal.timeout(1000),
    })
  ).rejects.toThrow("budget")
})
