import type { ObjectRef } from "../src"
import {
  defineObjectType,
  defineTrigger,
  defineWorkflow,
  defineWorkflowStep,
  events,
  link,
  prop,
  ref,
} from "../src"

const Payment = defineObjectType({
  id: "Payment",
  name: "Payment",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string"),
    prop("amount", "double"),
  ],
  links: [
    link("payments", Payment, {
      cardinality: "many",
      properties: [prop("amount", "double"), prop("currency", "string")],
    }),
  ],
})

const highValuePayment = defineTrigger("invoice.high-value-payment")
  .on(events(Invoice).link(Invoice.l.payments).created())
  .where((event) => {
    event.link.p.amount.gt(500)
    event.link.p.currency.eq("USD")

    // @ts-expect-error object state is not exposed on link trigger conditions in V1
    event.object

    // @ts-expect-error before/after are internal evaluation details
    event.link.before

    // @ts-expect-error unknown link properties are not exposed
    event.link.p.missing.eq("x")

    // @ts-expect-error numeric operators require numeric properties
    event.link.p.currency.gt(500)

    return event.link.p.amount.gt(500)
  })

defineTrigger("invoice.object-updated")
  .on(events(Invoice).updated())
  .where((event) => {
    event.object.p.status.eq("posted")
    event.object.p.amount.gte(500)

    // @ts-expect-error link event context is not exposed on object trigger conditions in V1
    event.link

    return event.object.any(event.object.p.status.eq("posted"), event.object.p.amount.gt(500))
  })

const reviewPayment = defineWorkflowStep("review-payment")
  .input({
    invoice: ref(Invoice),
    payment: ref(Payment),
    amount: "double",
  })
  .output({})
  .run(() => ({}))

defineWorkflow("review-high-payment")
  .input({
    invoice: ref(Invoice),
    payment: ref(Payment),
    amount: "double",
  })
  .when(highValuePayment, (event) => {
    const invoice: ObjectRef<"Invoice"> = event.source
    const payment: ObjectRef<"Payment"> = event.target
    const amount: number = event.link.p.amount

    // @ts-expect-error before/after are not part of the public event mapper context
    event.link.after

    return {
      invoice,
      payment,
      amount,
    }
  })
  .then(reviewPayment)

defineWorkflow("missing-trigger-mapper")
  .input({ invoice: ref(Invoice) })
  // @ts-expect-error workflows with input need a trigger mapper
  .when(highValuePayment)

defineWorkflow("empty-triggered-workflow")
  .input({})
  .when(highValuePayment)
  .then(
    defineWorkflowStep("empty-step")
      .input({})
      .output({})
      .run(() => ({}))
  )
