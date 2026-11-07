import {
  parseMaintenanceHeartbeatRow,
  serializeMaintenancePasses,
} from "@sixb/core/internal/storage"
import type { MaintenanceHeartbeatRecord, MaintenanceHeartbeatStorage } from "@sixb/core/storage"
import type { PgStoreClient } from "./transactions"

export class PgMaintenanceHeartbeatStorage implements MaintenanceHeartbeatStorage {
  constructor(private readonly sql: PgStoreClient) {}

  async record(heartbeat: MaintenanceHeartbeatRecord): Promise<void> {
    const passes = serializeMaintenancePasses(heartbeat.passes)
    await this.sql`
      INSERT INTO maintenance_heartbeats (project_id, beat_at, every_ms, passes)
      VALUES (
        ${heartbeat.projectId}, ${heartbeat.beatAt}, ${heartbeat.everyMs}, ${passes}::text::jsonb
      )
      ON CONFLICT (project_id) DO UPDATE SET
        beat_at = EXCLUDED.beat_at,
        every_ms = EXCLUDED.every_ms,
        passes = EXCLUDED.passes
    `
  }

  async get(input: { readonly projectId: string }): Promise<MaintenanceHeartbeatRecord | null> {
    const [row] = await this.sql<PgMaintenanceHeartbeatRow[]>`
      SELECT project_id, beat_at, every_ms, passes
      FROM maintenance_heartbeats
      WHERE project_id = ${input.projectId}
    `
    if (!row) return null

    return parseMaintenanceHeartbeatRow({
      projectId: row.project_id,
      beatAt: row.beat_at,
      everyMs: row.every_ms,
      passes: row.passes,
    })
  }
}

interface PgMaintenanceHeartbeatRow {
  readonly project_id: string
  readonly beat_at: Date
  readonly every_ms: number
  readonly passes: unknown
}
