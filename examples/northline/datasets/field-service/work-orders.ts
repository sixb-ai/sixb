import { col, defineDataset } from "@sixb/core"

export const fieldWorkOrders = defineDataset("field-service.work-orders", {
  schema: [
    col("work_order_id", "string"),
    col("work_order_number", "string"),
    col("service_case_id", "string", { nullable: true }),
    col("equipment_id", "string"),
    col("technician_id", "string", { nullable: true }),
    col("title", "string"),
    col("priority", "string"),
    col("status", "string"),
    col("scope", "string"),
    col("scheduled_start", "timestamp", { nullable: true }),
    col("scheduled_end", "timestamp", { nullable: true }),
    col("dispatched_at", "timestamp", { nullable: true }),
    col("completed_at", "timestamp", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
})
