import { defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const markPaid = defineAction("markPaid", {
  description: "Mark this invoice as paid.",
})
  .target(Invoice)
  .params({})
  .edits(({ edit, target }) => {
    edit.set(target, {
      status: "paid",
    })
  })
