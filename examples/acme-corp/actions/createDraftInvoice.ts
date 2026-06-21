import { defineAction, optional, param, ref } from "@sixb/core"
import { stringEnum } from "@sixb/core/ontology"
import { Customer } from "../ontology/customer"
import { Invoice } from "../ontology/invoice"
import { Project } from "../ontology/project"

export const createDraftInvoice = defineAction("createDraftInvoice", {
  description: "Create a draft invoice and attach it to a customer and project.",
})
  .params({
    id: param("string"),
    number: param("string"),
    amount: param("double"),
    currency: optional(param(stringEnum(["EUR", "USD", "GBP"]))),
    customer: param(ref(Customer), { description: "Customer to bill." }),
    project: param(ref(Project), { description: "Project the invoice belongs to." }),
  })
  .edits(({ objects, params, run }) => {
    const invoice = objects(Invoice).create({
      id: params.id,
      number: params.number,
      amount: params.amount,
      currency: params.currency ?? "EUR",
      status: "draft",
      paymentInfo: {
        method: "pending",
        reference: `draft:${params.id}`,
        recordedAt: run.startedAt.toISOString(),
      },
    })

    invoice.link(Invoice.l.customer, objects(Customer).byId(params.customer.primaryId))
    invoice.link(Invoice.l.project, objects(Project).byId(params.project.primaryId))
  })
