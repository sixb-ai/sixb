import {
  defineIntervention,
  defineWorkflow,
  defineWorkflowStep,
  interventionField,
  ref,
} from "@sixb/core"
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
  .run(async ({ input, sixb }) => {
    await wait(650)

    const invoice = await sixb.objects(Invoice).get(input.invoice.primaryId)
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
  .run(async ({ input, sixb }) => {
    await wait(750)

    const message =
      input.urgency === "high"
        ? `Invoice ${input.invoiceNumber} for ${input.amountLabel} is overdue. Please review and submit payment.`
        : `Please review invoice ${input.invoiceNumber} for ${input.amountLabel} and submit payment when convenient.`
    const invoice = await sixb.objects(Invoice).get(input.invoice.primaryId)
    if (!invoice) {
      throw new Error(`[AcmeCorp] Invoice '${input.invoice.primaryId}' was not found.`)
    }

    // Business review state stays on the invoice; workflow interventions only track the runtime
    // pause and submitted response.
    await sixb.objects(Invoice).upsert({
      properties: {
        ...invoice.properties,
        id: invoice.primaryId,
        reminderReviewStatus: "needs_review",
        reminderReviewRequestedAt: new Date().toISOString(),
      },
    })

    return {
      invoice: input.invoice,
      message,
      channel: input.channel,
      deliveryBatchId: `reminder-${new Date().toISOString()}`,
    }
  })

export const reviewInvoiceReminder = defineIntervention("review-invoice-reminder", {
  description: "Approve or request changes before sending the invoice reminder.",
})
  .input({
    invoice: ref(Invoice),
    message: "string",
    channel: "string",
    deliveryBatchId: "string",
  })
  .response({
    approved: interventionField("boolean", { required: true }),
    message: interventionField("string", { required: true }),
    reviewerNote: interventionField("string", { required: false }),
  })
  .defaults(({ input }) => ({
    approved: true,
    message: input.message,
  }))

export const invoiceReminderWorkflow = defineWorkflow("invoice-reminder-workflow")
  .input({
    invoice: ref(Invoice),
  })
  .then(loadInvoiceContext)
  .then(evaluateReminderPolicy)
  .then(composeInvoiceReminder)
  .then(reviewInvoiceReminder)
  .then(sendReminder, ({ steps }) => ({
    subject: steps.composeInvoiceReminder.invoice,
    params: {
      approved: steps.reviewInvoiceReminder.approved,
      message: steps.reviewInvoiceReminder.message,
      reviewerNote: steps.reviewInvoiceReminder.reviewerNote,
    },
  }))

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
