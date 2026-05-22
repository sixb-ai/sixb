import { defineFunction } from "@pario/core"
import { Invoice } from "../ontology/invoice"

/**
 * Periodically checks for invoices past their due date
 * and updates their status to "overdue".
 */
export const checkOverdueInvoices = defineFunction("check-overdue-invoices")
  .cron("0 8 * * *")
  .run(async ({ pario }) => {
    const { objects } = await pario.objects(Invoice).list({
      limit: 500,
      orderBy: "updatedAt",
      order: "desc",
    })

    const today = new Date().toISOString().slice(0, 10)

    for (const invoice of objects) {
      const { status, dueDate } = invoice.properties
      if (status !== "sent" || !dueDate) continue
      if (dueDate >= today) continue

      await pario.objects(Invoice).upsert({
        properties: {
          id: invoice.primaryId,
          number: invoice.properties.number,
          amount: invoice.properties.amount,
          status: "overdue",
        },
      })

      console.log(`[AcmeCorp] Invoice ${invoice.properties.number} marked as overdue`)
    }
  })
