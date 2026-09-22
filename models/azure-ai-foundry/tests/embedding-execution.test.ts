import { expect, test } from "bun:test"
import { defineObjectType, prop, SixbHost } from "@sixb/core"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { createTestRuntimeDeps } from "../../../packages/core/tests/test-runtime-deps"
import { createAzureAIFoundry } from "../src"

// Regression proof: give runtime/host.ts its raw embedding catalog instead of the scoped
// binding. Index and search still produce vectors, but their usage and costs disappear.
test("Foundry indexing and text search record usage and enforce limits through Sixb", async () => {
  let calls = 0
  const foundry = createAzureAIFoundry({
    endpoint: "https://resource.services.ai.azure.com/api/projects/test",
    apiKey: "project-key",
    fetch: async () =>
      Response.json({
        value: [
          {
            type: "ModelDeployment",
            name: "products",
            modelName: "text-embedding-3-small",
            modelVersion: "1",
            modelPublisher: "OpenAI",
            capabilities: { embeddings: "true" },
            sku: { name: "GlobalStandard" },
          },
        ],
      }),
    embeddings: {
      endpoint: "https://resource.openai.azure.com/openai/v1",
      apiKey: "resource-key",
      fetch: async () => {
        calls++
        return Response.json({
          model: "text-embedding-3-small",
          data: [{ index: 0, embedding: [1, 0] }],
          usage: { prompt_tokens: 12, total_tokens: 12 },
        })
      },
    },
    catalog: {
      fetch: async () =>
        Response.json({
          azure: {
            models: {
              "text-embedding-3-small": {
                id: "text-embedding-3-small",
                family: "text-embedding",
                modalities: { output: ["text"] },
                cost: { input: 0.02, output: 0 },
              },
            },
          },
        }),
    },
  })
  const model = foundry.embedding("products", {
    model: { name: "text-embedding-3-small", version: "1" },
    dimensions: 2,
  })
  const Product = defineObjectType({
    id: "Product",
    name: "Product",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      prop("description", "string"),
    ],
    search: { vectors: { content: { source: ["description"], model } } },
  })
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "foundry-test",
    ontology: [Product],
    models: { embedding: [model] },
    ...deps,
  })
  const sixb = bindRequestExecution(host, {
    request: new Request("http://localhost/search"),
    authorization: { type: "disabled" },
  })
  const objects = sixb.objects(Product)
  await objects.upsert({ properties: { id: "p", description: "running shoes" } })
  await objects.byId("p").vector("content").index()
  const result = await objects.query().vector("content", "running", { k: 1 }).list()
  expect(result.objects).toHaveLength(1)
  expect(calls).toBe(2)
  expect(
    await deps.storage.aiUsage.summarizeExecution({
      projectId: host.id,
      executionId: sixb.execution.id,
    })
  ).toMatchObject({ modelCallCount: 2, usage: { inputTokens: 24, outputTokens: 0 } })
  const ledger = await deps.storage.aiCosts.listModelCalls({
    projectId: host.id,
    from: new Date("2000-01-01"),
    to: new Date("2100-01-01"),
  })
  expect(ledger.items).toHaveLength(2)
  expect(ledger.items[0]!.cost).toMatchObject({ status: "rated" })
  await deps.storage.aiLimits.createPolicy({
    id: "budget",
    projectId: host.id,
    subject: { type: "project" },
    limit: { meter: "tokens.total", amount: 1 },
  })
  await expect(objects.query().vector("content", "running", { k: 1 }).list()).rejects.toThrow()
  expect(calls).toBe(2)
})
