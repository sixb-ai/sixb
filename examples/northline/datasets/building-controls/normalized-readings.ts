import { col, defineDataset } from "@sixb/core"

export const controlsNormalizedReadings = defineDataset("controls.normalized-readings", {
  schema: [
    col("reading_id", "string"),
    col("equipment_id", "string"),
    col("recorded_at", "timestamp"),
    col("supply_air_temperature", "float64"),
    col("return_air_temperature", "float64"),
    col("temperature_unit", "string"),
    col("compressor_current", "float64"),
    col("current_unit", "string"),
  ],
})
