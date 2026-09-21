import { expect, test } from "bun:test"
import {
  defineObjectType,
  type EmbeddingModel,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { ObjectQuerySchema } from "../src/schemas/objects"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const model: EmbeddingModel & { apiKey: string } = {
  providerId: "test",
  modelId: "vector",
  apiKey: "must-not-leak",
  definition: { kind: "embedding", providerId: "test", modelId: "vector", dimensions: 2 },
  async embed({ texts }) {
    return { vectors: texts.map(() => [1, 0]) }
  },
}
const Product = defineObjectType({
  id: "VectorProduct",
  name: "Product",
  properties: [prop("id", "string", { primary: true, required: true }), prop("title", "string")],
  search: { vectors: { content: { source: ["title"], model } } },
})

test("HTTP publishes named profile metadata and preserves cosine scores", async () => {
  const host = new SixbHost({
    id: "vector-http",
    ontology: [Product],
    models: { embedding: [model] },
    storage: new InMemoryStorage(),
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
  })
  const sdk = createTestSixb(host)
  await sdk.objects(Product).upsert({ properties: { id: "one", title: "Product" } })
  const profile = sdk.objects(Product).byId("one").vector("content")
  await profile.index()
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const query = {
    kind: "vector",
    input: { kind: "start", objectTypeId: Product.id },
    profile: "content",
    vector: "search",
    k: 1,
  }
  const response = await app.fetch(
    new Request("http://localhost/api/objects/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    })
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    objects: [{ primaryId: "one", score: 1 }],
    total: 1,
    hasMore: false,
  })
  const metadata = await app.fetch(new Request("http://localhost/api/object-types"))
  expect(metadata.status).toBe(200)
  const text = await metadata.text()
  expect(text).toContain('"vectors"')
  expect(text).toContain('"content"')
  expect(text).not.toContain("must-not-leak")
  expect(text).not.toContain("apiKey")
  expect(text).not.toContain("definition")
  expect(text).toContain('"dimensions":2')
})

test("wire vector queries require text and a profile and reject internal stamps", () => {
  const query = {
    kind: "vector",
    input: { kind: "start", objectTypeId: Product.id },
    profile: "content",
    vector: "search",
    k: 1,
  }
  expect(ObjectQuerySchema.safeParse(query).success).toBe(true)
  expect(ObjectQuerySchema.safeParse({ ...query, vector: [1, 0] }).success).toBe(false)
  expect(ObjectQuerySchema.safeParse({ ...query, propertyId: "raw" }).success).toBe(false)
  expect(ObjectQuerySchema.safeParse({ ...query, configuration: "forged" }).success).toBe(false)
  expect(ObjectQuerySchema.safeParse({ ...query, profile: undefined }).success).toBe(false)
  // Restoring the old property selector makes this assertion fail.
  expect(
    ObjectQuerySchema.safeParse({ ...query, profile: undefined, propertyId: "raw" }).success
  ).toBe(false)
})

test("HTTP vector search enforces AI limits before inference and exposes Retry-After", async () => {
  let calls = 0
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: "vector-limits",
    ontology: [Product],
    models: {
      embedding: [
        {
          ...model,
          embed: async () => {
            calls += 1
            return { vectors: [[1, 0]] }
          },
        },
      ],
    },
    storage,
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
  })
  await storage.aiLimits.createPolicy({
    id: "tokens",
    projectId: host.id,
    subject: { type: "project" },
    limit: { meter: "tokens.total", amount: 1 },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const response = await app.fetch(
    new Request("http://localhost/api/objects/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: {
          kind: "vector",
          input: { kind: "start", objectTypeId: Product.id },
          profile: "content",
          vector: "several tokens in the search text",
          k: 1,
        },
      }),
    })
  )
  expect(response.status).toBe(429)
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0)
  expect(await response.json()).toMatchObject({ code: "ai.usage_limit_exceeded" })
  expect(calls).toBe(0)
})
