import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Equipment } from "./equipment"

export const BuildingAlarm = defineObjectType({
  id: "BuildingAlarm",
  name: "Building alarm",
  description: "An operational alarm raised by a connected building-controls platform.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("message", "string", {
      required: true,
      query: { searchable: true, text: true, weight: 5 },
    }),
    prop("severity", stringEnum(["low", "medium", "high", "critical"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("category", stringEnum(["comfort", "equipment", "communication", "safety"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("status", stringEnum(["active", "acknowledged", "cleared"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("observedAt", "timestamp", {
      required: true,
      query: { searchable: true, sortable: true },
    }),
    prop("acknowledgedAt", "timestamp"),
    prop("clearedAt", "timestamp"),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  links: [link("equipment", Equipment, { cardinality: "one" })],
  search: { title: "message", defaultText: ["message"], exact: ["id"] },
})
