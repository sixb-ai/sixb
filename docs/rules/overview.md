# Rules

A rule watches one [object type](../ontology/object-types.md) for a business condition and signals
when that condition starts or clears. Reach for rules to track health states like "this invoice is
overdue" or "this project is at risk."

A rule does not fetch data, transform rows, or run a process. It names the condition, reacts to
object and link changes, and emits a stable triggered/resolved signal that the rest of your app —
alerts, attention badges, [workflows](../workflows/overview.md) — can react to.

## Define a rule

Write a rule as the state where the object needs attention. Put each definition in `rules/` and
export it.

File: `rules/business-health.ts`

```ts
import { defineRule } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const overdueInvoices = defineRule("invoice.overdue")
  .on(Invoice)
  .where((invoice) => invoice.p.status.eq("overdue"))
```

This matches when an `Invoice` has `status` of `"overdue"`.

| Part | Meaning |
| --- | --- |
| `defineRule("invoice.overdue")` | Names the rule with a unique id |
| `.on(Invoice)` | The object type the rule watches |
| `.where(...)` | Describes when the rule matches |

The `.where(...)` callback receives a typed subject built from the object type. Use `p` for
[properties](../ontology/properties.md) and `l` for [links](../ontology/links.md); both are keyed by
the type's ids.

## Compose conditions

Combine smaller conditions with `all`, `any`, and `not`. This rule flags an at-risk project — one
that is active, large, and missing a lead.

```ts
import { defineRule } from "@sixb/core"
import { Project } from "../ontology/project"

export const atRiskProjects = defineRule("project.at-risk")
  .on(Project)
  .where((project) =>
    project.all(
      project.p.status.eq("active"),
      project.p.budget.gte(150000),
      project.l.lead.isMissing()
    )
  )
```

Property predicates check values (`p`), link predicates check whether a relationship exists (`l`).
You can nest groups — for example, flag invoices that are overdue or large-and-still-sent:

```ts
export const collectionRisk = defineRule("invoice.collection-risk")
  .on(Invoice)
  .where((invoice) =>
    invoice.any(
      invoice.p.status.eq("overdue"),
      invoice.all(invoice.p.status.eq("sent"), invoice.p.amount.gte(40000))
    )
  )
```

## Predicates

| Need | Predicate |
| --- | --- |
| Equal / not equal | `eq(value)`, `notEq(value)` |
| Compare numbers | `gt(n)`, `gte(n)`, `lt(n)`, `lte(n)` |
| Property is set | `isPresent()`, `isMissing()` |
| Link is set | `exists()`, `isMissing()` |
| Combine | `all(...)`, `any(...)`, `not(...)` |

`eq` / `notEq` take a string, number, boolean, or `null`. The comparison predicates take a number.
`isPresent` / `isMissing` / `exists` take no value.

## How matching works

Once registered, Sixb evaluates rules as objects and links change. When a rule starts matching an
object, it is **triggered**; when the object stops matching, it is **resolved**. Active state is
tracked so each object triggers once until it clears.

Evaluation reacts to object/link `created`, `updated`, and `deleted` events for the watched type
and any links named in the predicate. See [Events](../events/overview.md) for the full domain-event
list.

The event only wakes evaluation: Rules always read current committed object/link state. A startup
and periodic reconciliation repairs events missed while the worker was offline and resolves active
state for deleted objects. Live evaluation and reconciliation share one serialized coordinator.

The pre-0.1 line supports one active Rules worker per project. Rule notifications are at-least-once,
so consumers must tolerate a duplicate around process failure.

## Reacting to the signal

A rule emits `rule.triggered` and `rule.resolved` [domain events](../events/overview.md). Consume
them by attaching an [event schedule](../schedules/events.md): select the occurrence with
`events.rule(rule).triggered()` (or `.resolved()`) and bind it to a workflow, sync, or pipeline.

```ts
import { defineSchedule, events } from "@sixb/core"
import { collectionRisk } from "../rules/business-health"

export const onCollectionRisk = defineSchedule("invoice.collection-risk-triggered")
  .on(events.rule(collectionRisk).triggered())
```

Attach `onCollectionRisk` to a workflow with `.when(...)` to act on it. In an app, subscribe to the
same signal live with the client `events.rules()` builder — see [client events](../client/events.md).

## Register rules

`createSixb()` discovers exported rule definitions from `rules/` automatically:

```txt
your-project/
  ontology/
    invoice.ts
    project.ts
  rules/
    business-health.ts
  sixb.config.ts
```

To register rules explicitly instead, pass them to `createSixb()` (note: it is async):

```ts
import { createSixb } from "@sixb/core"
import { Invoice } from "./ontology/invoice"
import { Project } from "./ontology/project"
import { overdueInvoices, atRiskProjects } from "./rules/business-health"

const sixb = await createSixb({
  ontologies: [Invoice, Project],
  rules: [overdueInvoices, atRiskProjects],
})
```

Inspect registered rules at runtime with `sixb.listRules()` and
`sixb.getRuleById(ruleId)`.

## Rule vs workflow

Rules decide *if* something is true; [workflows](../workflows/overview.md) decide *what to do next*.

| Need | Use |
| --- | --- |
| Know whether an object needs attention | Rule |
| Emit a triggered / resolved signal | Rule |
| Run a multi-step process | [Workflow](../workflows/overview.md) |
| Fetch source data | [Sync](../data/syncs.md) |
| Clean or join table data | [Pipeline](../data/pipelines.md) |

## Notes

- Rule ids must be unique, and each rule is scoped to one object type.
- Predicates are validated against the resolved ontology at startup. Unknown properties or links,
  and empty `all()` / `any()` groups, are rejected.
- The `.where(...)` callback runs once at definition time and produces serializable predicate data;
  the callback itself is not stored.

## Related

- [Workflows](../workflows/overview.md) — run a multi-step process in response to a signal
- [Interventions](../workflows/interventions.md) — human-in-the-loop steps
- [Events](../events/overview.md) — the domain events rules react to
- [Object types](../ontology/object-types.md) and [Links](../ontology/links.md)
