# Actions

Actions are typed business commands against your [ontology](../ontology/overview.md). They declare
params, validate the request, talk to external systems, and stage object edits for one atomic
commit. Every request becomes a durable, replayable run with a lifecycle you can wait on. Trusted
runtime code may also use the direct [object CRUD API](../objects/crud.md); storage providers remain
read-only and never receive mutation events as commands.

Their real power is doing both sides of a change as one run: **write back** to external systems
*and* **edit** the ontology graph, so the two stay in step. Reach for just one phase when that is
all you need — graph-only edits, or an external-only writeback — but actions shine when a change
must land in both places.

Put action definitions in `actions/`. `createSixb()` auto-discovers them.

```ts
import { defineAction, optional, param } from "@sixb/core"
import { acmeErpConnector } from "../connectors/acme-erp"
import { Invoice } from "../ontology/invoice"

export const markPaid = defineAction("markPaid", {
  description: "Record a payment in the ERP, then mark the invoice paid.",
})
  .on(Invoice)
  .params({
    paymentMethod: optional(param("string")),
  })
  // writeback: update the external system. Runs before the commit; no graph edits here.
  .writeback(async ({ target, params, sixb }) => {
    const erp = await sixb.connector(acmeErpConnector)
    const receipt = await erp.recordPayment({
      invoiceNumber: target.properties.number,
      amount: target.properties.amount,
      method: params.paymentMethod ?? "manual",
    })
    return { receiptId: receipt.id } // flows into edits + effects as `writeback`
  })
  // edits: update the graph, carrying the ERP receipt id across the commit.
  .edits(({ objects, params, writeback, run, subject }) => {
    objects(Invoice).byId(subject.primaryId).update({
      status: "paid",
      paymentInfo: {
        method: params.paymentMethod ?? "manual",
        reference: writeback.receiptId,
        recordedAt: run.startedAt.toISOString(),
      },
    })
  })
```

`markPaid` does both sides as one run: the **writeback** phase records the payment in the ERP, then
the **edits** phase marks the invoice paid in the graph — committed only if the writeback succeeded,
and carrying the ERP receipt id across the boundary. The graph and the external system stay in step.

## The builder

`defineAction(id, options?)` starts the chain. `options.description` is optional human-readable
text. From there you pick a binding, declare params, then attach phase handlers.

| Step | Method | Notes |
| --- | --- | --- |
| Binding | `.on(ObjectType)` | Object action — runs against one object instance. Omit for a global action. |
| Params | `.params({ ... })` | Declares the typed input shape. Required even when empty (`.params({})`). |
| Validate | `.validate(fn)` | Optional, repeatable. Read-only checks before any mutation. |
| Phase | `.writeback(fn)` / `.edits(fn)` / `.effects(fn)` | Attach handlers in fixed order (see below). |

### Bindings

- **Object actions** chain `.on(ObjectType)`. The runtime resolves the target object and exposes
  it as `target` (in `validate`/`writeback`) and `subject` (in `edits`/`effects`).
- **Global actions** skip `.on(...)` and go straight to `.params(...)`. They are not tied to a
  single object — use them to create objects or run cross-object commands.

```ts
// Global action: create a draft invoice and link it to a customer and project.
import { defineAction, optional, param, ref } from "@sixb/core"
import { stringEnum } from "@sixb/core/ontology"
import { Customer } from "../ontology/customer"
import { Invoice } from "../ontology/invoice"
import { Project } from "../ontology/project"

export const createDraftInvoice = defineAction("createDraftInvoice", {
  description: "Create a draft invoice and attach it to a customer and project.",
})
  .params({
    id: param("string"),
    number: param("string"),
    amount: param("double"),
    currency: optional(param(stringEnum(["EUR", "USD", "GBP"]))),
    customer: param(ref(Customer), { description: "Customer to bill." }),
    project: param(ref(Project), { description: "Project the invoice belongs to." }),
  })
  .edits(({ objects, params, run }) => {
    const invoice = objects(Invoice).create({
      id: params.id,
      number: params.number,
      amount: params.amount,
      currency: params.currency ?? "EUR",
      status: "draft",
      paymentInfo: {
        method: "pending",
        reference: `draft:${params.id}`,
        recordedAt: run.startedAt.toISOString(),
      },
    })

    invoice.link(Invoice.l.customer, objects(Customer).byId(params.customer.primaryId))
    invoice.link(Invoice.l.project, objects(Project).byId(params.project.primaryId))
  })
```

### Params

Each entry in `.params({ ... })` is built with `param(schema, options?)`, which marks the param
**required**. Wrap it in `optional(...)` to make it optional.

```ts
.params({
  approved: param("boolean"),                       // required
  message: param("string"),                         // required
  reviewerNote: optional(param("string")),          // optional
  category: optional(param(stringEnum(["general", "services"]), { nullable: true })),
  currency: param(stringEnum(["EUR", "USD", "GBP"])),
  customer: param(ref(Customer)),                   // object reference param
})
```

Presence and nullability are independent. A required nullable param must be present but may be
`null`; wrapping it in `optional(...)` adds the omitted state:

| Declaration | Omitted / `undefined` | `null` | Value |
| --- | --- | --- | --- |
| `param(schema)` | rejected | rejected | validated |
| `optional(param(schema))` | omitted | rejected | validated |
| `param(schema, { nullable: true })` | rejected | accepted | validated |
| `optional(param(schema, { nullable: true }))` | omitted | accepted | validated |

This makes partial update actions explicit: omitted means “leave unchanged,” while `null` means
“clear the value.”

`param` schemas include the primitives `"string"`, `"uuid"`, `"boolean"`, `"integer"`,
`"double"`, `"decimal"`, `"date"`, `"timestamp"`, plus `stringEnum([...])` and `ref(ObjectType)`.
`param` options are `description`, `semanticType`, and `nullable`. Handlers receive params validated and
narrowed to TypeScript types — `date`/`timestamp` arrive as `Date`, `ref(...)` as an `ObjectRef`
(read `.primaryId` to resolve it). See [properties](../ontology/properties.md) and
[value types](../ontology/value-types.md).

## Execution model

A run executes up to four phases in a **fixed order**. Each phase is optional except that you must
attach at least `writeback` or `edits`, and `effects` requires `edits` first.

| # | Phase | Purpose | Mutations? |
| --- | --- | --- | --- |
| 1 | `validate` | Read-only preconditions; throw to reject. Runs every attached validator. | No |
| 2 | `writeback` | Talk to external systems before committing locally. | No object edits |
| 3 | `edits` | Stage object create/update/delete/link edits. Committed atomically. | Yes — the only place |
| 4 | `effects` | Side effects after the commit lands (notify, fan-out). | No object edits |

The hard rule: **object mutations happen only in the `edits` phase.** `edits` stages edits via the
`objects(...)` facade and the runtime commits them in one atomic batch; `validate`, `writeback`,
and `effects` must not mutate ontology objects. Phases short-circuit on the first thrown error and
the run is marked failed at the phase that threw.

### Phase contexts

Each handler receives a context object. Every phase gets `params` (validated), `run`
(`{ id, startedAt, idempotencyKey }`), `subject`, and `signal` (an `AbortSignal`). The rest vary:

| Phase | Added context fields |
| --- | --- |
| `validate` | `target` (object actions) |
| `writeback` | `target` (object actions), `sixb` (connectors + telemetry + immutable blobs) |
| `edits` | `objects` (edit facade), `read` (read facade), `writeback` (writeback's return value) |
| `effects` | `sixb`, `commit` (what the edits changed), `writeback` |

`commit` tells the `effects` handler exactly what the run wrote:

| Field | Notes |
| --- | --- |
| `changes` | The objects and links that actually changed, each with `before`, `after`, and the changed properties |
| `committedAt` | When the changes were saved |
| `commitId` | Id for this run's write; useful for logging and correlating with events |
| `created` | `false` when a retried run reused the write it had already made |
| `outcomes` | One result per edit you recorded, in the order you recorded them |

Sixb emits the domain events for those changes itself, so drive notifications and fan-out from
`changes` instead of appending mutation events by hand.

The ontology write, Action commit-ledger entry, and mutation-event envelopes land in one database
transaction. `effects` starts only after that commit exists and receives its persisted identity;
retries resolve the same Action-origin commit and never re-commit edits. Broker delivery is
post-commit and at-least-once.

`writeback` runs an external call before the local commit, and its return value flows into `edits`
and `effects` as `writeback` (see the `markPaid` example above, which carries the ERP receipt id
into the edit). Writeback and effects handlers can stream immutable file content into Sixb with
`sixb.blobs.put(...)`, inspect it with `sixb.blobs.stat(...)`, and reopen it with
`sixb.blobs.open(...)`; the resulting `FileRef` is JSON-safe and can flow into `edits`. The `edits`
handler can also read current committed state through `read` and stage
writes through `objects`. This `sendReminder` gates its edit on an approval read at edit time:

```ts
import { defineAction, optional, param } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const sendReminder = defineAction("sendReminder", {
  description: "Send a payment reminder to the customer.",
})
  .on(Invoice)
  .params({
    approved: param("boolean"),
    message: param("string"),
    reviewerNote: optional(param("string")),
  })
  .edits(async ({ objects, params, read, subject }) => {
    const invoice = await read.objects(Invoice).get(subject.primaryId)
    if (!invoice) {
      throw new Error(`Invoice '${subject.primaryId}' not found.`)
    }

    const reviewedAt = new Date().toISOString()
    if (!params.approved) {
      objects(Invoice).byId(subject.primaryId).update({
        reminderReviewStatus: "revision_requested",
        reminderReviewedAt: reviewedAt,
        reminderReviewerNote: params.reviewerNote,
      })
      return
    }

    objects(Invoice).byId(subject.primaryId).update({
      status: "sent",
      reminderReviewStatus: "approved",
      reminderReviewedAt: reviewedAt,
      reminderReviewerNote: params.reviewerNote,
    })
  })
```

The runtime commits every staged edit in a single atomic batch once the handler returns.

### Editing objects

`objects(Type)` gives you an object to edit: `byId(id)` for one that exists, or `create(properties)`
for a new one. Both return a handle with the rest of the edits:

| Call | What it does |
| --- | --- |
| `objects(Type).create(properties)` | Creates a new object; fails if that object already exists |
| `handle.update(properties)` | Writes the properties you pass and leaves the rest alone |
| `handle.unset(...propertyIds)` | Clears properties this action set, so they read as absent |
| `handle.reset(...propertyIds)` | Forgets what this action set, so a projected value shows again |
| `handle.delete()` / `handle.restore()` | Removes the object, or brings back one an action deleted |

```ts
.edits(({ objects, params, subject }) => {
  const invoice = objects(Invoice).byId(subject.primaryId)
  invoice.update({ status: "sent", reminderReviewerNote: params.note })
  invoice.unset("reminderReviewedAt")
})
```

When a [projection](../data/projections.md) also writes an object, values your actions set win
over the projected ones. `reset(...)` drops the action's value for those properties so the projected
value becomes visible again — use it to hand a field back to the projection.

Repeated edits on one object stay in order, and a later `update(...)` sees what an earlier one wrote.
An edit that ends up changing nothing emits no mutation event.

`create(...)` derives its primary id from the action run when you omit one, so a retried run creates
the same object instead of a duplicate.

### Reassigning a cardinality-one link

`link(...)` adds a relationship, `unlink(...)` removes a relationship, and `resetLink(...)` forgets a relationship this action managed so a projected one shows again. There is no setter: to repoint a `cardinality: "one"` link, read the current target and replace it in the same handler.

For a cardinality-one link, the managed decision owns the `(source, linkId)` slot. If the projection later proposes another target, the managed target (or clear) remains authoritative; `resetLink(...)` releases the slot and reveals the latest projected target.

```ts
.edits(async ({ objects, read, params, subject }) => {
  const transcript = objects(Transcript).byId(subject.primaryId)
  for (const current of await read
    .objects(Transcript)
    .byId(subject.primaryId)
    .listLinks(Transcript.l.project)) {
    transcript.unlink(Transcript.l.project, {
      objectTypeId: "Project",
      primaryId: current.targetId,
    })
  }
  transcript.link(Transcript.l.project, params.project)
})
```

Both edits land together, and Sixb remembers what the handler read through `read`: if that state
changed before the run committed, the whole commit fails instead of overwriting someone else's write.
Reassigning emits `link.deleted` and `link.created`.

## Requesting actions

Actions run asynchronously. Requesting one enqueues a durable run and returns immediately; a worker
executes the phases. Request object actions through the object API, and global actions through the
runtime `actions` API. You can pass the imported action definition (typed) or its `actionId` string.

```ts
// Object action: fire-and-forget. Returns { runId, queuedAt, created }.
const { runId } = await sixb.objects(Invoice).byId("inv-1").requestAction({
  action: markPaid,
  params: { paymentMethod: "card" },
})

// Wait for the run to reach a terminal state. Returns the ActionRunRecord.
const run = await sixb.objects(Invoice).byId("inv-1").requestActionAndWait({
  action: markPaid,
  params: { paymentMethod: "card" },
  timeoutMs: 30_000,
})
if (run.status === "failed") {
  throw new Error(run.error?.message)
}

// Global action: no subject. Request through sixb.actions.
// ref(...) params take an object ref ({ objectTypeId, primaryId }), not a bare id.
await sixb.actions.request({
  actionId: "createDraftInvoice",
  params: {
    id: "inv-9",
    number: "INV-009",
    amount: 4200,
    customer: { objectTypeId: "Customer", primaryId: "cus-1" },
    project: { objectTypeId: "Project", primaryId: "prj-1" },
  },
})
```

`requestActionAndWait` resolves when the run completes or fails, and rejects with
`ActionRunTimeoutError` if `timeoutMs` elapses first (default 60s). Pass a `runId` to make a
request idempotent — re-requesting the same `runId` with the same action, subject, and params
returns the existing run (`created: false`) instead of starting a new one.

In browser apps, prefer `useActionRunMutation` from `@sixb/client/hooks` for button-driven
commands. Its loading, success, and error states track the terminal run, and
`invalidateOnCommit: true` refreshes object queries after committed edits. The generated
`requestActionMutation()` remains enqueue-only and resolves as soon as the server accepts the
request. See [running actions from apps](../apps/actions.md).

| Option | Applies to | Meaning |
| --- | --- | --- |
| `action` / `actionId` | both | The action to run — pass the definition or its id. |
| `params` | both | The action's typed params. |
| `runId` | `requestAction`, `sixb.actions.request` | Stable id for idempotent retries. |
| `timeoutMs` | `requestActionAndWait` | Reject after this many ms. Default `60_000`. |
| `signal` | `requestActionAndWait` | `AbortSignal` to cancel the wait. |

## Run lifecycle and events

Every request creates an `ActionRunRecord` with a `status` and the current `phase`.

| `status` | Meaning |
| --- | --- |
| `queued` | Requested, waiting for a worker. |
| `running` | A worker is executing phases. |
| `succeeded` | All phases completed. |
| `failed` | A phase threw; `error` holds the failure and its `phase`. |
| `cancelled` | Run was cancelled. |

`phase` tracks progress through `request -> enqueue -> validation -> writeback -> edits -> commit
-> effects`. The record carries `writeback` and `effects` sub-records as each phase lands, so runs
stay inspectable. What the run changed in the graph arrives as `commit` in the `effects` phase and as
[domain events](../events/overview.md).

The runtime also appends [domain events](../events/overview.md) you can subscribe to:

| Event | When | Payload |
| --- | --- | --- |
| `action.requested` | On enqueue | `actionId`, `subject`, `params`, `runId` |
| `action.completed` | Run succeeded | `actionId`, `runId`, `subject`, `finishedAt` |
| `action.failed` | Run failed | `actionId`, `runId`, `subject`, `error`, `finishedAt` |

These are how `requestActionAndWait` detects completion. In client code, the fluent event
builder can scope action events by run, action id, or object subject:

```tsx
events.actions().run(runId).terminal()
events.actions().action("markPaid").completed()
events.actions().subject(Invoice).byId("inv-1").failed()
```

To react to a run on the server, subscribe through `sixb.events`, or model the reaction as a
[rule](../rules/overview.md) or [workflow](../workflows/overview.md).

## Related

- [Objects](../objects/overview.md) — the CRUD and edit facade actions stage into.
- [Object CRUD](../objects/crud.md) — `create`/`update`/`delete`/`link` used inside `edits`.
- [Events](../events/overview.md) — the domain-event stream actions emit.
- [Running actions from apps](../apps/actions.md) — React action buttons and terminal state.
- [Authorization](../auth/authorization.md) — `apply:action` grants gate who can request actions.
