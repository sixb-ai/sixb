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
      INSERT INTO maintenance_heartbeats (project_id, owner, beat_at, every_ms, passes)
      VALUES (
        ${heartbeat.projectId}, ${heartbeat.owner}, ${heartbeat.beatAt}, ${heartbeat.everyMs},
        ${passes}::text::jsonb
      )
      ON CONFLICT (project_id, owner) DO UPDATE SET
        beat_at = EXCLUDED.beat_at,
        every_ms = EXCLUDED.every_ms,
        passes = EXCLUDED.passes
    `
  }

  async list(input: {
    readonly projectId: string
  }): Promise<readonly MaintenanceHeartbeatRecord[]> {
    const rows = await this.sql<PgMaintenanceHeartbeatRow[]>`
      SELECT project_id, owner, beat_at, every_ms, passes
      FROM maintenance_heartbeats
      WHERE project_id = ${input.projectId}
    `

    return rows.map((row) =>
      parseMaintenanceHeartbeatRow({
        projectId: row.project_id,
        owner: row.owner,
        beatAt: row.beat_at,
        everyMs: row.every_ms,
        passes: row.passes,
      })
    )
  }
}

interface PgMaintenanceHeartbeatRow {
  readonly project_id: string
  readonly owner: string
  readonly beat_at: Date
  readonly every_ms: number
  readonly passes: unknown
}
