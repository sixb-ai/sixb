import { col, defineDataset } from "@sixb/core"

export const fieldVisits = defineDataset("field-service.visits", {
  schema: [
    col("visit_id", "string"),
    col("visit_number", "string"),
    col("work_order_id", "string"),
    col("technician_id", "string"),
    col("status", "string"),
    col("scheduled_start", "timestamp"),
    col("started_at", "timestamp", { nullable: true }),
    col("completed_at", "timestamp", { nullable: true }),
    col("work_performed", "string", { nullable: true }),
    col("diagnosis_disposition", "string", { nullable: true }),
    col("completion_disposition", "string", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
})
