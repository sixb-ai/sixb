import { defineObjectType, prop } from "@sixb/core/ontology"

export const Satellite = defineObjectType({
  id: "Satellite",
  name: "Satellite",
  description: "A spacecraft located from public orbital elements.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("tleLine1", "string", { required: true }),
    prop("tleLine2", "string", { required: true }),
    prop("elementEpoch", "timestamp", { required: true }),
  ],
})
