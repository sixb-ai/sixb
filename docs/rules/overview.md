# Rules

A rule watches an ontology object for a business condition.

Use rules for statements like "a posted transaction must have a document" or "a critical task
should have an owner."

A rule does not fetch data, transform rows, or run a process by itself. It names the condition,
watches object and link changes, and signals when the condition starts or clears.

## Why rules are useful

Business software usually has conditions people care about:

- invoices that are overdue
- tasks that are critical and unassigned
- customers that need an account manager
- transactions that are missing a source document

Rules give those conditions one typed place to live. Apps, alerts, and [workflows](../workflows/overview.md)
can then react to the same definition.

Write the rule as the state where the object needs attention.

## Define a rule

File: `rules/transaction-requires-document.ts`

```ts
import { defineRule } from "@sixb/core"
import { Transaction } from "../ontology/transaction"

export const transactionRequiresDocument = defineRule("transaction.requires-document")
  .on(Transaction)
  .where((tx) => tx.l.document.isMissing())
```

This rule matches when a `Transaction` does not have a `document` link.

| Part | Meaning |
| --- | --- |
| `defineRule("transaction.requires-document")` | Names the rule with a unique id |
| `.on(Transaction)` | The [object type](../ontology/object-types.md) the rule watches |
| `.where(...)` | Describes when the rule matches |
| `tx.l.document.isMissing()` | Checks that the `document` link does not exist |

The `.where(...)` callback receives a typed subject built from the object type. Its `p` and `l`
keys are the object type's property and [link](../ontology/links.md) ids.

## Property conditions

Use `p` for object [properties](../ontology/properties.md).

```ts
import { defineRule } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const invoiceCollectionRisk = defineRule("invoice.collection-risk")
  .on(Invoice)
  .where((invoice) =>
    invoice.any(
      invoice.p.status.eq("overdue"),
      invoice.all(invoice.p.status.eq("sent"), invoice.p.amount.gte(40000))
    )
  )
```

This rule matches when an invoice is overdue, or when a sent invoice has a large amount.

## Link conditions

Use `l` for ontology links.

```ts
import { defineRule } from "@sixb/core"
import { Customer } from "../ontology/customer"

export const customerNeedsOwner = defineRule("customer.needs-owner")
  .on(Customer)
  .where((customer) => customer.l.accountManager.isMissing())
```

This rule matches when a `Customer` does not have an `accountManager` link.

## Compose conditions

Use `all`, `any`, and `not` to combine smaller conditions.

```ts
import { defineRule } from "@sixb/core"
import { Task } from "../ontology/task"

export const taskCriticalUnassigned = defineRule("task.critical-unassigned")
  .on(Task)
  .where((task) =>
    task.all(
      task.p.priority.eq("critical"),
      task.not(task.p.status.eq("done")),
      task.l.assignee.isMissing()
    )
  )
```

This rule matches when a task is critical, not done, and missing an assignee.

## Predicates

| Need | Use |
| --- | --- |
| Equal or not equal | `eq(value)`, `notEq(value)` |
| Compare numbers | `gt(value)`, `gte(value)`, `lt(value)`, `lte(value)` |
| Check a property exists | `isPresent()`, `isMissing()` |
| Check a link | `exists()`, `isMissing()` |
| Combine conditions | `all(...)`, `any(...)`, `not(...)` |

Predicate values can be strings, numbers, booleans, or `null`. The comparison predicates
(`gt`, `gte`, `lt`, `lte`) take a number. Property `isPresent` / `isMissing` and the link
predicates take no value.

## Rule vs workflow

Rules and workflows solve different problems.

| Need | Use |
| --- | --- |
| Know whether an object needs attention | Rule |
| Emit a triggered or resolved signal | Rule |
| Run a multi-step process | [Workflow](../workflows/overview.md) |
| Fetch source data | [Sync](../data/syncs.md) |
| Clean or join table data | [Pipeline](../data/pipelines.md) |

A good split: rules decide if something is true; workflows decide what to do next.

## Convention

Put rule definitions in `rules/` and export them.

```txt
your-project/
  ontology/
    transaction.ts
  rules/
    transaction-requires-document.ts
  sixb.config.ts
```

`createSixb()` discovers exported rule definitions from `rules/` automatically. See
[Project structure](../fundamentals/project-structure.md) for the full convention layout.

You can also register rules explicitly:

```ts
import { createSixb } from "@sixb/core"
import { Transaction } from "./ontology/transaction"
import { transactionRequiresDocument } from "./rules/transaction-requires-document"

export const sixb = createSixb({
  ontology: [Transaction],
  rules: [transactionRequiresDocument],
})
```

## How to model rules

Start with one plain sentence.

1. Pick the ontology object type the rule watches.
2. Write the condition in normal language.
3. Convert that condition into property and link predicates.
4. Keep the first version small.
5. Add `all`, `any`, or `not` only when the condition needs them.

Good rule names describe the condition:

- `transaction.requires-document`
- `invoice.collection-risk`
- `customer.needs-owner`
- `task.critical-unassigned`

## What happens when a rule matches

Once registered, Sixb evaluates rules as ontology objects and links change.

When a rule starts matching an object, it is triggered. When the object no longer matches, it is
resolved.

That gives the rest of your app a stable signal to show attention states, send notifications, or
start follow-up [workflows](../workflows/overview.md).

## Details

- Rule ids must be unique.
- Rules are scoped to one ontology object type.
- Predicates are validated against the registered ontology at startup; unknown properties or
  links and empty `all()` / `any()` groups are rejected.
- The `.where(...)` callback produces serializable predicate data. The callback itself is not
  stored.
- Rule evaluation reacts to `object.upserted` for the subject type, plus `link.upserted` and
  `link.removed` for any links referenced in the predicate.
- Active rule state is stored in `storage.rules`, which prevents duplicate triggers.
- Registered rules can be inspected at runtime with `sixb.getRuleDefinitions()` and
  `sixb.getRuleById(ruleId)`.

The important first step is to describe the business condition clearly before writing the
predicate.

## Related

- [Workflows](../workflows/overview.md) — run a multi-step process in response to a signal
- [Interventions](../workflows/interventions.md) — human-in-the-loop steps
- [Events](../events/overview.md) — the domain events rules react to
- [Object types](../ontology/object-types.md) and [Links](../ontology/links.md)
