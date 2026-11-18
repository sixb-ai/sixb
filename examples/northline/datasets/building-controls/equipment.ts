import { col, defineDataset } from "@sixb/core"

export const controlsEquipment = defineDataset("controls.equipment", {
  schema: [
    col("equipment_id", "string"),
    col("facility_id", "string"),
    col("display_name", "string"),
    col("equipment_type", "string"),
    col("manufacturer", "string"),
    col("model", "string"),
    col("serial_number", "string"),
    col("installed_on", "date", { nullable: true }),
    col("criticality", "string"),
    col("last_seen_at", "timestamp"),
    col("updated_at", "timestamp"),
  ],
})
