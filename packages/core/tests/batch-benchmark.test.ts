import { describe, test } from "bun:test"
import { defineObjectType, prop } from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Item = defineObjectType({
  id: "item",
  name: "Item",
  properties: [prop("id", "string", { required: true, primary: true }), prop("label", "string")],
})

// Every write is one Materializer commit, and the in-memory provider snapshots its whole store per
// transaction. The individual path therefore pays that snapshot once per object, which is exactly the
// cost this comparison exists to show — kept small enough to stay a fast, informative signal.
const ITEM_COUNT = 200

describe("batch-benchmark (informative)", () => {
  test(`${ITEM_COUNT} objects — individual vs batch`, async () => {
    const items = Array.from({ length: ITEM_COUNT }, (_, i) => ({
      properties: { id: `item-${i}`, label: `Label ${i}` },
    }))

    // Individual upserts
    const depsIndividual = createTestRuntimeDeps()
    const sixbIndividual = createTestSixb({ ontology: [Item], ...depsIndividual })

    const startIndividual = performance.now()
    for (const item of items) {
      await sixbIndividual.objects.upsert("item", item.properties)
    }
    const durationIndividual = performance.now() - startIndividual

    // Batch upsert
    const depsBatch = createTestRuntimeDeps()
    const sixbBatch = createTestSixb({ ontology: [Item], ...depsBatch })

    const startBatch = performance.now()
    await sixbBatch.objects.upsertBatch("item", items)
    const durationBatch = performance.now() - startBatch

    const ratio = durationIndividual / durationBatch
    console.log(
      `  Individual: ${durationIndividual.toFixed(1)}ms | Batch: ${durationBatch.toFixed(1)}ms | Ratio: ${ratio.toFixed(1)}x`
    )
  })
})
