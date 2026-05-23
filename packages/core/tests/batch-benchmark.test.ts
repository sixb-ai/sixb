import { describe, test } from "bun:test"
import { defineObjectType, prop, Sixb } from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Item = defineObjectType({
  id: "item",
  name: "Item",
  properties: [prop("id", "string", { required: true, primary: true }), prop("label", "string")],
})

describe("batch-benchmark (informative)", () => {
  test("1000 objects — individual vs batch", async () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({
      properties: { id: `item-${i}`, label: `Label ${i}` },
    }))

    // Individual upserts
    const depsIndividual = createTestRuntimeDeps()
    const sixbIndividual = new Sixb({ ontology: [Item], ...depsIndividual })

    const startIndividual = performance.now()
    for (const item of items) {
      await sixbIndividual.upsertObject("item", item.properties)
    }
    const durationIndividual = performance.now() - startIndividual

    // Batch upsert
    const depsBatch = createTestRuntimeDeps()
    const sixbBatch = new Sixb({ ontology: [Item], ...depsBatch })

    const startBatch = performance.now()
    await sixbBatch.upsertObjectBatch("item", items)
    const durationBatch = performance.now() - startBatch

    const ratio = durationIndividual / durationBatch
    console.log(
      `  Individual: ${durationIndividual.toFixed(1)}ms | Batch: ${durationBatch.toFixed(1)}ms | Ratio: ${ratio.toFixed(1)}x`
    )
  })
})
