import { defineRule } from "@sixb/core"
import { BuildingAlarm } from "../ontology/building-alarm"
import { ServiceCase } from "../ontology/service-case"
import { WorkOrder } from "../ontology/work-order"

export const alarmRequiresTriage = defineRule("alarm.requires-triage")
  .on(BuildingAlarm)
  .where((alarm) =>
    alarm.all(
      alarm.p.status.eq("active"),
      alarm.any(alarm.p.severity.eq("high"), alarm.p.severity.eq("critical"))
    )
  )

export const serviceCaseNeedsDispatch = defineRule("service-case.needs-dispatch")
  .on(ServiceCase)
  .where((serviceCase) => serviceCase.p.status.eq("triage"))

export const serviceCaseAwaitingQuote = defineRule("service-case.awaiting-quote")
  .on(ServiceCase)
  .where((serviceCase) =>
    serviceCase.all(
      serviceCase.p.status.eq("awaiting_authorization"),
      serviceCase.p.currentVisitId.isPresent()
    )
  )

export const serviceCaseSlaAtRisk = defineRule("service-case.sla-at-risk")
  .on(ServiceCase)
  .where((serviceCase) =>
    serviceCase.any(serviceCase.p.slaStatus.eq("at_risk"), serviceCase.p.slaStatus.eq("breached"))
  )

export const urgentWorkOrderUnassigned = defineRule("work-order.unassigned-urgent")
  .on(WorkOrder)
  .where((workOrder) =>
    workOrder.all(
      workOrder.any(workOrder.p.priority.eq("urgent"), workOrder.p.priority.eq("emergency")),
      workOrder.l.assignee.isMissing(),
      workOrder.not(workOrder.p.status.eq("completed"))
    )
  )

export const recoveryNotConfirmed = defineRule("equipment.recovery-not-confirmed")
  .on(ServiceCase)
  .where((serviceCase) =>
    serviceCase.all(
      serviceCase.p.status.eq("in_service"),
      serviceCase.p.nextAction.eq("Verify equipment recovery")
    )
  )
