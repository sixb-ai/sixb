import { defineProjection, fromForeignKey } from "@pario/core"
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
    customerRef: "customerRef",
    projectRef: "projectRef",
  })
  .withLinks({
    customer: fromForeignKey({
      link: Invoice.l.customer,
      sourceProperty: Invoice.p.customerRef,
      target: Customer,
    }),
    project: fromForeignKey({
      link: Invoice.l.project,
      sourceProperty: Invoice.p.projectRef,
      target: Project,
    }),
  })
