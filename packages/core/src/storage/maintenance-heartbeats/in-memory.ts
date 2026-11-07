import type { MaintenanceHeartbeatRecord, MaintenanceHeartbeatStorage } from "./types"

export class InMemoryMaintenanceHeartbeatStorage implements MaintenanceHeartbeatStorage {
  private rows = new Map<string, MaintenanceHeartbeatRecord>()

  async record(heartbeat: MaintenanceHeartbeatRecord): Promise<void> {
    this.rows.set(heartbeat.projectId, structuredClone(heartbeat))
  }

  async get(input: { readonly projectId: string }): Promise<MaintenanceHeartbeatRecord | null> {
    const row = this.rows.get(input.projectId)
    return row ? structuredClone(row) : null
  }

  snapshot(): ReadonlyMap<string, MaintenanceHeartbeatRecord> {
    return structuredClone(this.rows)
  }

  restore(snapshot: ReadonlyMap<string, MaintenanceHeartbeatRecord>): void {
    this.rows = structuredClone(new Map(snapshot))
  }
}
