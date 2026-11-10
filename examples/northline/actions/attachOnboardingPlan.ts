import { defineAction, param, ref } from "@sixb/core"
import { ServiceContract } from "../ontology/service-contract"

export const attachOnboardingPlan = defineAction("attach-onboarding-plan", {
  description: "Attach the plan the contract's start is reviewed with, alongside the customer.",
})
  .on(ServiceContract)
  .params({ plan: param(ref.artifact()) })
  .edits(({ objects, params, subject }) => {
    objects(ServiceContract).byId(subject.primaryId).update({ onboardingPlan: params.plan })
  })
