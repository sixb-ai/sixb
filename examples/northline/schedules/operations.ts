import { defineSchedule, events } from "@sixb/core"
import { serviceCaseAwaitingQuote, serviceCaseNeedsDispatch } from "../rules/service-operations"

export const dispatchReviewRequested = defineSchedule("service-case.dispatch-review-requested").on(
  events.rule(serviceCaseNeedsDispatch).triggered()
)

export const quoteReviewRequested = defineSchedule("service-case.quote-review-requested").on(
  events.rule(serviceCaseAwaitingQuote).triggered()
)
