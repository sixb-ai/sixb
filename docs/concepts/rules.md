# Rules

A rule watches an ontology object for a business condition.

Use rules for statements like "a posted transaction must have a document" or "a critical task
should have an owner."

A rule does not fetch data, transform rows, or run a process by itself. It names the condition,
watches object and link changes, and emits a transition when the condition starts or clears.

## Why it is useful

Business software usually has conditions people care about:

- invoices that are overdue
- tasks that are critical and unassigned
- customers that need an account manager
- transactions that are missing a source document

Rules give those conditions one typed place to live. Apps, alerts, and workflows can then react
to the same definition.

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

This rule is triggered when a `Transaction` does not have a `document` link.

## What each part does

| Part | Meaning |
| --- | --- |
| `defineRule("transaction.requires-document")` | Names the rule |
| `.on(Transaction)` | Chooses the object type the rule watches |
| `.where(...)` | Describes when the rule should be triggered |
| `tx.l.document.isMissing()` | Checks that the `document` link does not exist |

## Property conditions

Use `p` for object properties.

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

This rule is triggered when an invoice is overdue, or when a sent invoice has a large amount.

## Link conditions

Use `l` for ontology links.

```ts
import { defineRule } from "@sixb/core"
import { Customer } from "../ontology/customer"

export const customerNeedsOwner = defineRule("customer.needs-owner")
  .on(Customer)
  .where((customer) => customer.l.accountManager.isMissing())
```

This rule is triggered when a `Customer` does not have an `accountManager` link.

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

This rule is triggered when a task is critical, not done, and missing an assignee.

## Predicates

| Need | Use |
| --- | --- |
| Equal or not equal | `eq(value)`, `notEq(value)` |
| Compare numbers | `gt(value)`, `gte(value)`, `lt(value)`, `lte(value)` |
| Check a property value | `isPresent()`, `isMissing()` |
| Check a link | `exists()`, `isMissing()` |
| Combine conditions | `all(...)`, `any(...)`, `not(...)` |

Predicate values can be strings, numbers, booleans, or `null`.

## Rule vs workflow

Rules and workflows solve different problems.

| Need | Use |
| --- | --- |
| Know whether an object needs attention | Rule |
| Emit a triggered or resolved signal | Rule |
| Run a multi-step process | Workflow |
| Fetch source data | Sync |
| Clean or join table data | Pipeline |

A good rule: rules decide if something is true; workflows decide what to do next.

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

`createSixb()` discovers exported rule definitions from `rules/` automatically.

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
start follow-up work.

## Extra details

- rule ids must be unique.
- rules are scoped to one ontology object type.
- predicates are validated against the registered ontology at startup.
- empty `all()` and `any()` groups are rejected.
- the `.where(...)` callback creates serializable rule data; the callback is not stored.
- rule evaluation reacts to object and link changes after the worker starts.
- active rule state is stored in `storage.rules`, which prevents duplicate triggers.
- registered rules can be inspected with `sixb.getRuleDefinitions()` and `sixb.getRuleById(...)`.

The important first step is to describe the business condition clearly before writing the
predicate.
