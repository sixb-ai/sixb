import { defineAction, optional, param } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const markPaid = defineAction("markPaid", {
  description: "Mark this invoice as paid.",
})
  .on(Invoice)
  .params({
    paymentMethod: optional(param("string")),
    paymentReference: optional(param("string")),
  })
  .edits(({ objects, params, run, subject }) => {
    objects(Invoice)
      .byId(subject.primaryId)
      .update({
        status: "paid",
        paymentInfo: {
          method: params.paymentMethod ?? "manual",
          reference: params.paymentReference ?? `manual:${subject.primaryId}`,
          recordedAt: run.startedAt.toISOString(),
        },
      })
  })
