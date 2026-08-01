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

/**
 * Every kind of run Sixb records on a project's behalf.
 *
 * This is the one list: log lines, failed-run reports, and log stream selectors all name their
 * producer from here. A kind is listed as soon as the run record exists, even when nothing writes logs
 * for it yet — adding a writer later is additive, widening this union is not.
 *
 * The test is whether the thing has a run with an id. Rules do not: they are evaluated live, per
 * subject, and Sixb keeps no record of an evaluation, which is why they are absent here and report
 * through `SixbRuleEvaluationFailedContext` instead.
 */
export const SIXB_RUN_KINDS = [
  "action",
  "agent",
  "pipeline",
  "projection",
  "sync",
  "webhook",
  "workflow",
] as const
export type SixbRunKind = (typeof SIXB_RUN_KINDS)[number]

/** Points a log line back at the run that produced it. */
export interface LogRunRef {
  readonly kind: SixbRunKind
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

export function isSixbRunKind(value: unknown): value is SixbRunKind {
  return typeof value === "string" && (SIXB_RUN_KINDS as readonly string[]).includes(value)
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
    isSixbRunKind(value.run.kind) &&
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
