import type { JsonValue } from "../json"

/** Log severity, ordered `debug < info < warn < error`. */
export type LogLevel = "debug" | "info" | "warn" | "error"

/** Structured, JSON-serializable fields attached to a log line. */
export type LogFields = Record<string, JsonValue>

/**
 * The logger surface for project code.
 *
 * Handlers receive a run-bound `ctx.logger`; `createSixb({ logger })` swaps the
 * process-wide output sink. Calls are fire-and-forget — logging never throws
 * into a handler.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string | Error, fields?: LogFields): void
  /** Derive a logger that merges `bindings` into every subsequent line. */
  child(bindings: LogFields): Logger
}

/** The primitive whose run a log line belongs to. */
export type LogRunKind = "sync" | "pipeline" | "workflow" | "action"

/** Points a log line back at the run that produced it. */
export interface LogRunRef {
  readonly kind: LogRunKind
  readonly id: string
}

/** One stored log line — the payload of a `__logs` broker record. */
export interface LogRecord {
  readonly level: LogLevel
  readonly message: string
  readonly fields?: LogFields
  /** ISO-8601 emission timestamp. */
  readonly at: string
  readonly run: LogRunRef
}

/**
 * A run-bound logger. Handlers see it as a {@link Logger}; the worker that owns
 * the run holds the concrete type so it can {@link RunLogger.flush} buffered
 * lines deterministically at run end.
 */
export interface RunLogger extends Logger {
  child(bindings: LogFields): RunLogger
  /** Await delivery of every emitted line to the broker. Framework-internal. */
  flush(): Promise<void>
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** True when `level` meets or exceeds the `threshold`. */
export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold]
}

/** Normalize an `error(message | Error)` call into a string message + fields. */
export function normalizeLogError(
  message: string | Error,
  fields?: LogFields
): { message: string; fields?: LogFields } {
  if (message instanceof Error) {
    const error: LogFields = { name: message.name }
    if (message.stack !== undefined) {
      error.stack = message.stack
    }
    return { message: message.message, fields: { ...fields, error } }
  }
  return { message, fields }
}
