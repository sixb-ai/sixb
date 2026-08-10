import { defineAction, param, ref } from "@sixb/core"
import { fieldServiceConnector } from "../connectors/field-service"
import { ServiceCase } from "../ontology/service-case"
import { ServiceVisit } from "../ontology/service-visit"
import { WorkOrder } from "../ontology/work-order"

export const startServiceVisit = defineAction("start-service-visit", {
  description: "Start an assigned service visit in the field-service system.",
})
  .on(ServiceVisit)
  .params({ serviceCase: param(ref(ServiceCase)), workOrder: param(ref(WorkOrder)) })
  .validate(({ target }) => {
    if (target.properties.status !== "scheduled") {
      throw new Error(
        `[Northline] Cannot start ${target.properties.number}: the visit is '${target.properties.status}'.`
      )
    }
  })
  .writeback(async ({ run, sixb, target }) => {
    const fieldService = await sixb.connectors.connect(fieldServiceConnector)
    return fieldService.startVisit(target.primaryId, run.idempotencyKey ?? run.id)
  })
  .edits(({ objects, params, subject, writeback }) => {
    objects(ServiceVisit).byId(subject.primaryId).update({
      status: writeback.status,
      startedAt: writeback.started_at,
      sourceUpdatedAt: writeback.updated_at,
    })
    objects(WorkOrder).byId(params.workOrder.primaryId).update({ status: "on_site" })
    objects(ServiceCase).byId(params.serviceCase.primaryId).update({
      status: "in_service",
      nextAction: "Await field diagnosis",
      currentVisitId: subject.primaryId,
    })
  })
