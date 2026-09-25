import { defineValueType } from "@sixb/core/ontology"

export const Temperature = defineValueType({
  id: "Temperature",
  name: "Temperature",
  schema: "double",
  semanticType: "Temperature",
})

/** Referenced only by id (`valueTypeRef("Azimuth")`), so it is typed through the registry. */
export const Azimuth = defineValueType({ id: "Azimuth", name: "Azimuth", schema: "double" })
