import { isJsonValue, type JsonValue } from "../json"

/** Log severity, ordered `debug < info < warn < error`. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

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
export const LOG_RUN_KINDS = ["sync", "pipeline", "workflow", "action", "webhook"] as const
export type LogRunKind = (typeof LOG_RUN_KINDS)[number]

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

/** A broker-backed log line tagged with its opaque stream cursor. */
export type StoredLogLine = LogRecord & { readonly cursor: string }

/**
 * Process-level output destination. Providers own their lifecycle; handlers
 * only receive the narrower {@link Logger} façade.
 */
export interface LoggerProvider {
  write(entry: LogEntry): void
  flush?(): void | Promise<void>
  close?(): void | Promise<void>
}

/** True when `level` meets or exceeds the `threshold`. */
export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  const levelIndex = LOG_LEVELS.indexOf(level)
  const thresholdIndex = LOG_LEVELS.indexOf(threshold)
  return levelIndex >= 0 && thresholdIndex >= 0 && levelIndex >= thresholdIndex
}

/** Every log level at or above the threshold, in ascending severity order. */
export function logLevelsAtOrAbove(threshold: LogLevel): readonly LogLevel[] {
  const thresholdIndex = LOG_LEVELS.indexOf(threshold)
  return thresholdIndex < 0 ? [] : LOG_LEVELS.slice(thresholdIndex)
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)
}

export function isLogRunKind(value: unknown): value is LogRunKind {
  return typeof value === "string" && (LOG_RUN_KINDS as readonly string[]).includes(value)
}

export function isLogRecord(value: unknown): value is LogRecord {
  return (
    isRecord(value) &&
    isLogLevel(value.level) &&
    typeof value.message === "string" &&
    typeof value.at === "string" &&
    (value.fields === undefined || isLogFields(value.fields)) &&
    isLogContext(value.context)
  )
}

export function isStoredLogLine(value: unknown): value is StoredLogLine {
  return isRecord(value) && isLogRecord(value) && typeof value.cursor === "string"
}

function isLogFields(value: unknown): value is LogFields {
  return isRecord(value) && isJsonValue(value)
}

function isLogContext(value: unknown): value is LogContext {
  return (
    isRecord(value) &&
    isRecord(value.run) &&
    isLogRunKind(value.run.kind) &&
    typeof value.run.id === "string" &&
    (value.stepId === undefined || typeof value.stepId === "string") &&
    (value.phase === undefined || typeof value.phase === "string") &&
    (value.attempt === undefined ||
      (typeof value.attempt === "number" && Number.isFinite(value.attempt)))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
