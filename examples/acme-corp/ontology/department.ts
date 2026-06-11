import { defineObjectType, prop } from "@sixb/core/ontology"

export const Department = defineObjectType({
  id: "Department",
  name: "Department",
  description: "An organizational department within the company.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("code", "string", { required: true }),
    prop("headcount", "integer", { mode: "telemetry" }),
  ],
})
