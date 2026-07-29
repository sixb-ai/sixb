import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { CustomerAccount } from "./customer-account"

export const Facility = defineObjectType({
  id: "Facility",
  name: "Facility",
  description: "A customer building or campus serviced by Northline.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("addressLine", "string", { required: true, query: { searchable: true, text: true } }),
    prop("city", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true },
    }),
    prop("state", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("postalCode", "string", { required: true }),
    prop("territory", stringEnum(["philadelphia", "north_jersey", "south_jersey", "delmarva"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("timezone", "string", { required: true }),
    prop("accessNotes", "string"),
    prop("criticality", stringEnum(["standard", "important", "critical"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("status", stringEnum(["operational", "degraded", "closed"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  links: [link("customer", CustomerAccount, { cardinality: "one" })],
  search: { title: "name", defaultText: ["name", "addressLine", "city"], exact: ["id"] },
})
