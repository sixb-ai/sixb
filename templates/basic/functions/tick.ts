import { defineFunction } from "@pario/core"
import { Counter } from "../ontology/counter"

let count = 0

export const tick = defineFunction("tick")
  .interval(1000)
  .run(async ({ pario }) => {
    count++

    await pario.objects(Counter).upsert({
      key: "default",
      properties: { name: "My Counter" },
    })

    await pario
      .objects(Counter)
      .appendTelemetryBatch([{ key: "default", properties: { value: count }, at: new Date() }])
  })
