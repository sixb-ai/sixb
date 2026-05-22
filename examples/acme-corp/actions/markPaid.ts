import { defineAction } from "@pario/core"
import { Invoice } from "../ontology/invoice"

export const markPaid = defineAction("markPaid", {
  description: "Mark this invoice as paid.",
})
  .target(Invoice)
  .params({})
  .run(async ({ target, pario }) => {
    await pario.objects(Invoice).upsert({
      properties: {
        ...target.properties,
        id: target.primaryId,
        status: "paid",
      },
    })
  })
