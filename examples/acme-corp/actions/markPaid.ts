import { defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const markPaid = defineAction("markPaid", {
  description: "Mark this invoice as paid.",
})
  .target(Invoice)
  .params({})
  .run(async ({ target, sixb }) => {
    await sixb.objects(Invoice).upsert({
      properties: {
        ...target.properties,
        id: target.primaryId,
        status: "paid",
      },
    })
  })
