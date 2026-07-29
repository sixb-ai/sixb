import { defineAction, param, ref } from "@sixb/core"
import { fieldServiceConnector } from "../connectors/field-service"
import { Equipment } from "../ontology/equipment"
import { ServiceCase } from "../ontology/service-case"
import { ServiceVisit } from "../ontology/service-visit"
import { Technician } from "../ontology/technician"
import { WorkOrder } from "../ontology/work-order"

export const dispatchWorkOrder = defineAction("dispatch-work-order", {
  description: "Create and assign field work after dispatcher review.",
})
  .on(ServiceCase)
  .params({
    equipment: param(ref(Equipment)),
    technician: param(ref(Technician)),
    scheduledStart: param("timestamp"),
    scheduledEnd: param("timestamp"),
  })
  .validate(({ params, target }) => {
    if (target.properties.status !== "triage") {
      throw new Error(
        `[Northline] Cannot dispatch ${target.properties.number}: the case is '${target.properties.status}'.`
      )
    }
    if (params.scheduledEnd <= params.scheduledStart) {
      throw new Error("[Northline] Cannot dispatch work: the service window is invalid.")
    }
  })
  .writeback(async ({ params, run, sixb, target }) => {
    const fieldService = await sixb.connector(fieldServiceConnector)
    const technician = (await fieldService.listTechnicians()).rows.find(
      (item) => item.technician_id === params.technician.primaryId
    )
    if (!technician) {
      throw new Error(`[Northline] Technician '${params.technician.primaryId}' was not found.`)
    }
    if (technician.availability !== "available") {
      throw new Error(
        `[Northline] Cannot dispatch ${target.properties.number}: ${technician.full_name} is not available.`
      )
    }

    return fieldService.dispatchWorkOrder(
      {
        serviceCaseId: target.primaryId,
        caseNumber: target.properties.number,
        equipmentId: params.equipment.primaryId,
        technicianId: params.technician.primaryId,
        title: target.properties.title,
        priority: target.properties.severity === "critical" ? "emergency" : "urgent",
        scope: `Diagnose and restore ${target.properties.title}`,
        scheduledStart: params.scheduledStart.toISOString(),
        scheduledEnd: params.scheduledEnd.toISOString(),
      },
      run.idempotencyKey ?? run.id
    )
  })
  .edits(({ objects, params, run, subject, writeback }) => {
    const workOrder = objects(WorkOrder).create({
      id: writeback.workOrder.work_order_id,
      number: writeback.workOrder.work_order_number,
      title: writeback.workOrder.title,
      priority: writeback.workOrder.priority,
      status: writeback.workOrder.status,
      scope: writeback.workOrder.scope,
      scheduledStart: writeback.workOrder.scheduled_start,
      scheduledEnd: writeback.workOrder.scheduled_end,
      dispatchedAt: writeback.workOrder.dispatched_at,
      sourceUpdatedAt: writeback.workOrder.updated_at,
    })
    workOrder.link(WorkOrder.l.serviceCase, objects(ServiceCase).byId(subject.primaryId))
    workOrder.link(WorkOrder.l.equipment, objects(Equipment).byId(params.equipment.primaryId))
    workOrder.link(WorkOrder.l.assignee, objects(Technician).byId(params.technician.primaryId))

    const visit = objects(ServiceVisit).create({
      id: writeback.visit.visit_id,
      number: writeback.visit.visit_number,
      status: writeback.visit.status,
      scheduledStart: writeback.visit.scheduled_start,
      sourceUpdatedAt: writeback.visit.updated_at,
    })
    visit.link(ServiceVisit.l.workOrder, workOrder)
    visit.link(ServiceVisit.l.technician, objects(Technician).byId(params.technician.primaryId))

    objects(ServiceCase).byId(subject.primaryId).update({
      status: "dispatching",
      ownerName: "Elena Park",
      nextAction: "Track technician arrival",
      currentVisitId: writeback.visit.visit_id,
    })
    objects(Technician).byId(params.technician.primaryId).update({
      availability: "assigned",
      sourceUpdatedAt: run.startedAt,
    })
  })
