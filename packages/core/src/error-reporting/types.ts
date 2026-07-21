export type SixbFailedRun =
  | {
      readonly kind: "action"
      readonly runId: string
      readonly actionId: string
    }
  | {
      readonly kind: "agent"
      readonly runId: string
      readonly agentId: string
    }
  | {
      readonly kind: "pipeline"
      readonly runId: string
      readonly pipelineId: string
    }
  | {
      readonly kind: "projection"
      readonly runId: string
      readonly projectionId: string
      readonly projectionKind: "object" | "link" | "telemetry"
    }
  | {
      readonly kind: "sync"
      readonly runId: string
      readonly syncId: string
    }
  | {
      readonly kind: "workflow"
      readonly runId: string
      readonly workflowId: string
    }
  | {
      readonly kind: "webhook"
      readonly runId: string
      readonly connectorId: string
      readonly webhookId: string
    }

export interface SixbRunFailedContext {
  readonly type: "run.failed"
  /** Stable key consumers can use to deduplicate this failure occurrence. */
  readonly notificationId: string
  readonly projectId: string
  readonly occurredAt: string
  /** Queue delivery attempt, when the run was executed through a queue. */
  readonly attempt?: number
  readonly run: SixbFailedRun
}

/**
 * Context supplied to the global Sixb error handler.
 *
 * V1 emits terminal `run.failed` notifications only. Additional error context types may be added
 * later.
 */
export type SixbErrorContext = SixbRunFailedContext

/** Observes terminal failed runs without changing their outcome. */
export type SixbErrorHandler = (error: Error, context: SixbErrorContext) => void | Promise<void>
