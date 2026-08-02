# Runtime failure notifications

Sixb reports every failure it survives on its own: a background run, a rule evaluation, a batch of
domain events that never reached its subscribers, and the runtime's own background loops. Configure
an `onError` callback on `createSixb()` and route the notification to the service your project uses.

```ts
import { createSixb } from "@sixb/core"

export const sixb = await createSixb({
  // providers and definitions...
  async onError(failure, context) {
    if (failure.code !== "storage.unavailable") return
    await sendToSlack({
      deduplicationKey: context.notificationId,
      message: `${context.type}: ${failure.message}`,
    })
  },
})
```

The first argument is a [`SixbFailure`](error-codes.md) — the same record the run row stores and the
API returns. Branch on `failure.code`: it is the one identifier that survives a reworded message, a
process boundary, and a serialization. The second says where the failure happened.

**Not setting `onError` is not silence.** A runtime without a handler prints every failure it
reports, one line each:

```
[Sixb] background task 'ontology.outbox' failed — storage.unavailable: could not reach the store
```

Passing `() => {}` is how you ask for silence.

## Context

The second argument is a discriminated `SixbErrorContext`, plus `cause`:

```ts
interface SixbRunFailedContext {
  readonly type: "run.failed"
  readonly notificationId: string
  readonly projectId: string
  readonly occurredAt: string
  readonly attempt?: number
  readonly run: SixbFailedRun
}

interface SixbEventDeliveryFailedContext {
  readonly type: "event.delivery.failed"
  readonly notificationId: string
  readonly projectId: string
  readonly occurredAt: string
  readonly attempts: number
  readonly eventTypes: readonly string[]
  readonly eventIds?: readonly string[]
  readonly source?: string
}

interface SixbRuleEvaluationFailedContext {
  readonly type: "rule.evaluation.failed"
  readonly notificationId: string
  readonly projectId: string
  readonly occurredAt: string
  readonly source: "live" | "reconciliation"
  readonly eventIds: readonly string[]
  readonly ruleId?: string
  readonly subject?: { readonly objectTypeId: string; readonly primaryId: string }
}

interface SixbBackgroundTaskFailedContext {
  readonly type: "background.task.failed"
  readonly notificationId: string
  readonly projectId: string
  readonly occurredAt: string
  readonly task: SixbBackgroundTask
  readonly subject?: string
}
```

`cause` is the value that was actually thrown, alive and with its stack. It is deliberately not part
of the record — `failure.cause` is the string an operator reads, and this is the object a reporter
like Sentry attaches. Nothing serializes it.

`SixbFailedRun` has one variant per run kind — action, agent, pipeline, projection, sync, workflow,
webhook — and every one carries a `runId`. Rules are the exception and are absent from it: they are
evaluated live, per subject, with no run record, so they report as `rule.evaluation.failed` rather
than being handed an id nothing can resolve.

`onError` does not run for successes, cancellations, retries that remain recoverable, workflow nodes
or pipeline steps separately, or routine webhook 4xx rejections.

### Lost events

`event.delivery.failed` means a batch of domain events never reached its subscribers. That matters
because every event Sixb publishes can be a trigger edge — a rule's `.when()`, an event schedule, a
workflow wait node — so a lost batch is a handler that silently never runs.

Two paths report it, which is why `eventIds` is optional:

| Path | `eventIds` | `attempts` | `source` |
| --- | --- | --- | --- |
| Ontology outbox publication | present — the envelopes were persisted first | rises as Sixb retries | absent — the emitter is the runtime |
| A rejected framework emit | absent — nothing was persisted | always `1`; the failure is terminal | the component that was emitting |

`eventTypes` is filled on both paths, so it is the field to read first. Payloads are never included.

### Rule evaluations

`source` is the field to alert on. A failing `live` evaluation is recoverable: the periodic
reconciliation pass rebuilds rule state from committed objects, so affected subjects are re-evaluated
within one interval. A failing `reconciliation` pass is not — it *is* the repair path, so while it
keeps failing, rule state stops converging.

`ruleId` and `subject` are present when the failure was attributed to a single candidate. They are
absent when a whole batch or pass died before any one rule could be blamed, which is the more serious
case rather than the vaguer one.

### Background tasks

The other three contexts name work someone asked for. `background.task.failed` names work nobody
asked for and everything depends on — the loops that dispatch queued runs, publish the outbox, renew
a lease, plan the next occurrence of a schedule. None of them has a run row, so none of them has
anywhere else to be seen.

| `task` | What stops while it keeps failing |
| --- | --- |
| `agent.dispatch` | A queued agent run sits queued; the worker's scan is the retry. |
| `ontology.outbox` | Committed ontology facts stop becoming domain events. |
| `ontology.maintenance` | The pass that repairs projections and re-drives a stalled outbox. |
| `orchestrator.dispatch` | An event stops becoming the queue jobs it routes to. |
| `orchestrator.projection-reconcile` | A dataset version the live path missed stays unprojected. |
| `orchestrator.subscribe` | The subscription live routing depends on. |
| `queue.lease` | The claim on a job in flight; it will be redelivered. |
| `queue.settle` | Acking or failing a finished job; it may be redelivered. |
| `schedule.plan` | That schedule stops firing. |
| `workflow.resume` | A workflow waiting on a finished node stops there. |

These retry, so they repeat: an outbox that cannot claim reports on every pass. That is the signal —
one is noise, a hundred is an outage — so nothing deduplicates them for you. `notificationId` keys
on the task, its subject, and the moment, so a handler can collapse a retry storm on its own terms.

### Narrowing

```ts
onError(failure, context) {
  if (context.type === "background.task.failed") {
    console.error(`Background task ${context.task} failed`, failure.code, context.cause)
    return
  }

  if (context.type === "event.delivery.failed") {
    console.error(`Delivery attempt ${context.attempts} failed`, context.eventTypes, failure.code)
    return
  }

  if (context.type === "rule.evaluation.failed") {
    console.error(`Rules ${context.source} evaluation failed`, context.ruleId ?? "", failure.code)
    return
  }

  if (context.run.kind === "projection") {
    console.error(`Projection ${context.run.projectionId} failed`, failure.message)
  }
}
```

`notificationId` is stable for one reported failure occurrence. Use it as an idempotency or
deduplication key at the notification destination. If a supported retry reopens and later fails the
same run again, that new transition receives a different identifier.

## Delivery semantics

`onError` is an in-process, best-effort observer rather than a broker event. Sixb isolates the
handler from execution: a synchronous throw or rejected promise from `onError` cannot change run
status, queue settlement, retries, or HTTP responses. Handler failures fall back to `console.error`.

Sixb tracks pending asynchronous handlers and gives them up to five seconds to drain during
graceful CLI shutdown. A process crash can still happen between persisting a failed run and
delivering its notification, so this API does not provide exactly-once delivery. Integrations
should use `notificationId` to tolerate possible duplicate delivery.

The context contains identifiers only; delivery failures expose stable envelope IDs, never payloads
or lease IDs.
