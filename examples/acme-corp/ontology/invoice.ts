import { defineObjectType, link, prop, stringEnum } from "@pario/core"
import { Customer } from "./customer"
import { Project } from "./project"

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  description: "A billing invoice for a customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", { required: true }),
    prop("amount", "double", { required: true }),
    prop("currency", stringEnum(["EUR", "USD", "GBP"])),
    prop("status", stringEnum(["draft", "sent", "paid", "overdue", "cancelled"])),
    prop("issuedAt", "timestamp"),
    prop("dueDate", "date"),
    prop("customerRef", "string"),
    prop("projectRef", "string"),
  ],
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("project", Project, { cardinality: "one" }),
  ],
})
