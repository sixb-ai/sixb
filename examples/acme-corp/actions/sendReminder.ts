import { actionParam, defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const sendReminder = defineAction("sendReminder", {
  description: "Send a payment reminder to the customer.",
})
  .target(Invoice)
  .params({
    approved: actionParam("boolean", { required: true }),
    message: actionParam("string", { required: true }),
    reviewerNote: actionParam("string"),
  })
  .run(async ({ params, target, sixb }) => {
    const reviewedAt = new Date().toISOString()

    if (!params.approved) {
      console.log(`[AcmeCorp] Reminder changes requested for invoice ${target.properties.number}.`)

      await sixb.objects(Invoice).upsert({
        properties: {
          ...target.properties,
          id: target.primaryId,
          reminderReviewStatus: "revision_requested",
          reminderReviewedAt: reviewedAt,
          reminderReviewerNote: params.reviewerNote,
        },
      })
      return
    }

    console.log(
      `[AcmeCorp] Reminder approved for invoice ${target.properties.number}: ${params.message}`
    )

    await sixb.objects(Invoice).upsert({
      properties: {
        ...target.properties,
        id: target.primaryId,
        status: "sent",
        reminderReviewStatus: "approved",
        reminderReviewedAt: reviewedAt,
        reminderReviewerNote: params.reviewerNote,
      },
    })
  })
