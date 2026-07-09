import type { BrokerStreamDefinition } from "../broker"

/** 30 days in milliseconds — the age bound for retained log lines. */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Retention for the shared `__logs` stream: a bounded ring dropped by age and
 * by total count. Logs are observability, not an audit trail, so the window is
 * intentionally ephemeral.
 */
export const DEFAULT_LOGS_RETENTION = {
  maxAgeMs: THIRTY_DAYS_MS,
  maxRecords: 100_000,
} as const

/** The single project-wide broker stream that carries every run's log lines. */
export const LOGS_STREAM: BrokerStreamDefinition = {
  id: "__logs",
  retention: DEFAULT_LOGS_RETENTION,
}

/**
 * Per-run line cap. Stops one runaway run from evicting every other run from the
 * shared ring; the run's logger emits a single truncation marker instead.
 */
export const DEFAULT_MAX_LINES_PER_RUN = 10_000
