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

export const controlsEquipmentHealth = defineDataset("controls.equipment-health", {
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
    col("health", "string"),
    col("health_reason", "string"),
    col("last_seen_at", "timestamp"),
    col("updated_at", "timestamp"),
  ],
})

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

export const northlineServiceCases = defineDataset("northline.service-cases", {
  schema: [
    col("case_id", "string"),
    col("case_number", "string"),
    col("customer_id", "string"),
    col("facility_id", "string"),
    col("equipment_id", "string"),
    col("contract_id", "string"),
    col("alarm_id", "string"),
    col("title", "string"),
    col("source", "string"),
    col("severity", "string"),
    col("status", "string"),
    col("customer_impact", "string"),
    col("coverage_status", "string"),
    col("response_deadline", "timestamp"),
    col("resolution_deadline", "timestamp"),
    col("sla_status", "string"),
    col("owner_name", "string", { nullable: true }),
    col("next_action", "string"),
    col("detected_at", "timestamp"),
    col("acknowledged_at", "timestamp", { nullable: true }),
    col("resolved_at", "timestamp", { nullable: true }),
  ],
})
