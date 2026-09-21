import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defineObjectType,
  type EmbeddingModel,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  migrateStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { getVectorIndexingRuntime } from "@sixb/core/internal/runtime"
import { createTestSixb, type TestExecutionHost } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

test("durable indexing intent and ready results survive SQLite reopening", async () => {
  const path = await mkdtemp(join(tmpdir(), "sixb-indexing-"))
  let storage = new SqliteStorage({ path })
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
  const hostFor = () =>
    new SixbHost({
      id: "indexing",
      ontology: [Product],
      models: { embedding: [model] },
      storage,
      broker: new InMemoryBroker(),
      blobStorage: new InMemoryBlobStorage(),
      lakeStorage: new InMemoryLakeStorage(),
      queues: new InMemoryQueues(),
    })
  let host: (TestExecutionHost & { closeBroker(): Promise<void> }) | undefined
  try {
    await migrateStorage(storage)
    host = hostFor()
    await host.closeBroker()
    await createTestSixb(host)
      .objects(Product)
      .upsert({ properties: { id: "p", description: "source" } })
    const [work] = await storage.ontology.vectorIndexing.listDue({
      projectId: host.id,
      now: "2100-01-01T00:00:00.000Z",
      limit: 10,
    })
    expect(work).toMatchObject({ status: "pending", profile: "content" })
    await storage.close()
    storage = new SqliteStorage({ path })
    host = hostFor()
    await host.closeBroker()
    await getVectorIndexingRuntime(host).process(work!.id, 1, new AbortController().signal)
    expect(calls).toBe(1)
    expect(
      await storage.ontology.vectors.list({ projectId: host.id, ref: work!.ref })
    ).toHaveLength(1)
    const execution = await storage.executions.getById({
      projectId: host.id,
      id: `exec_vector_${work!.id}`,
    })
    expect(execution).toMatchObject({
      source: { type: "ontologyCommit", commitId: work!.sourceCommitId },
      requesterGroupIds: [],
    })
    await createTestSixb(host)
      .objects(Product)
      .upsert({ properties: { id: "p", description: "changed" } })
    const [next] = await storage.ontology.vectorIndexing.listDue({
      projectId: host.id,
      now: "2100-01-01T00:00:00.000Z",
      limit: 10,
    })
    await storage.ontology.vectorIndexing.update({
      projectId: host.id,
      id: next!.id,
      expectedStatus: "pending",
      status: "ready",
      availableAt: new Date().toISOString(),
      values: [1, 0],
    })
    await storage.close()
    storage = new SqliteStorage({ path })
    host = hostFor()
    await host.closeBroker()
    await getVectorIndexingRuntime(host).process(next!.id, 2, new AbortController().signal)
    expect(calls).toBe(1)
    expect(
      await storage.ontology.vectorIndexing.get({ projectId: host.id, id: next!.id })
    ).toBeNull()
    expect(
      await storage.ontology.vectors.list({ projectId: host.id, ref: next!.ref })
    ).toHaveLength(1)
    await createTestSixb(host)
      .objects(Product)
      .upsert({ properties: { id: "p", description: "failed-source" } })
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
  } finally {
    await host?.closeBroker()
    await storage.close()
    await rm(path, { recursive: true, force: true })
  }
})
