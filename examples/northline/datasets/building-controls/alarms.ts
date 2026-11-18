import { col, defineDataset } from "@sixb/core"

export const controlsAlarms = defineDataset("controls.alarms", {
  schema: [
    col("alarm_id", "string"),
    col("equipment_id", "string"),
    col("message", "string"),
    col("severity", "string"),
    col("category", "string"),
    col("status", "string"),
    col("observed_at", "timestamp"),
    col("acknowledged_at", "timestamp", { nullable: true }),
    col("cleared_at", "timestamp", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
})
