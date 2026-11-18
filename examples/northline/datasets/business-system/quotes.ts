import { col, defineDataset } from "@sixb/core"

export const businessQuotes = defineDataset("business.quotes", {
  schema: [
    col("quote_id", "string"),
    col("quote_number", "string"),
    col("customer_id", "string"),
    col("facility_id", "string"),
    col("service_case_id", "string", { nullable: true }),
    col("originating_visit_id", "string", { nullable: true }),
    col("scope", "string"),
    col("reason", "string"),
    col("amount", "float64"),
    col("currency", "string"),
    col("status", "string"),
    col("valid_until", "date"),
    col("decision_at", "timestamp", { nullable: true }),
    col("updated_at", "timestamp"),
  ],
  primaryKey: "quote_id",
})
