import { defineAction, optional, param } from "@sixb/core"
import { ServiceCase } from "../ontology/service-case"

export const acknowledgeServiceCase = defineAction("acknowledge-service-case", {
  description: "Acknowledge a new service case and begin dispatch triage.",
})
  .on(ServiceCase)
  .params({ operatorName: optional(param("string")) })
  .validate(({ target }) => {
    if (target.properties.status !== "new") {
      throw new Error(
        `[Northline] Cannot acknowledge ${target.properties.number}: the case is '${target.properties.status}'.`
      )
    }
  })
  .edits(({ objects, params, run, subject }) => {
    objects(ServiceCase)
      .byId(subject.primaryId)
      .update({
        status: "triage",
        ownerName: params.operatorName ?? "Dispatch desk",
        nextAction: "Review technician recommendation",
        acknowledgedAt: run.startedAt,
      })
  })
