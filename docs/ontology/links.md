# Links

A link defines a relationship between objects, such as an invoice's customer. Use links when
you need to navigate or query related objects; use [properties](properties.md) for values that
belong to one object.

## Define a link

Add `link(id, target, options?)` to the source type's `links` array. This belongs in the
`Invoice` definition from [Object types](object-types.md):

```ts
import { link } from "@sixb/core/ontology"
import { Customer } from "./customer"

const links = [
  link("customer", Customer, { cardinality: "one" }),
]
```

Pass `links` to `defineObjectType()`. The ID names the relationship on the source type; the
target defines which object type it can point to. Optional `name` and `description` provide
display text.

Declaring a link does not create relationships between instances. Use [object operations](../objects/overview.md#add-or-remove-relationships),
[action edits](../actions/overview.md#edit-objects-and-relationships), or [projections](../projections/overview.md#add-relationships)
to populate them.

## Choose cardinality

Cardinality applies to each **source object**, not to how many objects can point at a target:

| Cardinality | Meaning |
| --- | --- |
| `"one"` | Each invoice can have at most one customer. Many invoices can share that customer. |
| `"many"` | Each source can link to several targets under the same relationship ID. |

A `"one"` link is not required; an object can have no target. Set cardinality explicitly to make
the intended relationship clear.

Links have a direction. Declaring `Invoice.customer` does not add a separate `Customer.invoices`
link. Use [incoming traversal](../objects/querying.md#follow-relationships) to find the invoices
that point to a customer.

## Add relationship properties

A link can hold values about the relationship itself. For example, an invoice can have several
reviewers, each with their own assignment time:

```ts
import { link, prop } from "@sixb/core/ontology"
import { Customer } from "./customer"
import { Reviewer } from "./reviewer"

const links = [
  link("customer", Customer, { cardinality: "one" }),
  link("reviewers", Reviewer, {
    cardinality: "many",
    properties: [prop("assignedAt", "timestamp", { required: true })],
  }),
]
```

Define and export the `Reviewer` object type in `ontology/` before using this relationship.
Declare relationship properties with `prop()`, just like object properties. Sixb validates their
values when you write a link. A link without a property definition cannot accept extra properties.

See [Write relationship properties](../objects/overview.md#write-relationship-properties) for the
corresponding write.

## Other targets

Prefer an imported object type for typed relationships. Use these forms when the model needs them:

| Form | Use for |
| --- | --- |
| `link.ref("customer", "Customer")` | A target by ID, including when direct imports would be circular. |
| `link("relatedTo", [Customer, Invoice])` | A relationship that accepts either of the listed types. |
| `link.self("parent", { cardinality: "one" })` | Another object of the declaring type. |
| `link.any("relatedTo", { cardinality: "many" })` | An intentionally open relationship to any object type. |

`link.ref()` also accepts an array of target IDs. All named target types must be registered in
the project. For typed queries through ID-based links, the CLI generates the required ontology
types during development and builds.

Use a single target type when you want [typed traversal](../objects/querying.md#follow-relationships).
