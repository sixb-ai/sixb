# Runtime failure notifications

Sixb can notify project code when background runs, rule evaluation, or durable event delivery
fails. Configure an `onError` callback on `createSixb()` and route the notification to the service
your project uses.

```ts
import { createSixb } from "@sixb/core"

export const sixb = await createSixb({
  // providers and definitions...
  async onError(error, context) {
    const subject =
      context.type === "run.failed"
        ? `${context.run.kind} run ${context.run.runId}`
        : context.type === "event.delivery.failed"
          ? `delivery of ${context.eventTypes.join(", ")}`
          : `${context.source} rule evaluation`
    await sendToSlack({
      deduplicationKey: context.notificationId,
      message: `${subject} failed: ${error.message}`,
    })
  },
})
```

When `onError` is omitted, Sixb reports the same failures to `console.error`; they are never silently dropped.
Configuring `onError` replaces that default console destination, so each failure is reported once.

The callback covers failed action, agent, pipeline, projection, sync, workflow, and webhook runs,
plus failed ontology-outbox publication attempts and Rules evaluation passes.
It does not run for successes, cancellations, retries that remain recoverable, workflow nodes or
pipeline steps separately, or routine webhook 4xx rejections.

## Context

The second argument is a discriminated `SixbErrorContext`:

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
```

`SixbFailedRun` has one variant per run kind — action, agent, pipeline, projection, sync, workflow,
webhook — and every one carries a `runId`. Rules are the exception and are absent from it: they are
evaluated live, per subject, with no run record, so they report as `rule.evaluation.failed` rather
than being handed an id nothing can resolve.

### Lost events

`event.delivery.failed` means a batch of domain events never reached its subscribers. That matters
because every event Sixb publishes can be a trigger edge — a rule's `.when()`, an event schedule, a
workflow wait node — so a lost batch is a handler that silently never runs.

Two paths report it, which is why `eventIds` is optional:

| Path | `eventIds` | `attempts` |
| --- | --- | --- |
| Ontology outbox publication | present — the envelopes were persisted first | rises as Sixb retries |
| A rejected framework emit | absent — nothing was persisted | always `1`; the failure is terminal |

`eventTypes` is filled on both paths, so it is the field to read first. Payloads are never included.

### Rule evaluations

`source` is the field to alert on. A failing `live` evaluation is recoverable: the periodic
reconciliation pass rebuilds rule state from committed objects, so affected subjects are re-evaluated
within one interval. A failing `reconciliation` pass is not — it *is* the repair path, so while it
keeps failing, rule state stops converging.

`ruleId` and `subject` are present when the failure was attributed to a single candidate. They are
absent when a whole batch or pass died before any one rule could be blamed, which is the more serious
case rather than the vaguer one.

Narrow `context.run.kind` to access the definition identifier for that run:

```ts
onError(error, context) {
  if (context.type === "event.delivery.failed") {
    console.error(`Delivery attempt ${context.attempts} failed`, context.eventTypes, error)
    return
  }

  if (context.type === "rule.evaluation.failed") {
    console.error(`Rules ${context.source} evaluation failed`, context.ruleId ?? "", error)
    return
  }

  if (context.run.kind === "projection") {
    console.error(`Projection ${context.run.projectionId} failed`, error)
  }

  if (context.run.kind === "workflow") {
    console.error(`Workflow ${context.run.workflowId} failed`, error)
  }
}
```

`notificationId` is stable for one reported failure occurrence. Use it as an idempotency or deduplication key at the notification
destination. If a supported retry reopens and later fails the same run again, that new transition
receives a different identifier.

## Delivery semantics

`onError` is an in-process, best-effort observer rather than a broker event. Sixb isolates the
handler from execution: a synchronous throw or rejected promise from `onError` cannot change run
status, queue settlement, retries, or HTTP responses. Handler failures fall back to
`console.error`.

Sixb tracks pending asynchronous handlers and gives them up to five seconds to drain during
graceful CLI shutdown. A process crash can still happen between persisting a failed run and
delivering its notification, so this API does not provide exactly-once delivery. Integrations
should use `notificationId` to tolerate possible duplicate delivery.

The original `Error` is preserved when one exists. Sixb safely wraps non-`Error` thrown values. The
context contains identifiers only; delivery failures expose stable envelope IDs, never payloads or
lease IDs.
