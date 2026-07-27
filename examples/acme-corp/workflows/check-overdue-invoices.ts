import { defineWorkflow, defineWorkflowStep } from "@sixb/core"
import { Invoice } from "../ontology/invoice"
import { overdueInvoicesSchedule } from "../schedules/overdue-invoices"

const markOverdueInvoices = defineWorkflowStep("mark-overdue-invoices")
  .input({})
  .output({})
  .run(async ({ sixb, logger }) => {
    const { objects } = await sixb.objects(Invoice).list({
      limit: 500,
      orderBy: "updatedAt",
      order: "desc",
    })
    const today = new Date().toISOString().slice(0, 10)

    for (const invoice of objects) {
      const { status, dueDate } = invoice.properties
      if (status !== "sent" || !dueDate || dueDate >= today) continue

      await sixb.objects(Invoice).upsert({
        properties: {
          ...invoice.properties,
          id: invoice.primaryId,
          status: "overdue",
        },
      })
      logger.info("Invoice marked as overdue", {
        invoiceId: invoice.primaryId,
        invoiceNumber: invoice.properties.number,
      })
    }

    return {}
  })

export const checkOverdueInvoices = defineWorkflow("check-overdue-invoices")
  .input({})
  .when(overdueInvoicesSchedule)
  .then(markOverdueInvoices)
