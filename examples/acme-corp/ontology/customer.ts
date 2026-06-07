import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { Employee } from "./employee"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  description: "A company customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("email", "string", {
      required: true,
      query: { searchable: true, filterable: true, exact: true },
    }),
    prop("company", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, filterable: true, sortable: true },
    }),
    prop("industry", "string", {
      query: { searchable: true, text: true, filterable: true, exact: true, facet: true },
    }),
    prop("tier", stringEnum(["bronze", "silver", "gold", "platinum"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
  ],
  search: {
    title: "company",
    defaultText: ["company", "name", "industry"],
    exact: ["id", "email", "company"],
  },
  links: [link("accountManager", Employee, { cardinality: "one" })],
})
