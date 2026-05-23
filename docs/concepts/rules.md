# Rules

Rules describe business conditions over ontology objects.


## What they are

- inert, serializable definitions
- scoped to a single ontology object type
- written as "where the rule is active"
- reactive to object and link changes
- validated at runtime startup against the registered ontology

Rules are useful for business logic that should be evaluated when object state changes. For
example, a finance application may require every transaction to be linked to a source document.


## Define a rule

File: `rules/transaction-requires-document.ts`

```ts
import { defineRule } from "@sixb/core"
import { Transaction } from "../ontology/transaction"

export const transactionRequiresDocument = defineRule("transaction.requires-document")
  .on(Transaction)
  .where((tx) => tx.l.document.isMissing())
```

The `.where(...)` predicate describes when the rule is active. In this example, the rule is
active for transactions that do not have a `document` link.

The resulting definition is serializable data:

```ts
{
  kind: "rule",
  id: "transaction.requires-document",
  subject: { kind: "object", objectTypeId: "transaction" },
  predicate: { kind: "link", linkId: "document", op: "isMissing" },
}
```

The callback is not retained. It is only used by the builder to produce the predicate AST.


## Predicates

The rule subject exposes typed property and link predicate builders for the selected object type:

```ts
defineRule("transaction.review-required")
  .on(Transaction)
  .where((tx) =>
    tx.all(
      tx.p.status.eq("posted"),
      tx.p.amount.gt(1000),
      tx.l.document.isMissing()
    )
  )
```

### Property predicates

| Predicate | Meaning |
| --- | --- |
| `eq(value)` | Property equals a scalar value |
| `notEq(value)` | Property does not equal a scalar value |
| `gt(value)` | Property is greater than a number |
| `gte(value)` | Property is greater than or equal to a number |
| `lt(value)` | Property is less than a number |
| `lte(value)` | Property is less than or equal to a number |
| `isPresent()` | Property value is not `null` or `undefined` |
| `isMissing()` | Property value is `null` or `undefined` |

### Link predicates

| Predicate | Meaning |
| --- | --- |
| `exists()` | At least one link exists for that link id from the subject object |
| `isMissing()` | No link exists for that link id from the subject object |

### Logical predicates

Use `all`, `any`, and `not` to compose predicates:

```ts
defineRule("transaction.missing-document-for-posted")
  .on(Transaction)
  .where((tx) =>
    tx.all(
      tx.p.status.eq("posted"),
      tx.not(tx.p.status.eq("void")),
      tx.any(tx.p.amount.gt(0), tx.l.document.isMissing())
    )
  )
```

Empty `all()` and `any()` groups are rejected during runtime startup validation.


## Discovery

`createSixb()` discovers rule definitions exported from `rules/`:

```txt
my-project/
  ontology/
    transaction.ts
  rules/
    transaction-requires-document.ts
```

You can also pass rules explicitly:

```ts
import { createSixb } from "@sixb/core"
import { transactionRequiresDocument } from "./rules/transaction-requires-document"

const sixb = await createSixb({
  ontologies: [Transaction],
  rules: [transactionRequiresDocument],
  broker,
  storage,
  lakeStorage,
  blobStorage,
  queues,
})
```

Registered rules can be inspected from the runtime:

```ts
sixb.getRuleDefinitions()
sixb.getRuleById("transaction.requires-document")
```


## Event dependencies

Rules are reactive to ontology object events. A rule does not declare schedules.

Use `deriveRuleEventDependencies()` to derive the domain events that can affect a rule:

```ts
import { deriveRuleEventDependencies } from "@sixb/core"

const dependencies = deriveRuleEventDependencies(transactionRequiresDocument)
```

For the transaction document rule, the dependencies are:

```ts
[
  { type: "object.upserted", objectTypeId: "transaction" },
  { type: "link.upserted", sourceTypeId: "transaction", linkId: "document" },
  { type: "link.removed", sourceTypeId: "transaction", linkId: "document" },
]
```

Property predicates are covered by `object.upserted`. Link predicates add `link.upserted` and
`link.removed` dependencies for each referenced link id.


## Runtime validation

At startup, Sixb rejects:

- duplicate rule ids
- rules whose subject object type is not registered
- property predicates for properties not on the subject object type
- link predicates for links not on the subject object type
- empty `all()` or `any()` predicate groups


## Rule transition events

The core event model includes rule transition events:

```ts
{
  type: "rule.triggered",
  topic: "rules",
  payload: {
    ruleId: "transaction.requires-document",
    subject: {
      kind: "object",
      objectTypeId: "transaction",
      primaryId: "tx-001",
    },
    triggeredAt: "2026-05-06T00:00:00.000Z",
  },
}
```

```ts
{
  type: "rule.resolved",
  topic: "rules",
  payload: {
    ruleId: "transaction.requires-document",
    subject: {
      kind: "object",
      objectTypeId: "transaction",
      primaryId: "tx-001",
    },
    resolvedAt: "2026-05-06T00:05:00.000Z",
  },
}
```

Rule transition events use a stable partition key:

```ts
`${ruleId}:${objectTypeId}:${primaryId}`
```


## Current scope

The current core rules surface defines and registers rules, validates rule definitions, derives
event dependencies, and adds rule transition event types. A full rule evaluator/runtime loop is
not included yet.
