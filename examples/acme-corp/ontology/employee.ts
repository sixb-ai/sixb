import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Department } from "./department"

export const Employee = defineObjectType({
  id: "Employee",
  name: "Employee",
  description: "A company employee.",
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
    prop("role", "string", {
      required: true,
      query: { searchable: true, text: true, filterable: true, exact: true, sortable: true },
    }),
    prop("seniority", stringEnum(["junior", "mid", "senior", "lead", "director"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("hireDate", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
  ],
  search: {
    title: "name",
    defaultText: ["name", "role"],
    exact: ["id", "email"],
  },
  links: [link("department", Department, { cardinality: "one" })],
})
