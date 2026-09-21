import { expect, test } from "bun:test"
import {
  defineObjectType,
  type EmbeddingModel,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  prop,
  SixbHost,
} from "@sixb/core"
import { getVectorIndexingRuntime } from "@sixb/core/internal/runtime"
import { createTestSixb } from "@sixb/core/testing"
import { quoteIdent } from "../src/migrations"
import { createPgClient } from "../src/pg-client"
import { createTestStorage } from "./helpers"

test("PostgreSQL persists coalesced indexing and project-accounted vector commits", async () => {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({ connectionString: process.env.DATABASE_URL!, schemaName, max: 2 })
  let calls = 0
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    async embed({ texts }) {
      calls++
      return { vectors: texts.map(() => [1, 0]), usage: { inputTokens: 10 } }
    },
  }
  const Product = defineObjectType({
    id: "Product",
    name: "Product",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      prop("description", "string"),
    ],
    search: { vectors: { content: { source: ["description"], model } } },
  })
  const host = new SixbHost({
    id: "indexing",
    ontology: [Product],
    models: { embedding: [model] },
    storage,
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
  })
  try {
    await host.closeBroker()
    const objects = createTestSixb(host).objects(Product)
    await objects.upsert({ properties: { id: "p", description: "first" } })
    const [old] = await storage.ontology.vectorIndexing.listDue({
      projectId: host.id,
      now: "2100-01-01T00:00:00.000Z",
      limit: 10,
    })
    await objects.upsert({ properties: { id: "p", description: "second" } })
    const [work] = await storage.ontology.vectorIndexing.listDue({
      projectId: host.id,
      now: "2100-01-01T00:00:00.000Z",
      limit: 10,
    })
    expect(work!.id).not.toBe(old!.id)
    const indexer = getVectorIndexingRuntime(host)
    await indexer.process(old!.id, 1, new AbortController().signal)
    expect(calls).toBe(0)
    await storage.ontology.vectorIndexing.dispatched({
      projectId: host.id,
      ids: [work!.id],
      nextDispatchAt: "2100-01-01T00:00:00.000Z",
    })
    expect(
      await storage.ontology.vectorIndexing.listDue({
        projectId: host.id,
        now: new Date().toISOString(),
        limit: 10,
      })
    ).toHaveLength(0)
    await indexer.process(work!.id, 1, new AbortController().signal)
    expect(calls).toBe(1)
    expect(
      await storage.ontology.vectors.list({ projectId: host.id, ref: work!.ref })
    ).toHaveLength(1)
    expect(
      await storage.executions.getById({ projectId: host.id, id: `exec_vector_${work!.id}` })
    ).toMatchObject({
      source: { type: "ontologyCommit", commitId: work!.sourceCommitId },
      requesterGroupIds: [],
    })
    expect(
      await storage.ontology.vectorIndexing.get({ projectId: host.id, id: work!.id })
    ).toBeNull()
    await objects.upsert({ properties: { id: "p", description: "third" } })
    const [failed] = await storage.ontology.vectorIndexing.listDue({
      projectId: host.id,
      now: "2100-01-01T00:00:00.000Z",
      limit: 10,
    })
    const failure = {
      code: "vector.outcome_unknown" as const,
      retryable: false,
      message: "test failure",
      at: new Date().toISOString(),
    }
    await storage.ontology.vectorIndexing.update({
      projectId: host.id,
      id: failed!.id,
      expectedStatus: "pending",
      status: "failed",
      availableAt: failure.at,
      error: failure,
    })
    expect(
      await storage.ontology.vectorIndexing.get({ projectId: host.id, id: failed!.id })
    ).toMatchObject({ status: "failed", error: failure })
    await objects.byId("p").delete()
    expect(
      await storage.ontology.vectorIndexing.listDue({
        projectId: host.id,
        now: "2100-01-01T00:00:00.000Z",
        limit: 10,
      })
    ).toHaveLength(0)
  } finally {
    await host.closeBroker()
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`)
    await sql.end()
    await storage.close()
  }
})
