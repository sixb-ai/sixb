import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { CustomerAccount } from "./customer-account"
import { Facility } from "./facility"
import { ServiceCase } from "./service-case"
import { ServiceVisit } from "./service-visit"

export const Quote = defineObjectType({
  id: "Quote",
  name: "Quote",
  description: "A commercial proposal for uncovered or additional service work.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("scope", "string", { required: true, query: { searchable: true, text: true } }),
    prop("reason", "string", {
      required: true,
      query: { searchable: true, text: true },
    }),
    prop("amount", "double", { required: true, query: { searchable: true, sortable: true } }),
    prop("currency", stringEnum(["USD"]), { required: true }),
    prop(
      "status",
      stringEnum(["draft", "internal_review", "sent", "approved", "declined", "expired"]),
      {
        required: true,
        query: { searchable: true, filterable: true, exact: true, facet: true, sortable: true },
      }
    ),
    prop("validUntil", "date", { required: true, query: { searchable: true, sortable: true } }),
    prop("decisionAt", "timestamp"),
    prop("document", "fileRef"),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  links: [
    link("customer", CustomerAccount, { cardinality: "one" }),
    link("facility", Facility, { cardinality: "one" }),
    link("serviceCase", ServiceCase, { cardinality: "one" }),
    link("originatingVisit", ServiceVisit, { cardinality: "one" }),
  ],
  search: { title: "number", defaultText: ["number", "scope", "reason"], exact: ["id", "number"] },
})
