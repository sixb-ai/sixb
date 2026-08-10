# Event schedules

An event schedule describes *when* a domain event should start work. Attach one to a sync,
pipeline, or [workflow](../workflows/overview.md) that should react to a typed event.

Like a cron schedule, it is declarative and has no handler. It adds a source event selector and an
optional condition, then is passed to a consumer with `.when(schedule, mapper?)`.

The orchestrator evaluates event schedules and enqueues matching work. Retained events are replayed
after downtime, and generated run ids are deterministic per schedule, consumer, and source event.

## Define an event schedule

Put schedule definitions in `schedules/` and export them.

File: `schedules/invoices.ts`

```ts
import { defineSchedule, events } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const highValuePaymentLinked = defineSchedule("invoice.high-value-payment-linked")
  .on(events.object(Invoice).link(Invoice.l.payments).created())
  .where((event) => event.link.p.amount.gt(500))
```

| Part | Meaning |
| --- | --- |
| `defineSchedule("invoice.high-value-payment-linked")` | Names the schedule with a unique id |
| `.on(events.object(Invoice).link(Invoice.l.payments).created())` | Selects the source event |
| `.where(...)` | Optional edge condition on the event payload |

The `.where(...)` callback runs once at definition time. It produces serializable predicate data;
the callback itself is not stored.

## Select the source event

Use the `events.object(...)` builder to select object or link mutation events.

```ts
defineSchedule("invoice.created").on(events.object(Invoice).created())
defineSchedule("invoice.updated").on(events.object(Invoice).updated())
defineSchedule("invoice.deleted").on(events.object(Invoice).deleted())
```

Link events are selected from the source object type:

```ts
defineSchedule("invoice.payment-linked").on(events.object(Invoice).link(Invoice.l.payments).created())
defineSchedule("invoice.payment-updated").on(events.object(Invoice).link(Invoice.l.payments).updated())
defineSchedule("invoice.payment-deleted").on(events.object(Invoice).link(Invoice.l.payments).deleted())
```

You can narrow the source to a property operation:

```ts
defineSchedule("invoice.amount-updated").on(events.object(Invoice).p.amount.updated())

defineSchedule("invoice.payment-amount-created").on(
  events.object(Invoice).link(Invoice.l.payments).p.amount.created()
)
```

Property selectors support `.created()`, `.updated()`, and `.cleared()`.

Rules and actions are selected from their definitions:

```ts
defineSchedule("invoice.at-risk").on(events.rule(invoiceAtRisk).triggered())
defineSchedule("invoice.risk-resolved").on(events.rule(invoiceAtRisk).resolved())

defineSchedule("invoice.approval-requested").on(events.action(approveInvoice).requested())
defineSchedule("invoice.approved").on(events.action(approveInvoice).completed())
defineSchedule("invoice.approval-failed").on(events.action(approveInvoice).failed())
```

Rule and action selectors already encode the occurrence and do not expose `.where(...)`.

Datasets, syncs, and pipelines use definition tokens too. Run outcomes are explicit; there is no
ambiguous `.finished()` selector.

```ts
defineSchedule("invoices-updated").on(events.dataset(invoices).updated())

defineSchedule("invoice-import-succeeded").on(events.sync(importInvoices).succeeded())
defineSchedule("invoice-import-failed").on(events.sync(importInvoices).failed())
defineSchedule("invoice-import-cancelled").on(events.sync(importInvoices).cancelled())

defineSchedule("normalization-succeeded").on(events.pipeline(normalizeInvoices).succeeded())
```

## Add an event condition

Conditions read the event payload after the mutation. For object events, use `event.object`; for
link events, use `event.link`.

```ts
export const highValueInvoice = defineSchedule("invoice.high-value")
  .on(events.object(Invoice).updated())
  .where((event) => event.object.p.amount.gt(500))
```

```ts
export const highValueUsdPayment = defineSchedule("invoice.high-value-usd-payment")
  .on(events.object(Invoice).link(Invoice.l.payments).created())
  .where((event) =>
    event.link.all(event.link.p.amount.gt(500), event.link.p.currency.eq("USD"))
  )
```

Link conditions can also select a typed target identity without loading target state:

```ts
defineSchedule("invoice.wire-payment")
  .on(events.object(Invoice).link(Invoice.l.payments).created())
  .where((event) =>
    event.link.all(event.target.is(WirePayment), event.link.p.amount.gt(500))
  )
```

Event schedule conditions are edge-triggered: evaluation checks whether the predicate becomes true
after the observed mutation. Previous values are not part of the public DSL.

## Predicates

| Need | Predicate |
| --- | --- |
| Equal / not equal | `eq(value)`, `notEq(value)` |
| Compare numbers | `gt(n)`, `gte(n)`, `lt(n)`, `lte(n)` |
| Property is set | `isPresent()`, `isMissing()` |
| Combine | `all(...)`, `any(...)`, `not(...)` |

`eq` / `notEq` take a string, number, boolean, or `null`. The comparison predicates take a number.
Event conditions only expose properties for the selected event scope; link predicates like
`exists()` are part of [rules](../rules/overview.md), not schedule conditions.

## Bind to a workflow

Attach an event schedule to a workflow with `.when(schedule, mapper?)`.

```ts
import { defineWorkflow, defineWorkflowStep, ref } from "@sixb/core"
import { Payment } from "../ontology/payment"
import { Invoice } from "../ontology/invoice"
import { highValuePaymentLinked } from "../schedules/invoices"

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
  .when(highValuePaymentLinked, ({ event }) => ({
    invoice: event.source,
    payment: event.target,
    amount: event.link.p.amount,
  }))
  .then(reviewPayment)
```

Use a mapper when the workflow input is not empty. The mapper receives a typed event context:

| Event source | Mapper context |
| --- | --- |
| Object event | `event.object.objectTypeId`, `event.object.primaryId`, `event.object.p.*` |
| Link event | `event.source`, `event.target`, `event.link.id`, `event.link.p.*` |
| Rule event | `event.ruleId`, `event.subject` |
| Action requested | `event.actionId`, `event.runId`, `event.subject`, `event.params` |
| Action completed | `event.actionId`, `event.runId`, `event.subject` |
| Action failed | `event.actionId`, `event.runId`, `event.subject`, `event.error` |
| Dataset updated | `event.datasetId`, `event.versionId`, `event.producer` |
| Sync outcome | `event.syncId`, `event.runId`, `event.status`, optional dataset/version ids |
| Pipeline outcome | `event.pipelineId`, `event.runId`, `event.status`, optional dataset/version ids |

If the workflow input is `{}`, the mapper is optional:

```ts
defineWorkflow("refresh-dashboard").input({}).when(highValuePaymentLinked)
```

Syncs and pipelines use the same schedule definition without a mapper:

```ts
definePipeline("normalize-invoices").when(invoicesUpdated).then(normalizeInvoices)
```

## Register schedules

`createSixb()` discovers exported schedule definitions from `schedules/` automatically:

```txt
your-project/
  ontology/
    invoice.ts
    payment.ts
  schedules/
    invoices.ts
  workflows/
    review-high-value-payment.ts
  sixb.config.ts
```

To register schedules explicitly, pass them to `createSixb()`:

```ts
import { createSixb } from "@sixb/core"
import { Invoice } from "./ontology/invoice"
import { Payment } from "./ontology/payment"
import { highValuePaymentLinked } from "./schedules/invoices"
import { reviewHighValuePayment } from "./workflows/review-high-value-payment"

const sixb = await createSixb({
  ontologies: [Invoice, Payment],
  schedules: [highValuePaymentLinked],
  workflows: [reviewHighValuePayment],
})
```

Inspect registered schedules with `sixb.schedules.list()` and `sixb.schedules.getById(id)`.

## Event schedule vs rule

Schedules decide *when to start work*; [rules](../rules/overview.md) decide *whether a state is
currently true*.

| Need | Use |
| --- | --- |
| Start a workflow from an object, link, rule, or action event | Event schedule |
| Add a threshold or payload condition to that event | Event schedule |
| Track active/resolved state for an object | [Rule](../rules/overview.md) |
| Run a multi-step business process | [Workflow](../workflows/overview.md) |
| Run on a clock | [Cron schedule](./overview.md) |

## Notes

- Schedule ids must be unique.
- Sources must select a terminal event operation.
- Conditions are validated against the resolved ontology at startup. Unknown properties and empty
  `all()` / `any()` groups are rejected.
- Object event schedules can only use `event.object` conditions; link event schedules use `event.link`
  conditions.
- Rule, action, dataset, sync, and pipeline event sources do not support additional conditions.

## Related

- [Workflows](../workflows/overview.md) — attach schedules with `.when(schedule, mapper?)`
- [Events & Webhooks](../events/overview.md) — event log and event selectors
- [Rules](../rules/overview.md) — long-lived business conditions
- [Cron schedules](./overview.md) — clock-based schedules
