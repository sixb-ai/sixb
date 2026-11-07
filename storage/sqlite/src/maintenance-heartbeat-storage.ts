import type { Database } from "bun:sqlite"
import {
  parseMaintenanceHeartbeatRow,
  serializeMaintenancePasses,
} from "@sixb/core/internal/storage"
import type { MaintenanceHeartbeatRecord, MaintenanceHeartbeatStorage } from "@sixb/core/storage"
import type { SqliteStoreConnection } from "./transactions"

export class SqliteMaintenanceHeartbeatStorage implements MaintenanceHeartbeatStorage {
  private readonly db: Database

  constructor(connection: SqliteStoreConnection) {
    this.db = connection.db
  }

  async record(heartbeat: MaintenanceHeartbeatRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO maintenance_heartbeats (project_id, owner, beat_at, every_ms, passes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (project_id, owner) DO UPDATE SET
           beat_at = excluded.beat_at,
           every_ms = excluded.every_ms,
           passes = excluded.passes`
      )
      .run(
        heartbeat.projectId,
        heartbeat.owner,
        heartbeat.beatAt.toISOString(),
        heartbeat.everyMs,
        serializeMaintenancePasses(heartbeat.passes)
      )
  }

  async list(input: {
    readonly projectId: string
  }): Promise<readonly MaintenanceHeartbeatRecord[]> {
    const rows = this.db
      .query(
        `SELECT project_id AS projectId, owner, beat_at AS beatAt, every_ms AS everyMs, passes
         FROM maintenance_heartbeats
         WHERE project_id = ?`
      )
      .all(input.projectId)

    return rows.map((row) => parseMaintenanceHeartbeatRow(row as Record<string, unknown>))
  }
}
