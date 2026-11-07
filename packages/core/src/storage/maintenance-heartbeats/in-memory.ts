import type { MaintenanceHeartbeatRecord, MaintenanceHeartbeatStorage } from "./types"

export class InMemoryMaintenanceHeartbeatStorage implements MaintenanceHeartbeatStorage {
  private rows = new Map<string, MaintenanceHeartbeatRecord>()

  async record(heartbeat: MaintenanceHeartbeatRecord): Promise<void> {
    this.rows.set(`${heartbeat.projectId}\u0000${heartbeat.owner}`, structuredClone(heartbeat))
  }

  async list(input: {
    readonly projectId: string
  }): Promise<readonly MaintenanceHeartbeatRecord[]> {
    const rows = [...this.rows.values()].filter((row) => row.projectId === input.projectId)
    return structuredClone(rows)
  }

  snapshot(): ReadonlyMap<string, MaintenanceHeartbeatRecord> {
    return structuredClone(this.rows)
  }

  restore(snapshot: ReadonlyMap<string, MaintenanceHeartbeatRecord>): void {
    this.rows = structuredClone(new Map(snapshot))
  }
}
