# Logging runtime simplification

## Goal

Keep the logging model visible in the code: the handler-facing `Logger` façade emits one canonical
entry, then Sixb independently sends it to the optional output provider and to the broker capture.
The refactor removes implementation layers without weakening per-execution ordering, batching,
memory bounds, redaction, or failure isolation.

```text
ctx.logger -> ContextLogger -> RunLogSession
                                  |-> LoggerProvider (optional output)
                                  `-> bounded broker capture
```

## Responsibilities

- `Logger` remains the small façade exposed to project handlers.
- `LoggerProvider` remains the output-only port configured through `createSixb({ logger })`.
- `RunLogSession` owns all mutable state for one worker execution: derived context loggers, the
  capture quota, batching, backpressure, ordering, truncation reporting, and `flush()`.
- `ContextLogger` is the only internal façade implementation. It stores immutable framework context
  and user bindings, then delegates entries to its session.
- `LogsRuntime` owns project configuration, broker stream creation, and provider lifecycle.

`RunLoggerCore`, `RunLogSessionImpl`, and `createRunLogSession()` are removed. `RunLogSession` and
batching constants are internal implementation details rather than root `@sixb/core` exports.

## Defaults and public configuration

Broker capture is enabled by default. There is no output provider by default: omitting `logger`
means broker-only logs. `ConsoleLogger` remains an explicit provider for applications that want
stdout output.

The V1 public broker-capture configuration is limited to:

- `enabled`
- `level`
- `maxLinesPerExecution`
- `retention` (`maxAgeMs`, `maxRecords`, `maxBytes`)
- `redact` (`paths`, optional `censor`)

The name `maxLinesPerExecution` is intentional. Retries and workflow resumes can create multiple
worker executions for one logical run, so `maxLinesPerRun` would promise a distributed bound that
the runtime does not provide.

Record-size limits, buffered-byte limits, and batching thresholds remain fixed internal safeguards.
Redaction applies only to the broker copy; the configured output provider receives the original
entry.

## Lifecycle and failures

Handler log calls stay synchronous and must never throw. Provider and broker failures are reported
best-effort and cannot fail project code. Workers flush their `RunLogSession` in `finally`, which
drains only that execution's broker queue; provider `flush()` and `close()` remain process-level
`LogsRuntime` responsibilities.

The truncation marker must respect the same hard buffered-byte bound as ordinary captured records.
Tests cover broker-only defaults, explicit console/provider output, shared execution quotas across
derived loggers, batching order, bounded backpressure, redaction, failure isolation, and lifecycle.
