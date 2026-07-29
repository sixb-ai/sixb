import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Equipment } from "./equipment"
import { ServiceCase } from "./service-case"
import { Technician } from "./technician"

export const WorkOrder = defineObjectType({
  id: "WorkOrder",
  name: "Work order",
  description: "An authorized unit of field work owned by Northline's field-service system.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("number", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("title", "string", { required: true, query: { searchable: true, text: true } }),
    prop("priority", stringEnum(["routine", "urgent", "emergency"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop(
      "status",
      stringEnum([
        "draft",
        "scheduled",
        "dispatched",
        "en_route",
        "on_site",
        "paused",
        "completed",
        "cancelled",
      ]),
      {
        required: true,
        query: { searchable: true, filterable: true, exact: true, facet: true, sortable: true },
      }
    ),
    prop("scope", "string", {
      required: true,
      query: { searchable: true, text: true },
    }),
    prop("scheduledStart", "timestamp", { query: { searchable: true, sortable: true } }),
    prop("scheduledEnd", "timestamp", { query: { searchable: true, sortable: true } }),
    prop("dispatchedAt", "timestamp"),
    prop("completedAt", "timestamp"),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  links: [
    link("serviceCase", ServiceCase, { cardinality: "one" }),
    link("equipment", Equipment, { cardinality: "one" }),
    link("assignee", Technician, { cardinality: "one" }),
  ],
  search: { title: "number", defaultText: ["number", "title", "scope"], exact: ["id", "number"] },
})
