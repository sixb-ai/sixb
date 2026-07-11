import type { InferScheduleEvent, ObjectRef } from "../src"
import {
  defineAction,
  defineObjectType,
  defineSchedule,
  defineWorkflow,
  events,
  param,
  prop,
  ref,
} from "../src"

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const approveInvoice = defineAction("approve-invoice")
  .on(Invoice)
  .params({ reason: param("string") })
  .writeback(async () => {})

const approvalRequested = defineSchedule("invoice.approval-requested").on(
  events.action(approveInvoice).requested()
)

const approvalCompleted = defineSchedule("invoice.approval-completed").on(
  events.action(approveInvoice).completed()
)

// @ts-expect-error action sources do not expose state predicates
approvalCompleted.where(() => ({ kind: "becomesTrue" }))

declare const requestedEvent: InferScheduleEvent<typeof approvalRequested>
const requestedInvoice: ObjectRef<"Invoice"> = requestedEvent.subject
const requestedReason: string = requestedEvent.params.reason

declare const completedEvent: InferScheduleEvent<typeof approvalCompleted>
const completedInvoice: ObjectRef<"Invoice"> = completedEvent.subject

// @ts-expect-error completed action events do not carry request params
completedEvent.params

// @ts-expect-error actions do not expose a public result today
completedEvent.result

void requestedInvoice
void requestedReason
void completedInvoice

defineWorkflow("observe-approval-request")
  .input({ invoice: ref(Invoice), reason: "string" })
  .when(approvalRequested, ({ event }) => ({
    invoice: event.subject,
    reason: event.params.reason,
  }))

defineWorkflow("observe-approval-completion")
  .input({ invoice: ref(Invoice) })
  .when(approvalCompleted, ({ event }) => ({ invoice: event.subject }))
