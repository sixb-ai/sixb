import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Technician } from "./technician"
import { WorkOrder } from "./work-order"

export const ServiceVisit = defineObjectType({
  id: "ServiceVisit",
  name: "Service visit",
  description: "One technician attendance against a field-service work order.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("status", stringEnum(["scheduled", "in_progress", "completed", "cancelled"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("scheduledStart", "timestamp", {
      required: true,
      query: { searchable: true, sortable: true },
    }),
    prop("startedAt", "timestamp"),
    prop("completedAt", "timestamp"),
    prop("workPerformed", "string", { query: { searchable: true, text: true } }),
    prop(
      "diagnosisDisposition",
      stringEnum(["resolved_on_site", "follow_up_required", "quote_required"])
    ),
    prop("completionDisposition", stringEnum(["resolved", "follow_up_required", "awaiting_parts"])),
    prop("serviceReport", "fileRef"),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  links: [
    link("workOrder", WorkOrder, { cardinality: "one" }),
    link("technician", Technician, { cardinality: "one" }),
  ],
  search: { title: "number", defaultText: ["number", "workPerformed"], exact: ["id", "number"] },
})
