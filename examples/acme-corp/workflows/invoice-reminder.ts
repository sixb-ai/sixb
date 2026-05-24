import { defineWorkflow, defineWorkflowStep, ref } from "@pario/core"
import { sendReminder } from "../actions/sendReminder"
import { Invoice } from "../ontology/invoice"

const prepareInvoiceReminder = defineWorkflowStep("prepare-invoice-reminder")
  .input({
    invoice: ref(Invoice),
  })
  .output({
    invoice: ref(Invoice),
    message: "string",
  })
  .run(({ input }) => ({
    invoice: input.invoice,
    message: "Please review this invoice and submit payment when convenient.",
  }))

export const invoiceReminderWorkflow = defineWorkflow("invoice-reminder-workflow")
  .input({
    invoice: ref(Invoice),
  })
  .then(prepareInvoiceReminder)
  .then(sendReminder, ({ steps }) => ({
    target: steps.prepareInvoiceReminder.invoice,
    params: {
      message: steps.prepareInvoiceReminder.message,
    },
  }))
