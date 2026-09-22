# Logging

Use handler logs to understand what your project did during a run. Sixb attaches the run and step context automatically, so you can inspect the output in Atlas.

## Write a log

Handlers receive a `logger`. Add a message and structured fields where they help explain an operation:

```ts
// actions/mark-paid.ts
import { defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const markPaid = defineAction("markPaid")
  .on(Invoice)
  .params({})
  .edits(({ subject, objects, logger }) => {
    logger.info("Marking invoice paid", { invoiceId: subject.primaryId })
    objects(Invoice).byId(subject.primaryId).update({ status: "paid" })
  })
```

| Method | Use for |
| --- | --- |
| `logger.debug(message, fields?)` | Extra detail while diagnosing a problem. |
| `logger.info(message, fields?)` | Normal progress. |
| `logger.warn(message, fields?)` | A recoverable problem. |
| `logger.error(errorOrMessage, fields?)` | A failure, optionally including an `Error`. |
| `logger.child(fields)` | Reuse fields across several messages. |

Keep fields JSON-serializable and avoid logging credentials. Let failures propagate so Sixb can record the failed run.

## View logs

Open **Logs** in Atlas to filter by run, kind, or level. Individual run pages also include their logs. Reading logs requires `can.observe("logs")` in a [role](../auth/authorization.md).

Capture is enabled at `info` level by default. Stored logs have bounded retention; use an external output provider when you need longer retention.

To read logs in your own interface, use the [Client SDK](../client/overview.md#read-run-logs).

## Configure output

Add an output provider to also send handler logs to your process output. Install `@sixb/logger-pino`, then add it to `sixb.config.ts`:

```ts
import { PinoLogger } from "@sixb/logger-pino"

const logger = new PinoLogger({ level: "info" })
```

Pass `logger` to `createSixb()`. See the [Pino provider README](https://github.com/sixb-ai/sixb/tree/main/loggers/pino#readme) for output options.

Capture settings are independent of the output provider. For example, pass this as `observability` to capture debug logs and redact a field:

```ts
const observability = {
  logs: {
    level: "debug" as const,
    redact: { paths: ["accessToken"] },
  },
}
```

Other capture options include `enabled`, `maxLinesPerExecution`, and `retention`. Field redaction here applies to captured logs; configure the output provider's redaction separately.

## Report failures

Add `onError` to `sixb.config.ts` to report failures to your monitoring service:

```ts
import type { SixbErrorHandler } from "@sixb/core"
import { reportError } from "./lib/monitoring"

const onError: SixbErrorHandler = (error, context) => {
  reportError(error, {
    projectId: context.projectId,
    type: context.type,
    code: context.failure.code,
    notificationId: context.notificationId,
  })
}
```

Pass `onError` to `createSixb()`. `reportError` is your monitoring integration. Providing the callback replaces Sixb's default failure output to `console.error`.

| Notification | Meaning |
| --- | --- |
| `run.failed` | A run failed. `runKind` and `run.runId` identify it. |
| `action.phase.failed` | Post-commit action effects failed; the data changes remain committed. |
| `event.delivery.failed` | Event delivery failed. |
| `rule.evaluation.failed` | Rule evaluation failed. |
| `vector.indexing.failed` | Automatic vector indexing failed. The context identifies the object and profile. |

Notifications may be repeated, and a process crash can prevent delivery. Use `notificationId` to deduplicate alerts. The callback does not change the operation's outcome.

See [Errors](../errors/overview.md) for failure fields and stable error codes.
