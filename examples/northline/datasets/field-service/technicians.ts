import { col, defineDataset } from "@sixb/core"

export const fieldTechnicians = defineDataset("field-service.technicians", {
  schema: [
    col("technician_id", "string"),
    col("full_name", "string"),
    col("email", "string"),
    col("phone", "string"),
    col("territory", "string"),
    col("certification", "string"),
    col("availability", "string"),
    col("updated_at", "timestamp"),
  ],
})
