import { defineObjectType, prop, stringEnum } from "@sixb/core/ontology"

export const CustomerAccount = defineObjectType({
  id: "CustomerAccount",
  name: "Customer account",
  description: "A commercial organization served by Northline Mechanical.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("serviceTier", stringEnum(["standard", "priority", "strategic"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("status", stringEnum(["active", "on_hold", "inactive"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("primaryContactName", "string"),
    prop("primaryContactEmail", "string"),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  search: { title: "name", defaultText: ["name"], exact: ["id", "name"] },
})
