import { defineObjectType, link, prop, valueTypeRef } from "@sixb/core/ontology"
import { Temperature } from "./value-types"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true, query: { searchable: true, filterable: true } }),
    prop("azimuth", valueTypeRef("Azimuth")),
    prop("currentTemperature", valueTypeRef(Temperature), { mode: "telemetry" }),
  ],
  links: [
    link.ref("thermostat", "Thermostat", { cardinality: "one" }),
    link.self("adjacent", { cardinality: "many" }),
    // Names a type the manifest does not register: a stale manifest or a wrong target id.
    link.ref("ghost", "Ghost", { cardinality: "one" }),
  ],
})

export const Thermostat = defineObjectType({
  id: "Thermostat",
  name: "Thermostat",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("model", "string", { required: true }),
  ],
  links: [link.ref("room", "Room", { cardinality: "one" })],
})
