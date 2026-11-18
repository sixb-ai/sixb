import { col, defineDataset } from "@sixb/core"

export const controlsRawReadings = defineDataset("controls.raw-readings", {
  schema: [
    col("reading_id", "string"),
    col("equipment_id", "string"),
    col("recorded_at", "timestamp"),
    col("supply_temp", "float64"),
    col("return_temp", "float64"),
    col("temperature_unit", "string"),
    col("compressor_current", "float64"),
    col("current_unit", "string"),
  ],
})
