import { z } from "zod"

const timestamp = z.string().datetime({ offset: true })
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const idempotencyReceipt = z.object({
  operation: z.string(),
  fingerprint: z.string(),
  resultId: z.string(),
})

export interface SourceListInput {
  readonly cursor?: string
  readonly limit?: number
}

export interface SourcePage<T> {
  readonly rows: readonly T[]
  readonly nextCursor?: string
}

export const customerRowSchema = z.object({
  customer_id: z.string(),
  account_name: z.string(),
  service_tier: z.enum(["standard", "priority", "strategic"]),
  status: z.enum(["active", "on_hold", "inactive"]),
  primary_contact_name: z.string(),
  primary_contact_email: z.string().email(),
  updated_at: timestamp,
})

export const facilityRowSchema = z.object({
  facility_id: z.string(),
  customer_id: z.string(),
  facility_name: z.string(),
  address_line: z.string(),
  city: z.string(),
  state: z.string(),
  postal_code: z.string(),
  territory: z.enum(["philadelphia", "north_jersey", "south_jersey", "delmarva"]),
  timezone: z.string(),
  access_notes: z.string(),
  criticality: z.enum(["standard", "important", "critical"]),
  status: z.enum(["operational", "degraded", "closed"]),
  updated_at: timestamp,
})

export const contractRowSchema = z.object({
  contract_id: z.string(),
  contract_number: z.string(),
  customer_id: z.string(),
  facility_id: z.string(),
  contract_name: z.string(),
  contract_type: z.enum(["preventive", "priority_care", "full_service"]),
  status: z.enum(["draft", "active", "expiring", "expired"]),
  starts_on: date,
  ends_on: date,
  coverage_hours: z.enum(["business_hours", "24_7"]),
  response_target_minutes: z.number().int().positive(),
  resolution_target_minutes: z.number().int().positive(),
  included_labor: z.boolean(),
  major_components_excluded: z.boolean(),
  approval_threshold: z.number().nonnegative(),
  updated_at: timestamp,
})

export const quoteRowSchema = z.object({
  quote_id: z.string(),
  quote_number: z.string(),
  customer_id: z.string(),
  facility_id: z.string(),
  service_case_id: z.string().optional(),
  originating_visit_id: z.string().optional(),
  scope: z.string(),
  reason: z.string(),
  amount: z.number().nonnegative(),
  currency: z.literal("USD"),
  status: z.enum(["draft", "internal_review", "sent", "approved", "declined", "expired"]),
  valid_until: date,
  decision_at: timestamp.optional(),
  updated_at: timestamp,
})

export const quoteChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert"), row: quoteRowSchema }),
  z.object({ kind: z.literal("delete"), key: z.object({ quote_id: z.string() }) }),
])

export const technicianRowSchema = z.object({
  technician_id: z.string(),
  full_name: z.string(),
  email: z.string().email(),
  phone: z.string(),
  territory: z.enum(["philadelphia", "north_jersey", "south_jersey", "delmarva"]),
  certification: z.enum(["commercial_hvac", "rooftop_unit", "chiller", "boiler", "controls"]),
  availability: z.enum(["available", "assigned", "off_duty"]),
  updated_at: timestamp,
})

export const workOrderRowSchema = z.object({
  work_order_id: z.string(),
  work_order_number: z.string(),
  service_case_id: z.string().optional(),
  equipment_id: z.string(),
  technician_id: z.string().optional(),
  title: z.string(),
  priority: z.enum(["routine", "urgent", "emergency"]),
  status: z.enum([
    "draft",
    "scheduled",
    "dispatched",
    "en_route",
    "on_site",
    "paused",
    "completed",
    "cancelled",
  ]),
  scope: z.string(),
  scheduled_start: timestamp.optional(),
  scheduled_end: timestamp.optional(),
  dispatched_at: timestamp.optional(),
  completed_at: timestamp.optional(),
  updated_at: timestamp,
})

export const visitRowSchema = z.object({
  visit_id: z.string(),
  visit_number: z.string(),
  work_order_id: z.string(),
  technician_id: z.string(),
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]),
  scheduled_start: timestamp,
  started_at: timestamp.optional(),
  completed_at: timestamp.optional(),
  work_performed: z.string().optional(),
  diagnosis_disposition: z
    .enum(["resolved_on_site", "follow_up_required", "quote_required"])
    .optional(),
  completion_disposition: z.enum(["resolved", "follow_up_required", "awaiting_parts"]).optional(),
  updated_at: timestamp,
})

export const fieldNoteRowSchema = z.object({
  note_id: z.string(),
  visit_id: z.string(),
  equipment_id: z.string(),
  technician_id: z.string(),
  note_type: z.enum([
    "general",
    "diagnostic",
    "safety",
    "customer_communication",
    "repair_recommendation",
    "follow_up",
  ]),
  body: z.string(),
  recorded_at: timestamp,
  updated_at: timestamp,
})

export const equipmentRowSchema = z.object({
  equipment_id: z.string(),
  facility_id: z.string(),
  display_name: z.string(),
  equipment_type: z.enum([
    "rooftop_unit",
    "air_handler",
    "chiller",
    "boiler",
    "heat_pump",
    "controller",
  ]),
  manufacturer: z.string(),
  model: z.string(),
  serial_number: z.string(),
  installed_on: date.optional(),
  criticality: z.enum(["standard", "important", "critical"]),
  last_seen_at: timestamp,
  updated_at: timestamp,
})

export const readingRowSchema = z.object({
  reading_id: z.string(),
  equipment_id: z.string(),
  recorded_at: timestamp,
  supply_temp: z.number(),
  return_temp: z.number(),
  temperature_unit: z.enum(["degreeFahrenheit", "degreeCelsius"]),
  compressor_current: z.number(),
  current_unit: z.literal("ampere"),
})

export const alarmRowSchema = z.object({
  alarm_id: z.string(),
  equipment_id: z.string(),
  message: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  category: z.enum(["comfort", "equipment", "communication", "safety"]),
  status: z.enum(["active", "acknowledged", "cleared"]),
  observed_at: timestamp,
  acknowledged_at: timestamp.optional(),
  cleared_at: timestamp.optional(),
  updated_at: timestamp,
})

export const businessStateSchema = z.object({
  schemaVersion: z.literal(1),
  customers: z.array(customerRowSchema),
  facilities: z.array(facilityRowSchema),
  contracts: z.array(contractRowSchema),
  quotes: z.array(quoteRowSchema),
  quoteChanges: z.array(quoteChangeSchema).optional(),
  idempotency: z.record(idempotencyReceipt),
})

export const fieldServiceStateSchema = z.object({
  schemaVersion: z.literal(1),
  technicians: z.array(technicianRowSchema),
  workOrders: z.array(workOrderRowSchema),
  visits: z.array(visitRowSchema),
  fieldNotes: z.array(fieldNoteRowSchema),
  idempotency: z.record(idempotencyReceipt),
})

export const controlsStateSchema = z.object({
  schemaVersion: z.literal(1),
  equipment: z.array(equipmentRowSchema),
  readings: z.array(readingRowSchema),
  alarms: z.array(alarmRowSchema),
  idempotency: z.record(idempotencyReceipt),
})

export type CustomerRow = z.infer<typeof customerRowSchema>
export type FacilityRow = z.infer<typeof facilityRowSchema>
export type ContractRow = z.infer<typeof contractRowSchema>
export type QuoteRow = z.infer<typeof quoteRowSchema>
export type QuoteChange = z.infer<typeof quoteChangeSchema>
export type TechnicianRow = z.infer<typeof technicianRowSchema>
export type WorkOrderRow = z.infer<typeof workOrderRowSchema>
export type VisitRow = z.infer<typeof visitRowSchema>
export type FieldNoteRow = z.infer<typeof fieldNoteRowSchema>
export type EquipmentRow = z.infer<typeof equipmentRowSchema>
export type ReadingRow = z.infer<typeof readingRowSchema>
export type AlarmRow = z.infer<typeof alarmRowSchema>
export type BusinessState = z.infer<typeof businessStateSchema>
export type FieldServiceState = z.infer<typeof fieldServiceStateSchema>
export type ControlsState = z.infer<typeof controlsStateSchema>
