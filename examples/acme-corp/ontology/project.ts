import { defineObjectType, link, prop, stringEnum } from "@sixb/core"
import { Customer } from "./customer"
import { Employee } from "./employee"

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  description: "A client project managed by the company.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("description", "string", {
      query: { searchable: true, text: true },
    }),
    prop("status", stringEnum(["draft", "active", "paused", "completed", "cancelled"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("startDate", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("deadline", "date", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("budget", "double", {
      query: { searchable: true, filterable: true, sortable: true },
    }),
    prop("progress", "integer", { mode: "telemetry" }),
  ],
  search: {
    title: "name",
    defaultText: ["name", "description"],
    exact: ["id", "name"],
  },
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("lead", Employee, { cardinality: "one" }),
    link("members", Employee, { cardinality: "many" }),
  ],
})
