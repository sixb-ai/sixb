import type { WorkflowDefinition } from "@sixb/core"
import {
  defineIntervention,
  defineWorkflow,
  defineWorkflowStep,
  interventionField,
  ref,
} from "@sixb/core"
import { prepareRepairQuote } from "../actions/prepareRepairQuote"
import { CustomerAccount } from "../ontology/customer-account"
import { Facility } from "../ontology/facility"
import { ServiceCase } from "../ontology/service-case"
import { ServiceVisit } from "../ontology/service-visit"
import { quoteReviewRequested } from "../schedules/operations"

const loadRepairContext = defineWorkflowStep("load-repair-context")
  .input({ serviceCase: ref(ServiceCase) })
  .output({
    serviceCase: ref(ServiceCase),
    customer: ref(CustomerAccount),
    facility: ref(Facility),
    originatingVisit: ref(ServiceVisit),
    caseNumber: "string",
    scope: "string",
    reason: "string",
    amount: "double",
    validUntil: "date",
  })
  .run(async ({ input, sixb }) => {
    const serviceCase = await sixb.objects(ServiceCase).get(input.serviceCase.primaryId)
    if (!serviceCase) {
      throw new Error(`[Northline] Service case '${input.serviceCase.primaryId}' was not found.`)
    }
    const [customerLink] = await sixb
      .objects(ServiceCase)
      .byId(serviceCase.primaryId)
      .listLinks(ServiceCase.l.customer)
    const [facilityLink] = await sixb
      .objects(ServiceCase)
      .byId(serviceCase.primaryId)
      .listLinks(ServiceCase.l.facility)
    if (!customerLink || !facilityLink || !serviceCase.properties.currentVisitId) {
      throw new Error(
        `[Northline] ${serviceCase.properties.number} is missing customer, facility, or visit context.`
      )
    }

    return {
      serviceCase: input.serviceCase,
      customer: { objectTypeId: CustomerAccount.id, primaryId: customerLink.targetId },
      facility: { objectTypeId: Facility.id, primaryId: facilityLink.targetId },
      originatingVisit: {
        objectTypeId: ServiceVisit.id,
        primaryId: serviceCase.properties.currentVisitId,
      },
      caseNumber: serviceCase.properties.number,
      scope: "Replace the failed supply-fan variable-frequency drive and recommission RTU-7.",
      reason: "Major replacement components are excluded from PriorityCare parts coverage.",
      amount: 4280,
      validUntil: new Date(Date.now() + 14 * 24 * 60 * 60_000),
    }
  })

export const reviewRepairQuote = defineIntervention("review-repair-quote", {
  description: "Review repair scope and price before the quote is sent.",
})
  .input({
    serviceCase: ref(ServiceCase),
    customer: ref(CustomerAccount),
    facility: ref(Facility),
    originatingVisit: ref(ServiceVisit),
    caseNumber: "string",
    scope: "string",
    reason: "string",
    amount: "double",
    validUntil: "date",
  })
  .response({
    scope: interventionField("string"),
    amount: interventionField("double"),
  })
  .defaults(({ input }) => ({ scope: input.scope, amount: input.amount }))

export const repairAuthorizationWorkflow: WorkflowDefinition = defineWorkflow(
  "repair-authorization"
)
  .input({ serviceCase: ref(ServiceCase) })
  .when(quoteReviewRequested, ({ event }) => ({ serviceCase: event.subject }))
  .then(loadRepairContext)
  .then(reviewRepairQuote)
  .then(prepareRepairQuote, ({ steps }) => ({
    subject: steps.loadRepairContext.serviceCase,
    params: {
      customer: steps.loadRepairContext.customer,
      facility: steps.loadRepairContext.facility,
      originatingVisit: steps.loadRepairContext.originatingVisit,
      scope: steps.reviewRepairQuote.scope,
      reason: steps.loadRepairContext.reason,
      amount: steps.reviewRepairQuote.amount,
      validUntil: asDate(steps.loadRepairContext.validUntil),
    },
  }))

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value)
}
