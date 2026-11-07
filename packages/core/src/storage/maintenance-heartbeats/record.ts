import type { MaintenanceHeartbeatRecord, MaintenancePassHealth } from "./types"

/** The stored form of `passes`: what `parseMaintenanceHeartbeatRow` reads back. */
export function serializeMaintenancePasses(passes: readonly MaintenancePassHealth[]): string {
  return JSON.stringify(passes)
}

/**
 * Rebuilds a heartbeat from a provider row with camelCase keys. `passes` may arrive parsed (jsonb)
 * or as text (SQLite), and `beatAt` as `Date` or ISO text.
 */
export function parseMaintenanceHeartbeatRow(row: {
  readonly [column: string]: unknown
}): MaintenanceHeartbeatRecord {
  const passes = typeof row.passes === "string" ? JSON.parse(row.passes) : row.passes
  if (!Array.isArray(passes)) throw corrupt(row.projectId, "passes is not a list")

  return {
    projectId: String(row.projectId),
    beatAt: new Date(row.beatAt as Date | string),
    everyMs: Number(row.everyMs),
    passes: passes.map((pass) => parsePass(pass, row.projectId)),
  }
}

function parsePass(value: unknown, projectId: unknown): MaintenancePassHealth {
  if (typeof value !== "object" || value === null) throw corrupt(projectId, "a pass is no object")

  const pass = value as Record<string, unknown>
  return {
    id: String(pass.id),
    lastSucceededAt:
      typeof pass.lastSucceededAt === "string" ? new Date(pass.lastSucceededAt) : null,
    consecutiveFailures: Number(pass.consecutiveFailures),
  }
}

function corrupt(projectId: unknown, reason: string): Error {
  return new Error(`[Sixb] Stored heartbeat of project '${projectId}' is invalid: ${reason}.`)
}
