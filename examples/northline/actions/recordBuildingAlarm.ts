import { defineAction, param } from "@sixb/core"
import { stringEnum } from "@sixb/core/ontology"
import { businessSystemConnector } from "../connectors/business-system"
import { serviceCaseIdentity } from "../lib/case-policy"
import { BuildingAlarm } from "../ontology/building-alarm"
import { CustomerAccount } from "../ontology/customer-account"
import { Equipment } from "../ontology/equipment"
import { Facility } from "../ontology/facility"
import { ServiceCase } from "../ontology/service-case"
import { ServiceContract } from "../ontology/service-contract"

export const recordBuildingAlarm = defineAction("record-building-alarm", {
  description: "Record a controls alarm and ensure it has one Northline service case.",
})
  .params({
    alarmId: param("string"),
    equipmentId: param("string"),
    facilityId: param("string"),
    message: param("string"),
    severity: param(stringEnum(["low", "medium", "high", "critical"])),
    category: param(stringEnum(["comfort", "equipment", "communication", "safety"])),
    status: param(stringEnum(["active", "acknowledged", "cleared"])),
    observedAt: param("timestamp"),
  })
  .writeback(async ({ params, sixb }) => {
    const business = await sixb.connectors.connect(businessSystemConnector)
    const facility = (await business.listFacilities()).rows.find(
      (row) => row.facility_id === params.facilityId
    )
    const contract = (await business.listContracts()).rows.find(
      (row) => row.facility_id === params.facilityId && row.status === "active"
    )
    if (!facility || !contract) {
      throw new Error(
        `[Northline] Cannot record alarm: facility '${params.facilityId}' has no active service context.`
      )
    }
    return {
      customerId: facility.customer_id,
      contractId: contract.contract_id,
      responseTargetMinutes: contract.response_target_minutes,
      resolutionTargetMinutes: contract.resolution_target_minutes,
      majorComponentsExcluded: contract.major_components_excluded,
    }
  })
  .edits(async ({ objects, params, read, writeback }) => {
    const existingAlarm = await read.objects(BuildingAlarm).get(params.alarmId)

    const alarmProperties = {
      message: params.message,
      severity: params.severity,
      category: params.category,
      status: params.status,
      observedAt: params.observedAt,
      sourceUpdatedAt: new Date(),
    }
    const alarm = existingAlarm
      ? objects(BuildingAlarm).byId(params.alarmId)
      : objects(BuildingAlarm).create({ id: params.alarmId, ...alarmProperties })
    if (existingAlarm) alarm.update(alarmProperties)
    alarm.link(BuildingAlarm.l.equipment, objects(Equipment).byId(params.equipmentId))

    const identity = serviceCaseIdentity(params.alarmId)
    const existingCase = await read.objects(ServiceCase).get(identity.id)
    if (existingCase) return

    const detectedAt = params.observedAt.getTime()
    const responseMinutes = writeback.responseTargetMinutes
    const resolutionMinutes = writeback.resolutionTargetMinutes
    const serviceCase = objects(ServiceCase).create({
      id: identity.id,
      number: identity.number,
      title: params.message,
      source: "alarm",
      severity: params.severity,
      status: "new",
      customerImpact: `${params.equipmentId} is operating outside its expected range.`,
      coverageStatus: writeback.majorComponentsExcluded ? "partially_covered" : "covered",
      responseDeadline: new Date(detectedAt + responseMinutes * 60_000),
      resolutionDeadline: new Date(detectedAt + resolutionMinutes * 60_000),
      slaStatus: "on_track",
      nextAction: "Acknowledge and review coverage",
      detectedAt: params.observedAt,
    })
    serviceCase.link(ServiceCase.l.customer, objects(CustomerAccount).byId(writeback.customerId))
    serviceCase.link(ServiceCase.l.facility, objects(Facility).byId(params.facilityId))
    serviceCase.link(ServiceCase.l.equipment, objects(Equipment).byId(params.equipmentId))
    serviceCase.link(
      ServiceCase.l.appliedContract,
      objects(ServiceContract).byId(writeback.contractId)
    )
    serviceCase.link(ServiceCase.l.originatingAlarms, objects(BuildingAlarm).byId(params.alarmId))
  })
