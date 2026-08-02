import { defineProjection, type ObjectProjectionDefinition } from "@sixb/core"
import { satelliteOrbit } from "../datasets/satellite-orbit"
import { Satellite } from "../ontology/satellite"

export const satelliteProjection: ObjectProjectionDefinition = defineProjection(
  "satellite",
  Satellite
)
  .fromDataset(satelliteOrbit)
  .properties({
    id: "id",
    name: "name",
    tleLine1: "tleLine1",
    tleLine2: "tleLine2",
    elementEpoch: "elementEpoch",
  })
