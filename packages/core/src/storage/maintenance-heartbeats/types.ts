/** How one maintenance pass has fared since the process that runs it started. */
export interface MaintenancePassHealth {
  readonly id: string
  readonly lastSucceededAt: Date | null
  readonly consecutiveFailures: number
}

/** Who runs a maintenance loop: the orchestrator, or a server embedded with no orchestrator. */
export type MaintenanceLoopOwner = "orchestrator" | "embedded"

/**
 * The proof that a project's maintenance runs: one row per project and owner, which the loop
 * rewrites as it goes. The API reads it from another process, so it is what tells a stopped loop
 * from a quiet one. Each owner has its row, so one that runs cannot speak for one that stopped.
 */
export interface MaintenanceHeartbeatRecord {
  readonly projectId: string
  readonly owner: MaintenanceLoopOwner
  readonly beatAt: Date
  /** The longest the loop waits between two beats. A reader calls a beat stale from this. */
  readonly everyMs: number
  readonly passes: readonly MaintenancePassHealth[]
}

export interface MaintenanceHeartbeatStorage {
  /** Replaces this owner's heartbeat, passes included: a pass no longer run leaves the record. */
  record(heartbeat: MaintenanceHeartbeatRecord): Promise<void>
  /** Every owner's heartbeat for the project, in no particular order. */
  list(input: { readonly projectId: string }): Promise<readonly MaintenanceHeartbeatRecord[]>
}
