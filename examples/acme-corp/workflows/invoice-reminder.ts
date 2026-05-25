import { defineWorkflow, defineWorkflowStep, ref } from "@pario/core"
import { sendReminder } from "../actions/sendReminder"
import { Invoice } from "../ontology/invoice"

const loadInvoiceContext = defineWorkflowStep("load-invoice-context")
  .input({
    invoice: ref(Invoice),
  })
  .output({
    invoice: ref(Invoice),
    invoiceNumber: "string",
    amountLabel: "string",
    status: "string",
  })
  .run(async ({ input, pario }) => {
    await wait(650)

    const invoice = await pario.objects(Invoice).get(input.invoice.primaryId)
    if (!invoice) {
      throw new Error(`[AcmeCorp] Invoice '${input.invoice.primaryId}' was not found.`)
    }

    const amount = Number(invoice.properties.amount ?? 0)
    const currency = String(invoice.properties.currency ?? "USD")

    return {
      invoice: input.invoice,
      invoiceNumber: String(invoice.properties.number ?? invoice.primaryId),
      amountLabel: `${currency} ${amount.toLocaleString("en-US", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      })}`,
      status: String(invoice.properties.status ?? "unknown"),
    }
  })

const evaluateReminderPolicy = defineWorkflowStep("evaluate-reminder-policy")
  .input({
    invoice: ref(Invoice),
    invoiceNumber: "string",
    amountLabel: "string",
    status: "string",
  })
  .output({
    invoice: ref(Invoice),
    invoiceNumber: "string",
    amountLabel: "string",
    channel: "string",
    urgency: "string",
  })
  .run(async ({ input }) => {
    await wait(900)

    const overdue = input.status === "overdue"

    return {
      invoice: input.invoice,
      invoiceNumber: input.invoiceNumber,
      amountLabel: input.amountLabel,
      channel: overdue ? "email-priority" : "email-standard",
      urgency: overdue ? "high" : "normal",
    }
  })

const composeInvoiceReminder = defineWorkflowStep("compose-invoice-reminder")
  .input({
    invoice: ref(Invoice),
    invoiceNumber: "string",
    amountLabel: "string",
    channel: "string",
    urgency: "string",
  })
  .output({
    invoice: ref(Invoice),
    message: "string",
    channel: "string",
    deliveryBatchId: "string",
  })
  .run(async ({ input }) => {
    await wait(750)

    return {
      invoice: input.invoice,
      message:
        input.urgency === "high"
          ? `Invoice ${input.invoiceNumber} for ${input.amountLabel} is overdue. Please review and submit payment.`
          : `Please review invoice ${input.invoiceNumber} for ${input.amountLabel} and submit payment when convenient.`,
      channel: input.channel,
      deliveryBatchId: `reminder-${new Date().toISOString()}`,
    }
  })

export const invoiceReminderWorkflow = defineWorkflow("invoice-reminder-workflow")
  .input({
    invoice: ref(Invoice),
  })
  .then(loadInvoiceContext)
  .then(evaluateReminderPolicy)
  .then(composeInvoiceReminder)
  .then(sendReminder, ({ steps }) => ({
    target: steps.composeInvoiceReminder.invoice,
    params: {
      message: steps.composeInvoiceReminder.message,
    },
  }))

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
