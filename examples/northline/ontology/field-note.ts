import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Equipment } from "./equipment"
import { ServiceVisit } from "./service-visit"
import { Technician } from "./technician"

export const FieldNote = defineObjectType({
  id: "FieldNote",
  name: "Field note",
  description: "A durable field observation or diagnostic record.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop(
      "noteType",
      stringEnum([
        "general",
        "diagnostic",
        "safety",
        "customer_communication",
        "repair_recommendation",
        "follow_up",
      ]),
      {
        required: true,
        query: { searchable: true, filterable: true, exact: true, facet: true },
      }
    ),
    prop("body", "string", {
      required: true,
      query: { searchable: true, text: true, weight: 5 },
    }),
    prop("recordedAt", "timestamp", {
      required: true,
      query: { searchable: true, sortable: true },
    }),
    prop("attachment", "fileRef"),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  links: [
    link("visit", ServiceVisit, { cardinality: "one" }),
    link("equipment", Equipment, { cardinality: "one" }),
    link("author", Technician, { cardinality: "one" }),
  ],
  search: { title: "body", defaultText: ["body"], exact: ["id"] },
})
