import { defineAction } from "@sixb/core"
import { Counter } from "../ontology/counter"

export const increment = defineAction("increment")
  .params({})
  .edits(async ({ objects, read }) => {
    const current = await read.objects(Counter).get("default")

    if (!current) {
      objects(Counter).create({ id: "default", name: "My Counter", value: 1 })
      return
    }

    const value = current.properties.value
    objects(Counter)
      .byId(current.primaryId)
      .update({ value: (typeof value === "number" ? value : 0) + 1 })
  })
