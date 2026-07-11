import type { BrokerStreamDefinition } from "../broker"

/** 30 days in milliseconds — the age bound for retained log lines. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/** Default upper bound for the complete retained logs stream. */
export const DEFAULT_LOGS_MAX_BYTES = 256 * 1024 * 1024

/** Portable retention for the project-wide, ephemeral logs stream. */
export const DEFAULT_LOGS_RETENTION = {
  maxAgeMs: THIRTY_DAYS_MS,
  maxRecords: 100_000,
  maxBytes: DEFAULT_LOGS_MAX_BYTES,
} as const

/** The single project-wide broker stream that carries every run's log lines. */
export const LOGS_STREAM: BrokerStreamDefinition = {
  id: "__logs",
  retention: DEFAULT_LOGS_RETENTION,
}

/** Maximum captured lines per worker execution, excluding its truncation marker. */
export const DEFAULT_MAX_LINES_PER_EXECUTION = 10_000

/** Maximum UTF-8 size of one serialized broker record payload. */
export const DEFAULT_MAX_LOG_RECORD_BYTES = 64 * 1024

/** Number of records that triggers an immediate broker append. */
export const DEFAULT_LOG_BATCH_MAX_RECORDS = 64

/** Serialized payload bytes that trigger an immediate broker append. */
export const DEFAULT_LOG_BATCH_MAX_BYTES = 256 * 1024

/** Maximum time a partial batch waits before being appended. */
export const DEFAULT_LOG_BATCH_MAX_DELAY_MS = 10

/** Maximum pending bytes while a previous broker append is in flight. */
export const DEFAULT_LOG_MAX_BUFFERED_BYTES = 1024 * 1024
