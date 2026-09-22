import { expect, spyOn, test } from "bun:test"
import { defineObjectType, type EmbeddingModel } from "../src"
import { InMemoryOntologyVectorStorage } from "../src/storage/ontology/in-memory/vectors"
import { createTestSixb } from "../src/testing"
import { createMaterializerFixture, Device, replacement, sourceEntry } from "./materializer-fixture"
import { createTestRuntimeDeps } from "./test-runtime-deps"

test("one projection page reads vector metadata once, even without declared profiles", async () => {
  // Removal proof: use vectors.list per item in invalidateVectorChanges; this counts 20 reads.
  const f = createMaterializerFixture()
  const read = spyOn(InMemoryOntologyVectorStorage.prototype, "listBatch")
  try {
    await f.materializer.projections.replace(
      replacement(
        "v1",
        "2026-01-01",
        Array.from({ length: 20 }, (_, i) => sourceEntry(String(i), String(i)))
      )
    )
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![0].refs).toHaveLength(20)
  } finally {
    read.mockRestore()
  }
})

test("source edits still invalidate stored vectors after a profile is removed", async () => {
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "test",
    definition: { kind: "embedding", providerId: "test", modelId: "test", dimensions: 2 },
    async embed() {
      return { vectors: [[1, 0]] }
    },
  }
  const WithProfile = defineObjectType({
    ...Device,
    search: { vectors: { content: { source: ["name"], model } } },
  })
  const deps = createTestRuntimeDeps()
  const objects = createTestSixb({
    id: "removed",
    ontology: [WithProfile],
    models: { embedding: [model] },
    ...deps,
  }).objects(WithProfile)
  await objects.upsert({ properties: { id: "a", name: "Before" } })
  await objects.byId("a").vector("content").index()
  const read = () =>
    deps.storage.ontology.vectors!.list({
      projectId: "removed",
      ref: { objectTypeId: Device.id, primaryId: "a" },
    })
  expect(await read()).toHaveLength(1)
  const without = createTestSixb({ id: "removed", ontology: [Device], ...deps }).objects(Device)
  await without.upsert({ properties: { id: "a", name: "After" } })
  expect(await read()).toEqual([])
})
