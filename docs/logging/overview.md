# Logging

Logging captures structured lines from your runs and makes them readable everywhere — in code,
in your app, and in the Atlas UI. Reach for it when you need to see what a sync, pipeline,
workflow, or action actually did: the requests it made, the branches it took, the errors it
swallowed. Each line is tagged with the run that produced it, so you can follow one execution end
to end.

Lines flow to two independent destinations:

- **A bounded broker stream** (`__logs`) — captured by default whenever a `broker` is configured.
  This is what `sixb.logs`, the client `logs` builder, and the Atlas Logs page read.
- **An optional process-level output provider** — stdout, a file, or a hosted sink via
  [`@sixb/logger-pino`](#output-providers). Omit it for broker-only logging.

## Logging from a handler

Action, sync, pipeline, and workflow handlers receive a `logger` on their context.

```ts
import { defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const sendInvoice = defineAction("send-invoice")
  .target(Invoice)
  .params({})
  .run(async ({ target, logger }) => {
    logger.info("sending invoice", { invoiceId: target.primaryId })

    try {
      await deliver(target.primaryId)
      logger.info("invoice sent")
    } catch (error) {
      logger.error(error instanceof Error ? error : "delivery failed")
      throw error
    }
  })
```

The `logger` is a small, fire-and-forget surface — logging never fails a handler:

| Method | Purpose |
| --- | --- |
| `logger.debug(message, fields?)` | Verbose detail, off by default (capture level is `info`) |
| `logger.info(message, fields?)` | Normal progress |
| `logger.warn(message, fields?)` | Recoverable problem |
| `logger.error(message \| Error, fields?)` | Failure; pass an `Error` to capture its name and stack |
| `logger.child(bindings)` | Return a logger that adds fixed `fields` to every line |

`fields` is any JSON-serializable object (`Record<string, JsonValue>`). Use `child` to bind
context once instead of repeating it:

```ts
const step = logger.child({ step: "reconcile", batchId })
step.info("batch started", { rows: rows.length })
step.warn("row skipped", { rowId })
```

Framework metadata — the run reference, step id, phase, attempt — is attached automatically and
cannot be overwritten through `child()`.

## Reading logs in code

`sixb.logs` reads the captured stream from trusted code (server routes, tests, tooling):

```ts
const page = await sixb.logs.read({
  kinds: ["action"], // sync | pipeline | workflow | action
  levels: ["warn", "error"],
  limit: 100,
})

for (const line of page.lines) {
  console.log(line.at, line.context.run, line.level, line.message, line.fields)
}
// page.cursor / page.hasMore paginate forward
```

Scope to a single run with `run: { kind, id }`, page backward from the newest line with
`sixb.logs.tail(...)`, or stream new lines live with `sixb.logs.subscribe(input, handler)`.
When no `broker` is configured, reads return an empty page (output-only logging).

## Reading logs in an app

`@sixb/client/logs` exposes the same stream to app pages through a fluent builder that mirrors the
[client events](../client/events.md) API. The transport is React-free — drive it from an effect.

```tsx
import { logs, type SixbLogLine } from "@sixb/client/logs"
import { useEffect, useState } from "react"

function ActionLogs({ runId }: { runId: string }) {
  const [lines, setLines] = useState<SixbLogLine[]>([])

  useEffect(() => {
    const stop = logs
      .actions()
      .run(runId)
      .level("info")
      .subscribe((line) => setLines((prev) => [...prev, line]))
    return stop
  }, [runId])

  return <pre>{lines.map((l) => `${l.at} ${l.level} ${l.message}`).join("\n")}</pre>
}
```

The root selectors are `logs.all()`, `logs.syncs()`, `logs.pipelines()`, `logs.workflows()`,
`logs.actions()`, and `logs.webhooks()`. Refine with `.level(level)` (captures that level and above)
and, on a run-kind builder, `.run(runId)`. Every builder terminates with `.subscribe(handler,
options?)` for a live socket or `.read(options?)` / `.tail(options?)` for a page.

## The Atlas Logs page

The built-in Atlas UI ships a **Logs** console that streams the same broker stream with kind,
level, and run filters, plus a per-run **Logs** tab on sync, pipeline, workflow, and action run
pages. No setup is required beyond configuring a `broker`.

## Configuration

Both logging destinations are configured on `createSixb()`. Both are optional; broker capture is
on by default.

```ts
import { PinoLogger } from "@sixb/logger-pino"

export const sixb = await createSixb({
  // ...required providers
  logger: new PinoLogger({ level: "info" }), // process-level output (optional)
  observability: {
    logs: {
      enabled: true, // forward handler logs to the broker (default true)
      level: "info", // minimum level captured (default "info")
      maxLinesPerExecution: 10_000, // per-run cap (default 10,000)
      redact: { paths: ["password", "token", "headers.authorization"] },
    },
  },
})
```

| Option | Purpose |
| --- | --- |
| `logger` | Process-level `LoggerProvider` for output (stdout/file/transport). Omit for broker-only |
| `observability.logs.enabled` | Capture handler logs to the `__logs` broker stream. Default `true` |
| `observability.logs.level` | Minimum captured level. Default `"info"` |
| `observability.logs.retention` | Override the bounded stream retention (`maxAgeMs`, `maxRecords`, `maxBytes`) |
| `observability.logs.maxLinesPerExecution` | Captured lines per run. Default `10_000` |
| `observability.logs.redact` | Dot-path `paths` (relative to `fields`) replaced with `censor` (default `"[REDACTED]"`) |

Reading the captured stream requires the `observe:logs` grant (see
[Authorization](../auth/authorization.md)). The stream is bounded — old lines age out by the
retention policy above — so logging is durable enough to debug a run, not a long-term audit log.

## Output providers

Without a `logger`, logs are broker-only (readable through Atlas, `sixb.logs`, and the client
builder). Add a provider to also emit process-level output.

`@sixb/logger-pino` wraps [Pino](https://getpino.io) for structured stdout, files, and transports:

```ts
import { PinoLogger } from "@sixb/logger-pino"

// Simple: Sixb creates the Pino instance
new PinoLogger({ level: "debug" })

// Advanced: reuse a configured Pino instance (transports, destinations, redaction)
new PinoLogger({ instance: myPino })
```

To write your own provider, implement `LoggerProvider` from `@sixb/core` — a `write(entry)` plus
optional `flush()` and `close()`.

## Lifecycle

The provider owns process-level resources (open files, transports, buffers). Flush and release
them on shutdown:

```ts
await sixb.closeLogger()
```

`closeLogger()` flushes and closes the output provider; it is a no-op for broker-only logging.
Call it alongside `sixb.closeBroker()` and `sixb.connectors.disconnectAll()`.

## Related

- [Runtime](../runtime/overview.md) — `createSixb()` options and the `sixb.logs` surface
- [Client SDK](../client/overview.md) — the `@sixb/client/logs` subpath
- [Client events](../client/events.md) — the sibling live-stream builder for domain events
- [Infrastructure](../infrastructure/overview.md) — the `logger` provider slot and `@sixb/logger-pino`
- [Authorization](../auth/authorization.md) — the `observe:logs` grant
