# Actions

An action is a typed command that changes your domain model or calls an external system. Define
its inputs and behavior, then run it from your app, an agent, or a workflow.

## Define an action

Export an action from `actions/`. Sixb discovers it automatically. Use `.on()` to bind it to an
object type, `.params()` to declare its inputs, and `.edits()` to change objects.

File: `actions/mark-paid.ts`

```ts
import { defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const markPaid = defineAction("markPaid")
  .on(Invoice)
  .params({})
  .edits(({ objects, subject }) => {
    objects(Invoice).byId(subject.primaryId).update({ status: "paid" })
  })
```

`subject.primaryId` identifies the invoice the action runs on. Edits are saved together when the
handler succeeds. Keep `.params({})` when there are no inputs.

For a global action, omit `.on(...)`. Use one for a command that creates an object or works across
several objects without a single target.

## Parameters

Use `param()` for required inputs and wrap it in `optional()` for optional inputs. Both come from
`@sixb/core`. For example, extend the invoice action to accept a payment method and an optional note:

```ts
.params({
  paymentMethod: param("string"),
  note: optional(param("string", { nullable: true })),
})
```

Handlers receive validated, typed values through `params`. Use `params.paymentMethod` in the
handler and pass `{ paymentMethod: "card" }` when requesting this version of the action.

`optional()` allows an input to be omitted. `{ nullable: true }` allows an explicit `null` value.
Your handler decides how each affects the edit, such as leaving a note unchanged or clearing it.

Use `ref()` from `@sixb/core` for an object-reference input:

```ts
.params({
  customer: param(ref(Customer)),
})
```

Callers pass `{ objectTypeId: "Customer", primaryId: "cus-1" }` for `customer`. In a handler,
read its ID from `params.customer.primaryId` or pass the reference to a link edit.

Use `ref.user()` for an input that names a project member:

```ts
.params({
  assignee: param(ref.user()),
})
```

Callers pass `{ type: "user", id: "usr_1" }`. Sixb rejects the request when the user does not exist
or is suspended. Store the value in a [user reference property](../ontology/properties.md#reference-a-user)
or compare it with one.

Other input types use the [property schemas](../ontology/properties.md#choose-a-schema), including
enums and structured values. Date and timestamp inputs arrive in handlers as `Date` values.

## Validate a request

Add `.validate()` after `.params()` to check the request before any external call or edit. For an
object action, `target` contains the current object. Throw an error to reject the request:

```ts
.validate(({ target }) => {
  if (target.properties.status === "paid") {
    throw new Error("This invoice is already paid.")
  }
})
```

Validation checks are read-only. You can attach more than one validator.

## Call external systems

Use `.writeback()` before `.edits()` when a change depends on an external call. Return the data
your edit needs; Sixb passes it to the next handler as `writeback`.

This example uses a project [connector](../connectors/overview.md#custom-connectors) whose
`recordPayment()` method accepts an invoice number and idempotency key, and returns a receipt ID:

```ts
import { defineAction } from "@sixb/core"
import { billing } from "../connectors/billing"
import { Invoice } from "../ontology/invoice"

export const recordPayment = defineAction("recordPayment")
  .on(Invoice)
  .params({})
  .writeback(async ({ target, sixb, run }) => {
    const client = await sixb.connector(billing)
    const receipt = await client.recordPayment({
      invoiceNumber: target.properties.number,
      idempotencyKey: run.idempotencyKey,
    })
    return { receiptId: receipt.id }
  })
  .edits(({ objects, subject, writeback }) => {
    objects(Invoice).byId(subject.primaryId).update({
      status: "paid",
      receiptId: writeback.receiptId,
    })
  })
```

Return JSON-compatible values or no value from `.writeback()`. For example, return an ID or a
string timestamp rather than an SDK client or `Date` instance. An action can use `.writeback()`
without `.edits()` when it only needs to call an external system.

External calls are not part of the local atomic commit. A successful API call cannot be rolled
back by Sixb if the later edit fails. Make calls safe to repeat, using `run.idempotencyKey` with
an external API that supports idempotency.

For notifications or other work after saving, add `.effects()` after `.edits()`. Its handler gets
`writeback` and `commit`, which describes the saved changes. An effects error is recorded in
`run.effects`; it does not undo the edits or make the committed action fail. Make these calls safe
to repeat as well.

The order is `validate` → `writeback` → `edits` → `effects`. Only add the handlers you need, with
at least `.writeback()` or `.edits()`. Sixb emits the corresponding [events](../websockets/overview.md)
automatically.

## Edit objects and relationships

Inside `.edits()`, use `objects(Type)` to create an object or get an edit handle with `.byId(id)`.
These methods stage changes synchronously; all edits commit together after the handler returns.
Use `read.objects(Type)` when you need to read existing values or relationships.

| Method | Purpose |
| --- | --- |
| `objects(Type).create(properties)` | Create an object; fails if its ID already exists |
| `handle.update(properties)` | Set the given properties and leave others unchanged |
| `handle.unset(...propertyIds)` | Explicitly clear properties |
| `handle.reset(...propertyIds)` | Release action overrides so projected values can apply |
| `handle.delete()` / `handle.restore()` | Delete an object or restore its projected state |
| `handle.link(link, target)` / `handle.unlink(link, target)` | Add or remove a relationship |
| `handle.resetLink(link, target)` | Release an action's override of a relationship |

`create()` generates a stable ID for the run if you omit the primary property. Provide the other
required properties from your object type.

For a link with cardinality `"one"`, remove its existing target before linking a different one.
An action with a `customer: param(ref(Customer))` input can reassign an invoice like this:

```ts
.edits(async ({ objects, read, params, subject }) => {
  const invoice = objects(Invoice).byId(subject.primaryId)
  const existing = await read.objects(Invoice).byId(subject.primaryId)
    .listLinks(Invoice.l.customer)

  for (const current of existing) {
    invoice.unlink(Invoice.l.customer, {
      objectTypeId: Customer.id,
      primaryId: current.targetId,
    })
  }
  invoice.link(Invoice.l.customer, params.customer)
})
```

Both changes commit together. If something read this way changes before the commit, nothing is
committed and the run fails with [`action.read_conflict`](../errors/overview.md#error-catalog), so
a concurrent change is never overwritten. This covers the action's target object, reads made in
`.writeback()` and `.edits()`, objects returned by `get()`, `list()`, and `query()` (including
expanded objects), and the relationships returned by `listLinks()`. Request a new run to act on the
current data; if the action has a `.writeback()`, check the external system first.

Query results are protected object by object, not as a set: an object that starts matching a
query after you ran it does not make the commit fail, and neither does a change in a `count()`,
`exists()`, or `facets()` result. Two patterns cover what a set check would:

- **Uniqueness:** when a decision depends on an object not existing yet, give that object a
  deterministic ID and read it with `get()`. An absent object is protected as well.
- **Coverage:** to handle every new object, such as classifying each new contact, run an
  idempotent action per object from a workflow that a [rule](../rules/overview.md#start-a-workflow)
  starts when the object matches, instead of scanning with a query.

If a worker stops after `.writeback()` succeeded, the resumed run does not call it again and only
checks what `.edits()` reads.

When a [projection](../projections/overview.md) also supplies an object, action values take
precedence by default. A projection using `mostRecent` can make a newer source value effective.
Use `reset()` to return a property to its projected value. For a cardinality-one relationship,
unlinking also hides later projected targets. Use `resetLink()` to return the choice of target
to the projection.

## Use your action

Call an action from your app or include it in a workflow.

- [Running actions in apps](../apps/actions.md): Connect an action to a React interface.
- [Workflow action steps](../workflows/overview.md#run-an-action): Run an action as part of a larger process.
