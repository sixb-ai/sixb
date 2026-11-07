/** How one maintenance pass has fared since the process that runs it started. */
export interface MaintenancePassHealth {
  readonly id: string
  readonly lastSucceededAt: Date | null
  readonly consecutiveFailures: number
  readonly lastError: string | null
}

/**
 * The proof that a project's maintenance runs: one row per project, which the loop rewrites as it
 * goes. The API reads it from another process, so it is what tells a stopped loop from a quiet one.
 */
export interface MaintenanceHeartbeatRecord {
  readonly projectId: string
  readonly beatAt: Date
  /** The longest the loop waits between two beats. A reader calls a beat stale from this. */
  readonly everyMs: number
  readonly passes: readonly MaintenancePassHealth[]
}

export interface MaintenanceHeartbeatStorage {
  /** Replaces the project's heartbeat, passes included: a pass no longer run leaves the record. */
  record(heartbeat: MaintenanceHeartbeatRecord): Promise<void>
  get(input: { readonly projectId: string }): Promise<MaintenanceHeartbeatRecord | null>
}
