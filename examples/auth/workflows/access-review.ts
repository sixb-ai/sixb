import { defineWorkflow, defineWorkflowStep, ref, type WorkflowDefinition } from "@sixb/core"
import { AccessRequest } from "../ontology/access-request"

const recordAccessReview = defineWorkflowStep("record-access-review")
  .input({ accessRequest: ref(AccessRequest) })
  .output({ accessRequest: ref(AccessRequest), reviewed: "boolean" })
  .run(async ({ input }) => ({ accessRequest: input.accessRequest, reviewed: true }))

export const runAccessReview: WorkflowDefinition = defineWorkflow("run-access-review")
  .input({ accessRequest: ref(AccessRequest) })
  .then(recordAccessReview)
