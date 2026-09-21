import { expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  type EmbeddingModel,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { ProjectionRunDispatcher } from "@sixb/core/internal/projections"
import { createTestSixb } from "@sixb/core/testing"
import { ProjectionWorker } from "../src"

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean) {
  const deadline = Date.now() + 4000
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() > deadline) throw new Error("Timed out")
    await Bun.sleep(10)
  }
}

test("projection completion is independent of inference; the same worker maintains vectors", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    async embed({ texts }) {
      calls++
      entered.resolve()
      await release.promise
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
  const dataset = defineDataset("products", {
    schema: [col("id", "string"), col("description", "string")],
  })
  const projection = defineProjection("products", Product)
    .fromDataset(dataset)
    .properties({ id: "id", description: "description" })
  const storage = new InMemoryStorage()
  const lakeStorage = new InMemoryLakeStorage()
  const host = new SixbHost({
    id: "worker-indexing",
    ontology: [Product],
    datasets: [dataset],
    projections: [projection],
    models: { embedding: [model] },
    storage,
    lakeStorage,
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const worker = new ProjectionWorker(host)
  try {
    await lakeStorage.createDataset(dataset)
    const write = await lakeStorage.beginWrite({
      dataset,
      mode: "snapshot",
      producer: { kind: "sync", id: "test", runId: "sync" },
    })
    await write.writeRows([{ id: "p", description: "first" }])
    const version = await write.commit({ commitMessage: "test" })
    await new ProjectionRunDispatcher(host).dispatch({
      projectionId: projection.id,
      datasetVersion: {
        datasetId: version.datasetId,
        versionId: version.versionId,
        createdAt: version.createdAt.toISOString(),
      },
    })
    await worker.start()
    await entered.promise
    const runs = await storage.projectionRuns.list({ projectId: host.id })
    expect(runs.runs[0]?.status).toBe("succeeded")
    expect(
      await storage.ontology.vectors!.list({
        projectId: host.id,
        ref: { objectTypeId: "Product", primaryId: "p" },
      })
    ).toHaveLength(0)
    release.resolve()
    await waitFor(
      () =>
        storage.ontology.vectors!.list({
          projectId: host.id,
          ref: { objectTypeId: "Product", primaryId: "p" },
        }),
      (entries) => entries.length === 1
    )
    expect(calls).toBe(1)
    // A winning managed edit uses the same materializer hook as projections.
    await createTestSixb(host)
      .objects(Product)
      .upsert({ properties: { id: "p", description: "second" } })
    await waitFor(
      async () => calls,
      (n) => n === 2
    )
    await waitFor(
      () =>
        storage.ontology.vectors!.list({
          projectId: host.id,
          ref: { objectTypeId: "Product", primaryId: "p" },
        }),
      (entries) => entries.length === 1
    )
  } finally {
    release.resolve()
    await worker.stop()
    await host.closeBroker()
  }
}, 10000)
