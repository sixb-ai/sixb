import { defineProjection } from "@sixb/core"
import { controlsNormalizedReadings } from "../../datasets/building-controls/normalized-readings"
import { Equipment } from "../../ontology/equipment/equipment"

export const supplyAirTelemetry = defineProjection(
  "controls-supply-air-temperature",
  Equipment.p.supplyAirTemperature
)
  .fromDataset(controlsNormalizedReadings)
  .points({
    objectId: "equipment_id",
    at: "recorded_at",
    value: "supply_air_temperature",
    unit: "temperature_unit",
  })

export const returnAirTelemetry = defineProjection(
  "controls-return-air-temperature",
  Equipment.p.returnAirTemperature
)
  .fromDataset(controlsNormalizedReadings)
  .points({
    objectId: "equipment_id",
    at: "recorded_at",
    value: "return_air_temperature",
    unit: "temperature_unit",
  })

export const compressorCurrentTelemetry = defineProjection(
  "controls-compressor-current",
  Equipment.p.compressorCurrent
)
  .fromDataset(controlsNormalizedReadings)
  .points({
    objectId: "equipment_id",
    at: "recorded_at",
    value: "compressor_current",
    unit: "current_unit",
  })
