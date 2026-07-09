# Triggers

A trigger describes *when* a domain event should start work. Reach for triggers when a
[workflow](../workflows/overview.md) should react to a typed object or link mutation, for example
when a payment is linked to an invoice and the payment amount crosses a threshold.

A trigger is declarative. It has a source event selector, an optional condition, and no handler.
Pass it to a workflow with `.when(trigger, mapper?)`.

> V1 note: trigger definitions, discovery, validation, and workflow `.when(...)` bindings are
> available. Runtime evaluation and automatic workflow enqueueing from domain triggers land in the
> worker slice; until then, workflows can still be requested manually.

## Define a trigger

Put trigger definitions in `triggers/` and export them.

File: `triggers/invoices.ts`

```ts
import { defineTrigger, events } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const highValuePaymentLinked = defineTrigger("invoice.high-value-payment-linked")
  .on(events(Invoice).link(Invoice.l.payments).created())
  .where((event) => event.link.p.amount.gt(500))
```

| Part | Meaning |
| --- | --- |
| `defineTrigger("invoice.high-value-payment-linked")` | Names the trigger with a unique id |
| `.on(events(Invoice).link(Invoice.l.payments).created())` | Selects the source event |
| `.where(...)` | Optional edge condition on the event payload |

The `.where(...)` callback runs once at definition time. It produces serializable predicate data;
the callback itself is not stored.

## Select the source event

Use the `events(...)` builder to select object or link mutation events.

```ts
defineTrigger("invoice.created").on(events(Invoice).created())
defineTrigger("invoice.updated").on(events(Invoice).updated())
defineTrigger("invoice.deleted").on(events(Invoice).deleted())
```

Link events are selected from the source object type:

```ts
defineTrigger("invoice.payment-linked").on(events(Invoice).link(Invoice.l.payments).created())
defineTrigger("invoice.payment-updated").on(events(Invoice).link(Invoice.l.payments).updated())
defineTrigger("invoice.payment-deleted").on(events(Invoice).link(Invoice.l.payments).deleted())
```

You can narrow the source to a property operation:

```ts
defineTrigger("invoice.amount-updated").on(events(Invoice).p.amount.updated())

defineTrigger("invoice.payment-amount-created").on(
  events(Invoice).link(Invoice.l.payments).p.amount.created()
)
```

Property selectors support `.created()`, `.updated()`, and `.cleared()`.

## Add an event condition

Conditions read the event payload after the mutation. For object events, use `event.object`; for
link events, use `event.link`.

```ts
export const highValueInvoice = defineTrigger("invoice.high-value")
  .on(events(Invoice).updated())
  .where((event) => event.object.p.amount.gt(500))
```

```ts
export const highValueUsdPayment = defineTrigger("invoice.high-value-usd-payment")
  .on(events(Invoice).link(Invoice.l.payments).created())
  .where((event) =>
    event.link.all(event.link.p.amount.gt(500), event.link.p.currency.eq("USD"))
  )
```

Trigger conditions are modeled as edge-triggered: evaluation checks whether the predicate becomes
true after the observed mutation. Previous values are not part of the public trigger DSL.

## Predicates

| Need | Predicate |
| --- | --- |
| Equal / not equal | `eq(value)`, `notEq(value)` |
| Compare numbers | `gt(n)`, `gte(n)`, `lt(n)`, `lte(n)` |
| Property is set | `isPresent()`, `isMissing()` |
| Combine | `all(...)`, `any(...)`, `not(...)` |

`eq` / `notEq` take a string, number, boolean, or `null`. The comparison predicates take a number.
Trigger conditions only expose properties for the selected event scope; link predicates like
`exists()` are part of [rules](../rules/overview.md), not trigger conditions.

## Bind to a workflow

Attach a trigger to a workflow with `.when(trigger, mapper?)`.

```ts
import { defineWorkflow, defineWorkflowStep, ref } from "@sixb/core"
import { Payment } from "../ontology/payment"
import { Invoice } from "../ontology/invoice"
import { highValuePaymentLinked } from "../triggers/invoices"

const reviewPayment = defineWorkflowStep("review-payment")
  .input({
    invoice: ref(Invoice),
    payment: ref(Payment),
    amount: "double",
  })
  .output({})
  .run(async () => ({}))

export const reviewHighValuePayment = defineWorkflow("review-high-value-payment")
  .input({
    invoice: ref(Invoice),
    payment: ref(Payment),
    amount: "double",
  })
  .when(highValuePaymentLinked, (event) => ({
    invoice: event.source,
    payment: event.target,
    amount: event.link.p.amount,
  }))
  .then(reviewPayment)
```

Use a mapper when the workflow input is not empty. The mapper receives a typed event context:

| Trigger source | Mapper context |
| --- | --- |
| Object event | `event.object.objectTypeId`, `event.object.primaryId`, `event.object.p.*` |
| Link event | `event.source`, `event.target`, `event.link.id`, `event.link.p.*` |

If the workflow input is `{}`, the mapper is optional:

```ts
defineWorkflow("refresh-dashboard").input({}).when(highValuePaymentLinked)
```

## Register triggers

`createSixb()` discovers exported trigger definitions from `triggers/` automatically:

```txt
your-project/
  ontology/
    invoice.ts
    payment.ts
  triggers/
    invoices.ts
  workflows/
    review-high-value-payment.ts
  sixb.config.ts
```

To register triggers explicitly, pass them to `createSixb()`:

```ts
import { createSixb } from "@sixb/core"
import { Invoice } from "./ontology/invoice"
import { Payment } from "./ontology/payment"
import { highValuePaymentLinked } from "./triggers/invoices"
import { reviewHighValuePayment } from "./workflows/review-high-value-payment"

const sixb = await createSixb({
  ontologies: [Invoice, Payment],
  triggers: [highValuePaymentLinked],
  workflows: [reviewHighValuePayment],
})
```

Inspect registered triggers with `sixb.getTriggerDefinitions()` and `sixb.getTriggerById(id)`.

## Trigger vs rule

Triggers decide *when to start work*; [rules](../rules/overview.md) decide *whether a state is
currently true*.

| Need | Use |
| --- | --- |
| Start a workflow from an object or link event | Trigger |
| Add a threshold or payload condition to that event | Trigger |
| Track active/resolved state for an object | [Rule](../rules/overview.md) |
| Run a multi-step business process | [Workflow](../workflows/overview.md) |
| Run on a clock | [Schedule](../schedules/overview.md) |

## Notes

- Trigger ids must be unique.
- Sources must select an object or link event operation: `.created()`, `.updated()`, or
  `.deleted()`.
- Conditions are validated against the resolved ontology at startup. Unknown properties and empty
  `all()` / `any()` groups are rejected.
- Object triggers can only use `event.object` conditions; link triggers can only use `event.link`
  conditions.

## Related

- [Workflows](../workflows/overview.md) — attach triggers with `.when(trigger, mapper?)`
- [Events & Webhooks](../events/overview.md) — event log and event selectors
- [Rules](../rules/overview.md) — long-lived business conditions
- [Schedules](../schedules/overview.md) — clock-based triggers
