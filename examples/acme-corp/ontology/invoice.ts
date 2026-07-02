import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Customer } from "./customer"
import { Project } from "./project"

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  description: "A billing invoice for a customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true, sortable: true },
    }),
    prop("amount", "double", {
      required: true,
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("currency", stringEnum(["EUR", "USD", "GBP"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("status", stringEnum(["draft", "sent", "paid", "overdue", "cancelled"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("issuedAt", "timestamp", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("dueDate", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop(
      "reminderReviewStatus",
      stringEnum(["not_requested", "needs_review", "approved", "revision_requested", "cancelled"]),
      { query: { searchable: true, filterable: true, exact: true, facet: true } }
    ),
    prop("reminderReviewRequestedAt", "timestamp"),
    prop("reminderReviewedAt", "timestamp"),
    prop("reminderReviewerNote", "string"),
    prop("sourceFile", "fileRef"),
    prop("sourceFileAttachedAt", "timestamp"),
    prop("sourceFileNote", "string"),
    prop("paymentInfo", {
      type: "object",
      properties: {
        method: { schema: "string", required: true },
        reference: { schema: "string", required: true },
        recordedAt: { schema: "timestamp", required: true },
      },
    }),
  ],
  search: {
    title: "number",
    exact: ["id", "number"],
  },
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("project", Project, { cardinality: "one" }),
  ],
})
