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

interface SixbFailureContext<TType extends string> {
  readonly type: TType
  /** Stable key consumers can use to deduplicate this failure occurrence. */
  readonly notificationId: string
  readonly projectId: string
  readonly occurredAt: string
}

export interface SixbRunFailedContext extends SixbFailureContext<"run.failed"> {
  /** Queue delivery attempt, when the run was executed through a queue. */
  readonly attempt?: number
  readonly run: SixbFailedRun
}

export interface SixbEventDeliveryFailedContext
  extends SixbFailureContext<"event.delivery.failed"> {
  readonly attempts: number
  /** Stable envelope IDs only: payloads and lease identifiers are never exposed. */
  readonly eventIds: readonly string[]
}

/**
 * Context supplied to the global Sixb error handler.
 *
 * Failure notifications never change the outcome of the operation they observe.
 */
export type SixbErrorContext = SixbRunFailedContext | SixbEventDeliveryFailedContext

/** Observes runtime failures without changing their outcome. */
export type SixbErrorHandler = (error: Error, context: SixbErrorContext) => void | Promise<void>
