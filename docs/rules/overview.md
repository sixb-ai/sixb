# Rules

A rule tracks a condition on your objects and signals when an object starts or stops matching.
Use rules to detect states such as an invoice needing review.

## Define a rule

Give each rule a unique ID and export it from `rules/`. Sixb discovers it automatically. Select
an [object type](../ontology/object-types.md) with `.on()` and its condition with `.where()`:

File: `rules/invoices.ts`

```ts
import { defineRule } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const invoiceNeedsReview = defineRule("invoice.needs-review")
  .on(Invoice)
  .where((invoice) => invoice.p.status.eq("submitted"))
```

When an invoice starts matching, Sixb emits `rule.triggered`. When it stops matching, Sixb emits
`rule.resolved`. Further changes while it remains active do not create a new transition. It can
trigger again after resolving.

Sixb evaluates the condition as objects and links change. Open **Rules** in Atlas to inspect
active matches.

## Combine conditions

Use `p` for properties and `l` for relationships. Combine conditions with `all()`, `any()`, and
`not()`. For example, narrow the rule to submitted invoices of at least 10,000 with no reviewer
assigned, using the invoice's numeric `amount` property and `reviewer` link:

```ts
.where((invoice) =>
  invoice.all(
    invoice.p.status.eq("submitted"),
    invoice.p.amount.gte(10_000),
    invoice.l.reviewer.isMissing()
  )
)
```

| Condition | Methods |
| --- | --- |
| Equal or not equal | `eq(value)`, `notEq(value)` |
| Numeric comparison | `gt(value)`, `gte(value)`, `lt(value)`, `lte(value)` |
| Property has a value | `isPresent()`, `isMissing()` |
| Relationship exists | `exists()`, `isMissing()` |
| Combine conditions | `all(...)`, `any(...)`, `not(...)` |

Values are typed to the property. For decimal properties, use `decimal()` from `@sixb/core` to
create comparison values, such as `decimal("10000")`.

## Start a workflow

A rule identifies the condition; a workflow defines what happens next. Create an
[event schedule](../schedules/overview.md#run-on-an-event) for the rule's triggered signal:

File: `schedules/invoices.ts`

```ts
import { defineSchedule, events } from "@sixb/core"
import { invoiceNeedsReview } from "../rules/invoices"

export const invoiceReviewRequested = defineSchedule("invoice.review-requested")
  .on(events.rule(invoiceNeedsReview).triggered())
```

Attach the schedule to a workflow with `.when()` and pass the matching invoice into its input.
Here, `reviewInvoice` is a [step you define](../workflows/overview.md#define-a-workflow) that accepts
an invoice reference:

File: `workflows/invoice-review.ts`

```ts
import { defineWorkflow, ref } from "@sixb/core"
import { Invoice } from "../ontology/invoice"
import { invoiceReviewRequested } from "../schedules/invoices"
import { reviewInvoice } from "./steps/review-invoice"

export const invoiceReview = defineWorkflow("invoice-review")
  .input({ invoice: ref(Invoice) })
  .when(invoiceReviewRequested, ({ event }) => ({ invoice: event.subject }))
  .then(reviewInvoice)
```

Use `.resolved()` instead of `.triggered()` to start work when the condition clears. Rule events
can be delivered more than once, so make downstream operations safe to repeat.

See [Workflows](../workflows/overview.md) for defining steps and
[Human-in-the-Loop](../workflows/interventions.md) for pausing a workflow for review.
