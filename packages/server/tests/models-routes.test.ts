import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type ModelCatalogInput,
  type OntologySource,
  prop,
  SixbHost,
} from "@sixb/core"
import { defineLanguageModel } from "@sixb/core/models"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

type TestLanguageModel = ModelCatalogInput["language"][number]

// The route only serializes catalog metadata, so a minimal owned-contract stub is enough.
function testModel(providerId: string, modelId: string): TestLanguageModel {
  return {
    providerId,
    modelId,
    definition: defineLanguageModel({ kind: "language", providerId, modelId, capabilities: {} }),
    async stream() {
      throw new Error("Route tests do not run inference.")
    },
  }
}

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

function createApp(models?: ModelCatalogInput) {
  const sixb = new SixbHost<readonly OntologySource[]>({
    id: "model-route-tests",
    ontology: [Invoice],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    models,
  })

  return createSixbApi(
    new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
  )
}

describe("GET /api/models", () => {
  test("lists the configured language models with the default flagged", async () => {
    const app = createApp({
      language: [
        testModel("gateway", "openai/gpt-5.4"),
        testModel("gateway", "anthropic/claude-sonnet-4.6"),
      ],
    })

    const response = await app.fetch(new Request("http://localhost/api/models"))
    expect(response.status).toBe(200)

    expect(await response.json()).toEqual({
      language: [
        { provider: "gateway", modelId: "openai/gpt-5.4", isDefault: true },
        { provider: "gateway", modelId: "anthropic/claude-sonnet-4.6", isDefault: false },
      ],
    })
  })

  test("returns an empty catalog when the project configures no models", async () => {
    const app = createApp()

    const response = await app.fetch(new Request("http://localhost/api/models"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ language: [] })
  })
})
