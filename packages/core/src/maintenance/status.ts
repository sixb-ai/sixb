import type { MaintenanceHeartbeatRecord } from "../storage"
import type { OntologyOperationalStatus, OutboxSummary } from "./types"

const STALE_AFTER_BEATS = 2
const DEGRADED_ATTEMPT_THRESHOLD = 3
const DEGRADED_FAILURE_THRESHOLD = 2

export interface OperationalStatusInput {
  /** What the maintenance loop last wrote. Null when none ever did. */
  readonly heartbeat: MaintenanceHeartbeatRecord | null
  readonly outbox: OutboxSummary
  /** How long an event may wait for delivery before that counts as a problem. */
  readonly pendingLimitMs: number
  readonly now: Date
}

/**
 * What an operator should think of the project's upkeep, from durable state alone: this process
 * may run no pass at all. A loop that never beat is `unknown`, because nothing says it runs, and
 * events waiting too long are `degraded` whoever was supposed to deliver them.
 */
export function operationalStatus(input: OperationalStatusInput): OntologyOperationalStatus {
  const { heartbeat, outbox } = input
  const stale = heartbeat !== null && isStale(heartbeat, input.now)

  return {
    status: statusOf({ ...input, stale }),
    maintenance: {
      beatAt: heartbeat?.beatAt.toISOString() ?? null,
      stale,
      passes: (heartbeat?.passes ?? []).map((pass) => ({
        ...pass,
        lastSucceededAt: pass.lastSucceededAt?.toISOString() ?? null,
      })),
      outbox,
    },
  }
}

function statusOf(
  input: OperationalStatusInput & { readonly stale: boolean }
): OntologyOperationalStatus["status"] {
  if (input.stale || isFailing(input.heartbeat) || isOutboxStuck(input)) return "degraded"

  return input.heartbeat === null ? "unknown" : "ok"
}

function isStale(heartbeat: MaintenanceHeartbeatRecord, now: Date): boolean {
  return now.getTime() - heartbeat.beatAt.getTime() > heartbeat.everyMs * STALE_AFTER_BEATS
}

function isFailing(heartbeat: MaintenanceHeartbeatRecord | null): boolean {
  return (heartbeat?.passes ?? []).some(
    (pass) => pass.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD
  )
}

function isOutboxStuck({ outbox, pendingLimitMs, now }: OperationalStatusInput): boolean {
  if (outbox.maxAttempts >= DEGRADED_ATTEMPT_THRESHOLD) return true
  if (outbox.oldestPendingAt === null) return false

  return now.getTime() - Date.parse(outbox.oldestPendingAt) > pendingLimitMs
}
