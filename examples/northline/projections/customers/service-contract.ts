import { defineProjection } from "@sixb/core"
import { businessContracts } from "../../datasets/business-system/contracts"
import { CustomerAccount } from "../../ontology/customers/customer-account"
import { Facility } from "../../ontology/customers/facility"
import { ServiceContract } from "../../ontology/customers/service-contract"

export const serviceContractsProjection = defineProjection(
  "business-service-contracts",
  ServiceContract
)
  .fromDataset(businessContracts)
  .properties({
    id: "contract_id",
    number: "contract_number",
    name: "contract_name",
    contractType: "contract_type",
    status: "status",
    startsOn: "starts_on",
    endsOn: "ends_on",
    coverageHours: "coverage_hours",
    responseTargetMinutes: "response_target_minutes",
    resolutionTargetMinutes: "resolution_target_minutes",
    includedLabor: "included_labor",
    majorComponentsExcluded: "major_components_excluded",
    approvalThreshold: "approval_threshold",
    sourceUpdatedAt: "updated_at",
  })
  .withLinks({
    customer: {
      link: ServiceContract.l.customer,
      sourceField: "customer_id",
      target: CustomerAccount,
    },
    coveredFacilities: {
      link: ServiceContract.l.coveredFacilities,
      sourceField: "facility_id",
      target: Facility,
    },
  })
