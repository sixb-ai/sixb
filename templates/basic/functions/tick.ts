import { defineFunction } from "@sixb/core"
import { Counter } from "../ontology/counter"

let count = 0

export const tick = defineFunction("tick")
  .interval(1000)
  .run(async ({ sixb }) => {
    count++

    await sixb.objects(Counter).upsert({
      properties: { id: "default", name: "My Counter" },
    })

    await sixb
      .objects(Counter)
      .appendTelemetryBatch([{ id: "default", properties: { value: count }, at: new Date() }])
  })
