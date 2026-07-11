import type { JsonValue } from "../json"

/** Log severity, ordered `debug < info < warn < error`. */
export type LogLevel = "debug" | "info" | "warn" | "error"

/** Structured, JSON-serializable fields attached by project code. */
export type LogFields = Record<string, JsonValue>

/**
 * The logger surface exposed to project handlers.
 *
 * Calls are deliberately fire-and-forget: logging must never fail a handler.
 * `child()` only binds user fields; framework-owned context stays immutable.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string | Error, fields?: LogFields): void
  child(bindings: LogFields): Logger
}

/** The primitive whose execution produced a log line. */
export type LogRunKind = "sync" | "pipeline" | "workflow" | "action"

/** Points a log line back at the run that produced it. */
export interface LogRunRef {
  readonly kind: LogRunKind
  readonly id: string
}

/** Framework-owned metadata. It cannot be overwritten through `Logger.child()`. */
export interface LogContext {
  readonly run: LogRunRef
  readonly stepId?: string
  readonly phase?: string
  readonly attempt?: number
}

/** One complete entry sent to the configured output provider. */
export interface LogEntry {
  readonly level: LogLevel
  readonly message: string
  readonly fields?: LogFields
  /** ISO-8601 emission timestamp. */
  readonly at: string
  readonly context: LogContext
}

/** One sanitized, bounded log line stored in the `__logs` broker stream. */
export type LogRecord = LogEntry

/**
 * Process-level output destination. Providers own their lifecycle; handlers
 * only receive the narrower {@link Logger} façade.
 */
export interface LoggerProvider {
  write(entry: LogEntry): void
  flush?(): void | Promise<void>
  close?(): void | Promise<void>
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
