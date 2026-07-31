import { defineProjection } from "@sixb/core"
import {
  controlsAlarms,
  controlsEquipmentHealth,
  controlsNormalizedReadings,
  northlineServiceCases,
} from "../datasets/building-controls"
import { BuildingAlarm } from "../ontology/building-alarm"
import { CustomerAccount } from "../ontology/customer-account"
import { Equipment } from "../ontology/equipment"
import { Facility } from "../ontology/facility"
import { ServiceCase } from "../ontology/service-case"
import { ServiceContract } from "../ontology/service-contract"

export const equipmentProjection = defineProjection("controls-equipment", Equipment)
  .fromDataset(controlsEquipmentHealth)
  .properties({
    id: "equipment_id",
    name: "display_name",
    equipmentType: "equipment_type",
    manufacturer: "manufacturer",
    model: "model",
    serialNumber: "serial_number",
    installedOn: "installed_on",
    criticality: "criticality",
    health: "health",
    healthReason: "health_reason",
    lastSeenAt: "last_seen_at",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    facility: { link: Equipment.l.facility, sourceField: "facility_id", target: Facility },
  })

export const alarmsProjection = defineProjection("controls-alarms", BuildingAlarm)
  .fromDataset(controlsAlarms)
  .properties({
    id: "alarm_id",
    message: "message",
    severity: "severity",
    category: "category",
    status: "status",
    observedAt: "observed_at",
    acknowledgedAt: "acknowledged_at",
    clearedAt: "cleared_at",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    equipment: {
      link: BuildingAlarm.l.equipment,
      sourceField: "equipment_id",
      target: Equipment,
    },
  })

export const serviceCasesProjection = defineProjection("northline-service-cases", ServiceCase)
  .fromDataset(northlineServiceCases)
  .properties({
    id: "case_id",
    number: "case_number",
    title: "title",
    source: "source",
    severity: "severity",
    status: "status",
    customerImpact: "customer_impact",
    coverageStatus: "coverage_status",
    responseDeadline: "response_deadline",
    resolutionDeadline: "resolution_deadline",
    slaStatus: "sla_status",
    ownerName: "owner_name",
    nextAction: "next_action",
    detectedAt: "detected_at",
    acknowledgedAt: "acknowledged_at",
    resolvedAt: "resolved_at",
  })
  .withLinks({
    customer: {
      link: ServiceCase.l.customer,
      sourceField: "customer_id",
      target: CustomerAccount,
    },
    facility: { link: ServiceCase.l.facility, sourceField: "facility_id", target: Facility },
    equipment: { link: ServiceCase.l.equipment, sourceField: "equipment_id", target: Equipment },
    appliedContract: {
      link: ServiceCase.l.appliedContract,
      sourceField: "contract_id",
      target: ServiceContract,
    },
    originatingAlarms: {
      link: ServiceCase.l.originatingAlarms,
      sourceField: "alarm_id",
      target: BuildingAlarm,
    },
  })

export const supplyAirTelemetry = defineProjection(
  "controls-supply-air-temperature",
  Equipment.p.supplyAirTemperature
)
  .fromDataset(controlsNormalizedReadings)
  .points({
    objectId: "equipment_id",
    at: "recorded_at",
    value: "supply_air_temperature",
    unit: "temperature_unit",
  })

export const returnAirTelemetry = defineProjection(
  "controls-return-air-temperature",
  Equipment.p.returnAirTemperature
)
  .fromDataset(controlsNormalizedReadings)
  .points({
    objectId: "equipment_id",
    at: "recorded_at",
    value: "return_air_temperature",
    unit: "temperature_unit",
  })

export const compressorCurrentTelemetry = defineProjection(
  "controls-compressor-current",
  Equipment.p.compressorCurrent
)
  .fromDataset(controlsNormalizedReadings)
  .points({
    objectId: "equipment_id",
    at: "recorded_at",
    value: "compressor_current",
    unit: "current_unit",
  })
