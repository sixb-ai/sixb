import { defineObjectType, prop, stringEnum } from "@sixb/core/ontology"

export const Technician = defineObjectType({
  id: "Technician",
  name: "Technician",
  description: "A qualified Northline field employee available for dispatch.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop("email", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true },
    }),
    prop("phone", "string"),
    prop("territory", stringEnum(["philadelphia", "north_jersey", "south_jersey", "delmarva"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop(
      "certification",
      stringEnum(["commercial_hvac", "rooftop_unit", "chiller", "boiler", "controls"]),
      {
        required: true,
        query: { searchable: true, filterable: true, exact: true, facet: true },
      }
    ),
    prop("availability", stringEnum(["available", "assigned", "off_duty"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
  ],
  search: { title: "name", defaultText: ["name", "email"], exact: ["id", "name"] },
})
