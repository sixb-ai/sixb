import { defineAction } from "@sixb/core"
import { Counter } from "../ontology/counter"

export const reset = defineAction("reset")
  .target(Counter)
  .params({})
  .run(async ({ target, sixb }) => {
    await sixb
      .objects(Counter)
      .appendTelemetryBatch([{ id: target.primaryId, properties: { value: 0 }, at: new Date() }])
  })
