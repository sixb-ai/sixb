import type { MaintenanceLoopOwner } from "../storage"

export interface OntologyMaintenanceOptions {
  /** Delay between completed passes. Defaults to 60 seconds. */
  readonly intervalMs?: number
  /** Published outbox retention. Defaults to 24 hours. */
  readonly publishedOutboxRetentionMs?: number
  /**
   * Retention of superseded source versions. Defaults to 24 hours. Abandoned candidates have none:
   * nothing reads them, so the next pass deletes them whole.
   */
  readonly terminalSourceRetentionMs?: number
  /**
   * Maximum deletions attempted per cleanup domain and pass. Defaults to 1,000. Abandoned
   * candidates are deleted in larger batches until none is left or the pass reaches `intervalMs`.
   */
  readonly cleanupLimit?: number
  /** Report after this shutdown grace period, then wait for active operations. Defaults to 30 seconds. */
  readonly shutdownTimeoutMs?: number
}

export interface OutboxSummary {
  readonly pendingCount: number
  readonly oldestPendingAt: string | null
  readonly retryingCount: number
  readonly maxAttempts: number
}

export interface OntologyMaintenanceHandle {
  stop(): Promise<void>
}

/** No error text: a driver's message can hold a secret, and what failed goes to `onError`. */
export interface MaintenancePassStatus {
  readonly id: string
  readonly lastSucceededAt: string | null
  readonly consecutiveFailures: number
}

export interface OntologyOperationalStatus {
  /** `unknown`: no maintenance loop ever reported, so nothing says one runs. */
  readonly status: "ok" | "degraded" | "unknown"
  readonly maintenance: {
    /** Whose loop this describes: the orchestrator's whenever one ever reported. */
    readonly owner: MaintenanceLoopOwner | null
    /** When that loop last reported. Null when none ever did. */
    readonly beatAt: string | null
    /** The loop stopped reporting: it stopped, or it cannot reach storage. */
    readonly stale: boolean
    readonly passes: readonly MaintenancePassStatus[]
    readonly outbox: OutboxSummary
  }
}

export interface SixbReadiness {
  readonly status: "ready" | "unready"
  readonly storage: {
    readonly reachable: boolean
    readonly schemaValid: boolean
  }
  readonly reason?: string
}
