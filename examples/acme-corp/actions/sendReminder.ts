import { defineAction, optional, param } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const sendReminder = defineAction("sendReminder", {
  description: "Send a payment reminder to the customer.",
})
  .on(Invoice)
  .params({
    approved: param("boolean"),
    message: param("string"),
    reviewerNote: optional(param("string")),
  })
  .edits(async ({ objects, params, read, subject }) => {
    const reviewedAt = new Date().toISOString()
    const invoice = await read.objects(Invoice).get(subject.primaryId)

    if (!invoice) {
      throw new Error(`Invoice '${subject.primaryId}' not found.`)
    }

    if (!params.approved) {
      console.log(`[AcmeCorp] Reminder changes requested for invoice ${invoice.properties.number}.`)

      objects(Invoice).byId(subject.primaryId).update({
        reminderReviewStatus: "revision_requested",
        reminderReviewedAt: reviewedAt,
        reminderReviewerNote: params.reviewerNote,
      })
      return
    }

    console.log(
      `[AcmeCorp] Reminder approved for invoice ${invoice.properties.number}: ${params.message}`
    )

    objects(Invoice).byId(subject.primaryId).update({
      status: "sent",
      reminderReviewStatus: "approved",
      reminderReviewedAt: reviewedAt,
      reminderReviewerNote: params.reviewerNote,
    })
  })
