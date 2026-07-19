# Failed run notifications

Sixb can notify project code when background runs reach a terminal `failed` state. Configure an
`onError` callback on `createSixb()` and route the notification to the service your project uses.

```ts
import { createSixb } from "@sixb/core"

export const sixb = await createSixb({
  // providers and definitions...
  async onError(error, context) {
    await sendToSlack({
      deduplicationKey: context.notificationId,
      message: `${context.run.kind} run ${context.run.runId} failed: ${error.message}`,
    })
  },
})
```

The callback covers failed action, agent, pipeline, projection, sync, workflow, and webhook runs.
It does not run for successes, cancellations, retries that remain recoverable, workflow nodes or
pipeline steps separately, or routine webhook 4xx rejections.

## Context

The second argument is a discriminated `SixbErrorContext`. Its current type is
`SixbRunFailedContext`:

```ts
interface SixbRunFailedContext {
  readonly type: "run.failed"
  readonly notificationId: string
  readonly projectId: string
  readonly occurredAt: string
  readonly attempt?: number
  readonly run: SixbFailedRun
}
```

Narrow `context.run.kind` to access the definition identifier for that run:

```ts
onError(error, context) {
  if (context.run.kind === "projection") {
    console.error(`Projection ${context.run.projectionId} failed`, error)
  }

  if (context.run.kind === "workflow") {
    console.error(`Workflow ${context.run.workflowId} failed`, error)
  }
}
```

`notificationId` is stable for one failed-state transition and includes the project, run identity,
and failure timestamp. Use it as an idempotency or deduplication key at the notification
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
context contains identifiers only; it does not include action parameters, webhook bodies,
credentials, or queue payloads.
