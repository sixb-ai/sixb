import { col, defineDataset } from "@sixb/core"

export const businessCustomers = defineDataset("business.customers", {
  schema: [
    col("customer_id", "string"),
    col("account_name", "string"),
    col("service_tier", "string"),
    col("status", "string"),
    col("primary_contact_name", "string"),
    col("primary_contact_email", "string"),
    col("updated_at", "timestamp"),
  ],
})
