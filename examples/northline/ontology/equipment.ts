import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Facility } from "./facility"

export const Equipment = defineObjectType({
  id: "Equipment",
  name: "Equipment",
  description: "An installed HVAC or controls asset monitored and serviced by Northline.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true, sortable: true, weight: 5 },
    }),
    prop(
      "equipmentType",
      stringEnum(["rooftop_unit", "air_handler", "chiller", "boiler", "heat_pump", "controller"]),
      {
        required: true,
        query: { searchable: true, filterable: true, exact: true, facet: true },
      }
    ),
    prop("manufacturer", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true },
    }),
    prop("model", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true },
    }),
    prop("serialNumber", "string", {
      required: true,
      query: { searchable: true, text: true, exact: true },
    }),
    prop("installedOn", "date"),
    prop("criticality", stringEnum(["standard", "important", "critical"]), {
      required: true,
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("health", stringEnum(["healthy", "watch", "unhealthy", "offline"]), {
      query: { searchable: true, filterable: true, exact: true, facet: true },
    }),
    prop("healthReason", "string"),
    prop("lastSeenAt", "timestamp", { query: { searchable: true, sortable: true } }),
    prop("sourceUpdatedAt", "timestamp", { query: { searchable: true, sortable: true } }),
    prop("supplyAirTemperature", "double", {
      mode: "telemetry",
      semanticType: "Temperature",
    }),
    prop("returnAirTemperature", "double", {
      mode: "telemetry",
      semanticType: "Temperature",
    }),
    prop("compressorCurrent", "double", { mode: "telemetry", semanticType: "Current" }),
  ],
  links: [link("facility", Facility, { cardinality: "one" })],
  search: {
    title: "name",
    defaultText: ["name", "manufacturer", "model", "serialNumber"],
    exact: ["id", "name", "serialNumber"],
  },
})
