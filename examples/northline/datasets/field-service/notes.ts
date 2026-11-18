import { col, defineDataset } from "@sixb/core"

export const fieldNotes = defineDataset("field-service.notes", {
  schema: [
    col("note_id", "string"),
    col("visit_id", "string"),
    col("equipment_id", "string"),
    col("technician_id", "string"),
    col("note_type", "string"),
    col("body", "string"),
    col("recorded_at", "timestamp"),
    col("updated_at", "timestamp"),
  ],
})
