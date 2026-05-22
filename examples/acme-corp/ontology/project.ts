import { defineObjectType, link, prop, stringEnum } from "@pario/core"
import { Customer } from "./customer"
import { Employee } from "./employee"

export const Project = defineObjectType({
  id: "Project",
  name: "Project",
  description: "A client project managed by the company.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("description", "string"),
    prop("status", stringEnum(["draft", "active", "paused", "completed", "cancelled"])),
    prop("startDate", "date"),
    prop("deadline", "date"),
    prop("budget", "double"),
    prop("progress", "integer", { mode: "telemetry" }),
    prop("customerRef", "string"),
    prop("leadRef", "string"),
  ],
  links: [
    link("customer", Customer, { cardinality: "one" }),
    link("lead", Employee, { cardinality: "one" }),
    link("members", Employee, { cardinality: "many" }),
  ],
})
