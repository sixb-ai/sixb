import { defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const markPaid = defineAction("markPaid", {
  description: "Mark this invoice as paid.",
})
  .on(Invoice)
  .params({})
  .edits(({ objects, subject }) => {
    objects(Invoice).byId(subject.primaryId).update({
      status: "paid",
    })
  })
