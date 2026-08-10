import { defineAction, param, ref } from "@sixb/core"
import { businessSystemConnector } from "../connectors/business-system"
import { CustomerAccount } from "../ontology/customer-account"
import { Facility } from "../ontology/facility"
import { Quote } from "../ontology/quote"
import { ServiceCase } from "../ontology/service-case"
import { ServiceVisit } from "../ontology/service-visit"

export const prepareRepairQuote = defineAction("prepare-repair-quote", {
  description: "Create a business-system quote from an uncovered field diagnosis.",
})
  .on(ServiceCase)
  .params({
    customer: param(ref(CustomerAccount)),
    facility: param(ref(Facility)),
    originatingVisit: param(ref(ServiceVisit)),
    scope: param("string"),
    reason: param("string"),
    amount: param("double"),
    validUntil: param("date"),
  })
  .validate(({ params, target }) => {
    if (target.properties.status !== "awaiting_authorization") {
      throw new Error(
        `[Northline] Cannot prepare a quote for ${target.properties.number}: authorization is not required.`
      )
    }
    if (params.amount <= 0) throw new Error("[Northline] Quote amount must be greater than zero.")
  })
  .writeback(async ({ params, run, sixb, target }) => {
    const business = await sixb.connectors.connect(businessSystemConnector)
    return business.createQuote(
      {
        customerId: params.customer.primaryId,
        facilityId: params.facility.primaryId,
        serviceCaseId: target.primaryId,
        originatingVisitId: params.originatingVisit.primaryId,
        scope: params.scope,
        reason: params.reason,
        amount: params.amount,
        validUntil: params.validUntil.toISOString().slice(0, 10),
      },
      run.idempotencyKey ?? run.id
    )
  })
  .edits(({ objects, params, subject, writeback }) => {
    const quote = objects(Quote).create({
      id: writeback.quote_id,
      number: writeback.quote_number,
      scope: writeback.scope,
      reason: writeback.reason,
      amount: writeback.amount,
      currency: writeback.currency,
      status: writeback.status,
      validUntil: writeback.valid_until,
      sourceUpdatedAt: writeback.updated_at,
    })
    quote.link(Quote.l.customer, objects(CustomerAccount).byId(params.customer.primaryId))
    quote.link(Quote.l.facility, objects(Facility).byId(params.facility.primaryId))
    quote.link(Quote.l.serviceCase, objects(ServiceCase).byId(subject.primaryId))
    quote.link(
      Quote.l.originatingVisit,
      objects(ServiceVisit).byId(params.originatingVisit.primaryId)
    )
    objects(ServiceCase)
      .byId(subject.primaryId)
      .update({
        status: "awaiting_authorization",
        nextAction: `Await customer decision on ${writeback.quote_number}`,
      })
  })
