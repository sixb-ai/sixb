export interface OntologyMaintenanceOptions {
  /** Delay between completed passes. Defaults to 60 seconds. */
  readonly intervalMs?: number
  /** Published outbox retention. Defaults to 24 hours. */
  readonly publishedOutboxRetentionMs?: number
  /** Superseded/abandoned source retention. Defaults to 24 hours. */
  readonly terminalSourceRetentionMs?: number
  /** Maximum deletions attempted per cleanup domain and pass. Defaults to 1,000. */
  readonly cleanupLimit?: number
  /** Maximum time to wait for an active pass during shutdown. Defaults to 30 seconds. */
  readonly shutdownTimeoutMs?: number
}

export interface OntologyMaintenanceCleanupSnapshot {
  readonly publishedOutboxRowsDeleted: number
  readonly terminalSourceRowsDeleted: number
  readonly terminalSourceMaterializationsDeleted: number
}

export interface OntologyMaintenanceSnapshot {
  readonly running: boolean
  readonly intervalMs: number
  readonly lastStartedAt: string | null
  readonly lastCompletedAt: string | null
  readonly lastDurationMs: number | null
  readonly consecutiveFailures: number
  readonly lastError: string | null
  readonly outbox: {
    readonly pendingCount: number
    readonly oldestPendingAt: string | null
    readonly retryingCount: number
    readonly maxAttempts: number
  } | null
  readonly terminalSources: {
    readonly count: number
    readonly oldestTerminalAt: string | null
  } | null
  readonly cleanup: OntologyMaintenanceCleanupSnapshot | null
}

export interface OntologyMaintenanceHandle {
  stop(): Promise<void>
}

export interface OntologyOperationalStatus {
  readonly status: "ok" | "degraded"
  readonly maintenance: OntologyMaintenanceSnapshot
}

export interface SixbReadiness {
  readonly status: "ready" | "unready"
  readonly storage: {
    readonly reachable: boolean
    readonly schemaValid: boolean
  }
  readonly reason?: string
}
