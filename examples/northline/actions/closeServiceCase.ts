import { defineAction, optional, param } from "@sixb/core"
import { ServiceCase } from "../ontology/service-case"

export const closeServiceCase = defineAction("close-service-case", {
  description: "Close a resolved case with a documented outcome.",
})
  .on(ServiceCase)
  .params({ summary: optional(param("string")) })
  .validate(({ target }) => {
    if (target.properties.status !== "resolved") {
      throw new Error(
        `[Northline] Cannot close ${target.properties.number}: equipment recovery is not verified.`
      )
    }
  })
  .edits(({ objects, params, run, subject }) => {
    objects(ServiceCase)
      .byId(subject.primaryId)
      .update({
        status: "closed",
        nextAction: "No action required",
        resolutionSummary:
          params.summary ?? "Equipment recovery verified and service documentation completed.",
        closedAt: run.startedAt,
      })
  })
