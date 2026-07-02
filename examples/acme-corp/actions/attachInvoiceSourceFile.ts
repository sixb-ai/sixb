import { defineAction, optional, param } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const attachInvoiceSourceFile = defineAction("attachInvoiceSourceFile", {
  description: "Attach an uploaded invoice PDF or supporting file to this invoice.",
})
  .on(Invoice)
  .params({
    sourceFile: param("fileRef", {
      description: "Upload the invoice PDF or source document to store on this invoice.",
    }),
    note: optional(param("string", { description: "Optional note about the uploaded file." })),
  })
  .edits(({ objects, params, run, subject }) => {
    objects(Invoice)
      .byId(subject.primaryId)
      .update({
        sourceFile: params.sourceFile,
        sourceFileAttachedAt: run.startedAt.toISOString(),
        ...(params.note ? { sourceFileNote: params.note } : {}),
      })
  })
