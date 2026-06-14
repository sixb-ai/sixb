import { defineAction, optional, param } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const sendReminder = defineAction("sendReminder", {
  description: "Send a payment reminder to the customer.",
})
  .target(Invoice)
  .params({
    approved: param("boolean"),
    message: param("string"),
    reviewerNote: optional(param("string")),
  })
  .edits(async ({ edit, params, read, target }) => {
    const reviewedAt = new Date().toISOString()
    const invoice = await read.objects(Invoice).get(target.primaryId)

    if (!invoice) {
      throw new Error(`Invoice '${target.primaryId}' not found.`)
    }

    if (!params.approved) {
      console.log(`[AcmeCorp] Reminder changes requested for invoice ${invoice.properties.number}.`)

      edit.set(target, {
        reminderReviewStatus: "revision_requested",
        reminderReviewedAt: reviewedAt,
        reminderReviewerNote: params.reviewerNote,
      })
      return
    }

    console.log(
      `[AcmeCorp] Reminder approved for invoice ${invoice.properties.number}: ${params.message}`
    )

    edit.set(target, {
      status: "sent",
      reminderReviewStatus: "approved",
      reminderReviewedAt: reviewedAt,
      reminderReviewerNote: params.reviewerNote,
    })
  })
