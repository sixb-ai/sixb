import { defineProjection } from "@sixb/core"
import { erpInvoicesDataset } from "../datasets/erp"
import { Customer } from "../ontology/customer"
import { Invoice } from "../ontology/invoice"
import { Project } from "../ontology/project"

export const invoiceProjection = defineProjection("invoice-proj", Invoice)
  .fromDataset(erpInvoicesDataset)
  .properties({
    id: "id",
    number: "number",
    amount: "amount",
    currency: "currency",
    status: "status",
    issuedAt: "issuedAt",
    dueDate: "dueDate",
  })
  .withLinks({
    customer: {
      link: Invoice.l.customer,
      sourceField: "customer_id",
      target: Customer,
    },
    project: {
      link: Invoice.l.project,
      sourceField: "project_id",
      target: Project,
    },
  })
