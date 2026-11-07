import type { LakeRetentionRunRecord, MaintenanceHeartbeatRecord } from "../storage"
import type { LakeMaintenanceSettings } from "./lake-retention"
import { LAKE_RETENTION_PASS_ID } from "./passes/lake-retention-pass"
import { isStale } from "./status"

export type LakeRetentionState =
  /** `lakeMaintenance.enabled` is false. */
  | "off"
  /** On, with nothing to clean: no datasets, or a provider without maintenance. */
  | "idle"
  /** No maintenance loop is asking for retention: the orchestrator does not run. */
  | "not-requested"
  /** Requests go out and no lake worker runs them. */
  | "no-worker"
  /** The last request or the last run failed. */
  | "failing"
  /** A lake worker is running it now. */
  | "cleaning"
  /** Requests go out and a lake worker ran the last one. */
  | "ok"

export interface LakeRetentionStatus {
  readonly state: LakeRetentionState
  /** When the orchestrator last asked for retention. */
  readonly lastRequestedAt: string | null
  /** When a lake worker last started a run. */
  readonly lastRunAt: string | null
}

export interface LakeRetentionStatusInput {
  readonly settings: Pick<LakeMaintenanceSettings, "enabled" | "cleanupEveryMs">
  readonly automatic: boolean
  /** What the maintenance loop last wrote. Null when none ever did. */
  readonly heartbeat: MaintenanceHeartbeatRecord | null
  /** The last run. Null when a lake worker never ran one. */
  readonly lastRun: LakeRetentionRunRecord | null
  readonly now: Date
}

/** Which of the two halves of automatic retention runs, from durable state alone. */
export function lakeRetentionStatus(input: LakeRetentionStatusInput): LakeRetentionStatus {
  return {
    state: stateOf(input),
    lastRequestedAt: passOf(input.heartbeat)?.lastSucceededAt?.toISOString() ?? null,
    lastRunAt: input.lastRun?.startedAt.toISOString() ?? null,
  }
}

function stateOf(input: LakeRetentionStatusInput): LakeRetentionState {
  const { settings, heartbeat, lastRun, now } = input

  if (!settings.enabled) return "off"
  if (!input.automatic) return "idle"

  const pass = passOf(heartbeat)
  if (heartbeat === null || pass === null || isStale(heartbeat, now)) return "not-requested"
  if (pass.consecutiveFailures > 0) return "failing"
  if (pass.lastSucceededAt === null) return "not-requested"

  if (lastRun === null) return "no-worker"
  if (isBehind(pass.lastSucceededAt, lastRun, settings.cleanupEveryMs)) return "no-worker"
  if (lastRun.finishedAt === null) return "cleaning"

  return lastRun.failed ? "failing" : "ok"
}

function passOf(heartbeat: MaintenanceHeartbeatRecord | null) {
  return heartbeat?.passes.find((pass) => pass.id === LAKE_RETENTION_PASS_ID) ?? null
}

/**
 * A run starts shortly after its request, so a request one whole interval past the last run means
 * the one before it went unanswered.
 */
function isBehind(
  lastRequestedAt: Date,
  lastRun: LakeRetentionRunRecord,
  cleanupEveryMs: number
): boolean {
  return lastRequestedAt.getTime() - lastRun.startedAt.getTime() > cleanupEveryMs
}
