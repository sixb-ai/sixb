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

External calls are not part of the local atomic commit, and Sixb cannot undo one that succeeded.
Once `.writeback()` succeeds, the run always goes on to its edits and commit, even past its
[time limit](#request-an-action); an error thrown by `.edits()` still fails the run and leaves the
external change unrecorded. Pass `run.idempotencyKey` to the external API, as above, so that a call
retried after a lost response applies once.

For notifications or other work after saving, add `.effects()` after `.edits()`. Its handler gets
`writeback` and `commit`, which describes the saved changes. An effects error is recorded in
`run.effects`; it does not undo the edits or make the committed action fail. Pass
`run.idempotencyKey` to these calls as well.

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

Both changes commit together.

When a [projection](../projections/overview.md) also supplies an object, action values take
precedence by default. A projection using `mostRecent` can make a newer source value effective.
Use `reset()` to return a property to its projected value. For a cardinality-one relationship,
unlinking also hides later projected targets. Use `resetLink()` to return the choice of target
to the projection.

## Concurrent changes

If data the action read through `read` changes before the commit, Sixb runs `.edits()` again
against the new data. An action without a writeback also reruns `.validate()`; one with a writeback
reuses its result and never calls the external system twice. After three conflicting attempts,
nothing is committed and the run fails with [`action.read_conflict`](../errors/overview.md#error-catalog).
Request a new run; if the action has a `.writeback()`, its external call already ran.

| Checked | Not checked |
| --- | --- |
| The target object and `get()`, even for a missing object | Objects that start matching a query later |
| `list()`, `query()`, and expanded objects | `count()`, `exists()`, and `facets()` |
| `listLinks()` | Telemetry history |

To depend on an object not existing yet, give it a deterministic ID and read it with `get()`.

## Request an action

`sixb.actions.request()`, and `requestAction()` on an object handle, run the action in the
requesting process and return its finished run:

```ts
const run = await sixb.objects(Invoice).byId("inv-1").requestAction({
  action: markPaid,
  params: {},
})
if (run.status === "failed") {
  console.error(run.error?.message)
}
```

A run that fails comes back with `status: "failed"` and its `error`; it is not thrown. The call
throws when no run was requested, such as for an unknown action, invalid params, or a missing
permission. It can also throw `internal.unexpected` after a run started, when that run's record
cannot be returned: request it again with the same `runId` to get the record.

Pass a `runId` to make a request safe to retry. A repeated request with that `runId` returns the
run once it has finished, without running the action again, and fails with
[`action.run_in_progress`](../errors/overview.md#error-catalog) while it still runs.

A run has 30 seconds to get through validation and a successful writeback, or through validation
and edits when it has no writeback. A run that runs out of time before then stops, commits nothing,
and fails with [`action.timeout`](../errors/overview.md#error-catalog); if its writeback was cut
short, check the external system before requesting a new run. Handlers receive a `signal` that
aborts at the limit: forward it to the calls they await so they stop in time. Effects get 30 more
seconds after the commit. Move longer work into a [workflow](../workflows/overview.md).

## Use your action

Call an action from your app or include it in a workflow.

- [Running actions in apps](../apps/actions.md): Connect an action to a React interface.
- [Workflow action steps](../workflows/overview.md#run-an-action): Run an action as part of a larger process.
