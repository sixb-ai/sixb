import { defineProjection } from "@sixb/core"
import { northlineServiceCases } from "../datasets/service/service-cases"
import { CustomerAccount } from "../ontology/customers/customer-account"
import { Facility } from "../ontology/customers/facility"
import { ServiceContract } from "../ontology/customers/service-contract"
import { BuildingAlarm } from "../ontology/equipment/building-alarm"
import { Equipment } from "../ontology/equipment/equipment"
import { ServiceCase } from "../ontology/service-case"

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
