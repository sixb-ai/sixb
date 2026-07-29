import { defineAction, param, ref } from "@sixb/core"
import { stringEnum } from "@sixb/core/ontology"
import { buildingControlsConnector } from "../connectors/building-controls"
import { fieldServiceConnector } from "../connectors/field-service"
import { Equipment } from "../ontology/equipment"
import { ServiceCase } from "../ontology/service-case"
import { ServiceVisit } from "../ontology/service-visit"
import { WorkOrder } from "../ontology/work-order"

export const completeServiceVisit = defineAction("complete-service-visit", {
  description: "Complete documented field work and return the case for recovery verification.",
})
  .on(ServiceVisit)
  .params({
    serviceCase: param(ref(ServiceCase)),
    workOrder: param(ref(WorkOrder)),
    equipment: param(ref(Equipment)),
    workPerformed: param("string"),
    disposition: param(stringEnum(["resolved", "follow_up_required", "awaiting_parts"])),
  })
  .validate(({ params, target }) => {
    if (!target.properties.diagnosisDisposition) {
      throw new Error("[Northline] Cannot complete visit: a diagnostic disposition is required.")
    }
    if (!params.workPerformed.trim()) {
      throw new Error("[Northline] Cannot complete visit: work performed is required.")
    }
  })
  .writeback(async ({ params, run, sixb, target }) => {
    const fieldService = await sixb.connector(fieldServiceConnector)
    const visit = await fieldService.completeVisit(
      target.primaryId,
      { workPerformed: params.workPerformed, disposition: params.disposition },
      run.idempotencyKey ?? run.id
    )
    if (params.disposition === "resolved") {
      const controls = await sixb.connector(buildingControlsConnector)
      await controls.recordRecovery(params.equipment.primaryId, run.idempotencyKey ?? run.id)
    }
    const serviceReport = await sixb.blobs.put({
      body: new TextEncoder().encode(
        `Northline Mechanical Service Report\n\nVisit: ${visit.visit_number}\nCompleted: ${visit.completed_at}\n\nWork performed\n${params.workPerformed}\n`
      ),
      fileName: `${visit.visit_number}-service-report.txt`,
      mediaType: "text/plain",
      logicalPath: `service-reports/${visit.visit_number}.txt`,
    })
    return { visit, serviceReport }
  })
  .edits(({ objects, params, subject, writeback }) => {
    objects(ServiceVisit).byId(subject.primaryId).update({
      status: "completed",
      completedAt: writeback.visit.completed_at,
      workPerformed: writeback.visit.work_performed,
      completionDisposition: writeback.visit.completion_disposition,
      serviceReport: writeback.serviceReport,
      sourceUpdatedAt: writeback.visit.updated_at,
    })
    objects(WorkOrder).byId(params.workOrder.primaryId).update({
      status: "completed",
      completedAt: writeback.visit.completed_at,
    })
    objects(ServiceCase).byId(params.serviceCase.primaryId).update({
      status: "in_service",
      nextAction: "Verify equipment recovery",
    })
  })
