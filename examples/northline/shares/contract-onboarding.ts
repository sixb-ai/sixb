import { can, defineShare } from "@sixb/core"
import { ServiceContract } from "../ontology/service-contract"

// A link a customer opens without an account: their contract, its customer and facilities, and
// the onboarding plan the contract holds, which they follow live and comment on as a guest.
export const contractOnboardingShare = defineShare("contract-onboarding", {
  target: ServiceContract,
  grants: ({ target }) => [
    can.view(target).withLinks([ServiceContract.l.customer, ServiceContract.l.coveredFacilities]),
  ],
})
