import { defineAction } from "@sixb/core"
import { Campaign } from "../ontology/campaign"

export const markReviewed = defineAction("mark-reviewed")
  .on(Campaign)
  .params({})
  .edits(({ objects, subject }) => {
    objects(Campaign).byId(subject.primaryId).update({ reviewed: true })
  })
