import { defineAction, param, ref } from "@sixb/core"
import { stringEnum } from "@sixb/core/ontology"
import { businessSystemConnector } from "../connectors/business-system"
import { Quote } from "../ontology/quote"
import { ServiceCase } from "../ontology/service-case"

export const recordQuoteDecision = defineAction("record-quote-decision", {
  description: "Record a customer quote decision and return approved work to dispatch.",
})
  .on(Quote)
  .params({
    serviceCase: param(ref(ServiceCase)),
    decision: param(stringEnum(["approved", "declined"])),
  })
  .validate(({ target }) => {
    if (target.properties.status !== "sent" && target.properties.status !== "internal_review") {
      throw new Error(
        `[Northline] Cannot decide ${target.properties.number}: the quote is '${target.properties.status}'.`
      )
    }
  })
  .writeback(async ({ params, run, sixb, target }) => {
    const business = await sixb.connectors.connect(businessSystemConnector)
    return business.recordQuoteDecision(
      target.primaryId,
      params.decision,
      run.idempotencyKey ?? run.id
    )
  })
  .edits(({ objects, params, subject, writeback }) => {
    objects(Quote).byId(subject.primaryId).update({
      status: writeback.status,
      decisionAt: writeback.decision_at,
      sourceUpdatedAt: writeback.updated_at,
    })
    objects(ServiceCase)
      .byId(params.serviceCase.primaryId)
      .update(
        params.decision === "approved"
          ? { status: "dispatching", nextAction: "Schedule approved repair" }
          : {
              status: "resolved",
              nextAction: "Document customer decision and close",
              resolutionSummary: "Customer declined the proposed repair.",
            }
      )
  })
