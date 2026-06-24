# Actions

Actions are typed commands against your [ontology](../ontology/overview.md). They are the only
sanctioned way to mutate objects: instead of writing to storage directly, you define an action
that declares its params, validates the request, talks to external systems, and stages the object
edits to commit. Every request becomes a durable, replayable run with a lifecycle you can wait on.

Put action definitions in `actions/`. `createSixb()` auto-discovers them.

```ts
import { defineAction, optional, param } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const markPaid = defineAction("markPaid", {
  description: "Mark this invoice as paid.",
})
  .on(Invoice)
  .params({
    paymentMethod: optional(param("string")),
    paymentReference: optional(param("string")),
  })
  .edits(({ objects, params, run, subject }) => {
    objects(Invoice)
      .byId(subject.primaryId)
      .update({
        status: "paid",
        paymentInfo: {
          method: params.paymentMethod ?? "manual",
          reference: params.paymentReference ?? `manual:${subject.primaryId}`,
          recordedAt: run.startedAt.toISOString(),
        },
      })
  })
```

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
  it as `target` (in validate/writeback) and `subject` (in edits/effects).
- **Global actions** skip `.on(...)` and go straight to `.params(...)`. They are not tied to a
  single object — use them to create objects or run cross-object commands.

```ts
// Global action: create an object from scratch.
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
  setpoint: param("double", { semanticType: "Temperature" }),
  customer: param(ref(Customer)),                   // object reference param
})
```

`param` schemas include the primitives `"string"`, `"uuid"`, `"boolean"`, `"integer"`,
`"double"`, `"decimal"`, `"date"`, `"timestamp"`, plus `stringEnum([...])` and `ref(ObjectType)`.
`param` options are `description` and `semanticType`. Handlers receive params validated and
narrowed to TypeScript types — `date`/`timestamp` arrive as `Date`, `ref(...)` as an `ObjectRef`.
See [properties](../ontology/properties.md) and [value types](../ontology/value-types.md).

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

Each handler receives a context object. Common fields: `params` (validated), `run`
(`{ id, startedAt, idempotencyKey }`), `subject`, and `signal` (an `AbortSignal`).

| Phase | Key context fields |
| --- | --- |
| `validate` | `target` (object actions), `params`, `subject` |
| `writeback` | `target` (object actions), `sixb` (connectors + telemetry), `params` |
| `edits` | `objects` (edit facade), `read` (read facade), `subject`, `writeback` (writeback's return value) |
| `effects` | `sixb`, `commit` (the committed diff), `writeback`, `subject` |

`writeback` runs an external call before the local commit. Its return value flows into `edits` and
`effects` as `writeback`:

```ts
import { defineAction, param } from "@sixb/core"
import { getPanasonicApi } from "../lib/panasonicApi"
import { PanasonicAcUnit } from "../ontology/acUnit"

export const setPower = defineAction("setPower", {
  description: "Turn the AC unit on or off.",
})
  .on(PanasonicAcUnit)
  .params({ on: param("boolean") })
  .writeback(async ({ params, target, sixb }) => {
    const api = await getPanasonicApi(sixb)
    if (params.on) {
      await api.powerOn(target.properties.guid)
    } else {
      await api.powerOff(target.properties.guid)
    }
  })
```

The `edits` handler reads through `read` and stages writes through `objects`:

```ts
.edits(async ({ objects, params, read, subject }) => {
  const invoice = await read.objects(Invoice).get(subject.primaryId)
  if (!invoice) {
    throw new Error(`Invoice '${subject.primaryId}' not found.`)
  }
  objects(Invoice).byId(subject.primaryId).update({ status: "sent" })
})
```

## Requesting actions

Actions run asynchronously. Requesting one enqueues a durable run and returns immediately; a worker
executes the phases. Request through the object API for object actions, or the runtime `actions`
API for global ones.

```ts
// Object action: fire-and-forget. Returns { runId, queuedAt, created }.
const { runId } = await sixb.objects(Invoice).byId("inv-1").requestAction({
  actionId: "markPaid",
  params: { paymentMethod: "card" },
})

// Wait for the run to reach a terminal state. Returns the ActionRunRecord.
const run = await sixb.objects(Invoice).byId("inv-1").requestActionAndWait({
  actionId: "markPaid",
  params: { paymentMethod: "card" },
  timeoutMs: 30_000,
})
if (run.status === "failed") {
  throw new Error(run.error?.message)
}
```

`requestActionAndWait` resolves when the run completes or fails, and rejects with
`ActionRunTimeoutError` if `timeoutMs` elapses first (default 60s). Pass a `runId` to make the
request idempotent — re-requesting the same `runId` with the same `actionId`/subject/params returns
the existing run (`created: false`) instead of starting a new one.

| Option | Applies to | Meaning |
| --- | --- | --- |
| `runId` | both | Stable id for idempotent retries. |
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
-> effects`. The record carries `writeback`, `commit` (the object diff), and `effects` sub-records
as each phase lands, so runs are inspectable and resumable.

The runtime also appends [domain events](../events/overview.md) you can subscribe to:

| Event | When | Payload |
| --- | --- | --- |
| `action.requested` | On enqueue | `actionId`, `subject`, `params`, `runId` |
| `action.completed` | Run succeeded | `actionId`, `runId`, `subject`, `finishedAt` |
| `action.failed` | Run failed | `actionId`, `runId`, `subject`, `error`, `finishedAt` |

These are how `requestActionAndWait` detects completion. To react to a run, subscribe to them
through `sixb.events`, or model the reaction as a [rule](../rules/overview.md) or [workflow](../workflows/overview.md).

## Related

- [Objects](../objects/overview.md) — the CRUD and edit facade actions stage into.
- [Object CRUD](../objects/crud.md) — `create`/`update`/`delete`/`link` used inside `edits`.
- [Events](../events/overview.md) — the domain-event stream actions emit.
