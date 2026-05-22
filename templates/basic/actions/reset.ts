import { defineAction } from "@pario/core"
import { Counter } from "../ontology/counter"

export const reset = defineAction("reset")
  .target(Counter)
  .params({})
  .run(async ({ target, pario }) => {
    await pario
      .objects(Counter)
      .appendTelemetryBatch([{ id: target.primaryId, properties: { value: 0 }, at: new Date() }])
  })
