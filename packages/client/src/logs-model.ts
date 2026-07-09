/**
 * The shared client-side log model (`@sixb/client/logs`).
 *
 * Log lines are far simpler than domain events — no topic/type unions, no
 * ontology typing — so the model is just the core {@link StoredLogLine} shape
 * re-exported plus a runtime guard the transport uses to validate wire frames.
 */
import type { StoredLogLine } from "@sixb/core"

export type {
  LogFields,
  LogLevel,
  LogRecord,
  LogRunKind,
  LogRunRef,
  StoredLogLine,
} from "@sixb/core"

/** One stored log line delivered by the `logs` builder (`.read()` or live `.subscribe()`). */
export type SixbLogLine = StoredLogLine

export function isSixbLogLine(value: unknown): value is SixbLogLine {
  return (
    isRecord(value) &&
    typeof value.level === "string" &&
    typeof value.message === "string" &&
    typeof value.at === "string" &&
    typeof value.cursor === "string" &&
    isRecord(value.context) &&
    isRecord(value.context.run) &&
    typeof value.context.run.kind === "string" &&
    typeof value.context.run.id === "string"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
