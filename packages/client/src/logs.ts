// The client-side log model, fluent read/subscribe builder, and React-free transport.

export type {
  LogFields,
  LogLevel,
  LogRecord,
  LogRunKind,
  LogRunRef,
  StoredLogLine,
} from "@sixb/core/logging"
export { isStoredLogLine, isStoredLogLine as isSixbLogLine } from "@sixb/core/logging"
/** One stored log line delivered by the `logs` builder (`.read()` or live `.subscribe()`). */
export type SixbLogLine = import("@sixb/core/logging").StoredLogLine
export * from "./logs-builder"
export * from "./logs-transport"
