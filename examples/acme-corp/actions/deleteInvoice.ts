import { defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const deleteInvoice = defineAction("deleteInvoice", {
  description: "Delete this invoice and its incident links.",
})
  .on(Invoice)
  .params({})
  .edits(({ objects, subject }) => {
    objects(Invoice).byId(subject.primaryId).delete()
  })
