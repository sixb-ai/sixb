import { defineAction, param, ref } from "@sixb/core"
import { Quote } from "../ontology/quote"

export const attachProposal = defineAction("attach-proposal", {
  description: "Attach the designed proposal the customer reads for this quote.",
})
  .on(Quote)
  .params({ proposal: param(ref.artifact()) })
  .edits(({ objects, params, subject }) => {
    objects(Quote).byId(subject.primaryId).update({ proposal: params.proposal })
  })
