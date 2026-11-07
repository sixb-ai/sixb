import type { MaintenanceHeartbeatRecord, MaintenanceLoopOwner } from "../storage"
import type { OntologyOperationalStatus, OutboxSummary } from "./types"

const STALE_AFTER_BEATS = 2
const DEGRADED_ATTEMPT_THRESHOLD = 3
const DEGRADED_FAILURE_THRESHOLD = 2

export interface OperationalStatusInput {
  /** What each maintenance loop last wrote. Empty when none ever did. */
  readonly heartbeats: readonly MaintenanceHeartbeatRecord[]
  readonly outbox: OutboxSummary
  /** How long an event may wait for delivery before that counts as a problem. */
  readonly pendingLimitMs: number
  readonly now: Date
}

/**
 * What an operator should think of the project's upkeep, from durable state alone: this process
 * may run no pass at all. A loop that never beat is `unknown`, because nothing says it runs, and
 * events waiting too long are `degraded` whoever was supposed to deliver them. An orchestrator's
 * heartbeat decides whenever one exists: an embedded server that beats says nothing about it.
 */
export function operationalStatus(input: OperationalStatusInput): OntologyOperationalStatus {
  const { heartbeats, outbox } = input
  const heartbeat = heartbeatOf(heartbeats, "orchestrator") ?? heartbeatOf(heartbeats, "embedded")
  const stale = heartbeat !== undefined && isStale(heartbeat, input.now)

  return {
    status: statusOf(input, heartbeat, stale),
    maintenance: {
      owner: heartbeat?.owner ?? null,
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

function heartbeatOf(
  heartbeats: readonly MaintenanceHeartbeatRecord[],
  owner: MaintenanceLoopOwner
): MaintenanceHeartbeatRecord | undefined {
  return heartbeats.find((heartbeat) => heartbeat.owner === owner)
}

function statusOf(
  input: OperationalStatusInput,
  heartbeat: MaintenanceHeartbeatRecord | undefined,
  stale: boolean
): OntologyOperationalStatus["status"] {
  if (stale || isFailing(heartbeat) || isOutboxStuck(input)) return "degraded"

  return heartbeat === undefined ? "unknown" : "ok"
}

export function isStale(heartbeat: MaintenanceHeartbeatRecord, now: Date): boolean {
  return now.getTime() - heartbeat.beatAt.getTime() > heartbeat.everyMs * STALE_AFTER_BEATS
}

function isFailing(heartbeat: MaintenanceHeartbeatRecord | undefined): boolean {
  return (heartbeat?.passes ?? []).some(
    (pass) => pass.consecutiveFailures >= DEGRADED_FAILURE_THRESHOLD
  )
}

function isOutboxStuck({ outbox, pendingLimitMs, now }: OperationalStatusInput): boolean {
  if (outbox.maxAttempts >= DEGRADED_ATTEMPT_THRESHOLD) return true
  if (outbox.oldestPendingAt === null) return false

  return now.getTime() - Date.parse(outbox.oldestPendingAt) > pendingLimitMs
}
