import { actionParam, defineAction } from "@pario/core"
import { Invoice } from "../ontology/invoice"

export const sendReminder = defineAction("sendReminder", {
  description: "Send a payment reminder to the customer.",
})
  .target(Invoice)
  .params({ message: actionParam("string") })
  .run(async ({ params, target, pario }) => {
    console.log(
      `[AcmeCorp] Reminder requested for invoice ${target.properties.number}: ${params.message ?? ""}`
    )

    await pario.objects(Invoice).upsert({
      properties: {
        ...target.properties,
        id: target.primaryId,
        status: "sent",
      },
    })
  })
