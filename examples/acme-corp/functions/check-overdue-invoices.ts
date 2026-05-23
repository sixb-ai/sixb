import { defineFunction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

/**
 * Periodically checks for invoices past their due date
 * and updates their status to "overdue".
 */
export const checkOverdueInvoices = defineFunction("check-overdue-invoices")
  .cron("0 8 * * *")
  .run(async ({ sixb }) => {
    const { objects } = await sixb.objects(Invoice).list({
      limit: 500,
      orderBy: "updatedAt",
      order: "desc",
    })

    const today = new Date().toISOString().slice(0, 10)

    for (const invoice of objects) {
      const { status, dueDate } = invoice.properties
      if (status !== "sent" || !dueDate) continue
      if (dueDate >= today) continue

      await sixb.objects(Invoice).upsert({
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
