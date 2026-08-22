interface SixbErrorDefinition {
  readonly publicMessage: string
  readonly retryable: boolean
}

/**
 * Source of truth for stable Sixb error codes and their framework-level policy.
 *
 * Keep this catalog internal. Consumers receive the `SixbErrorCode` union and persisted
 * `SixbFailure` values, not a mutable registry.
 */
export const SIXB_ERROR_DEFINITIONS = {
  "action.phase_failed": {
    publicMessage: "Action execution failed.",
    retryable: false,
  },
  "agent.execution_failed": {
    publicMessage: "Agent execution failed.",
    retryable: false,
  },
  "dataset.not_found": {
    publicMessage: "Dataset not found.",
    retryable: false,
  },
  "dataset.version_incompatible": {
    publicMessage: "Dataset version is incompatible.",
    retryable: false,
  },
  "dataset.version_not_found": {
    publicMessage: "Dataset version not found.",
    retryable: false,
  },
  "dataset.version_read_inconsistent": {
    publicMessage: "Dataset version could not be read consistently.",
    retryable: true,
  },
  "event.delivery_failed": {
    publicMessage: "Event delivery failed.",
    retryable: true,
  },
  "internal.unexpected": {
    publicMessage: "An unexpected internal error occurred.",
    retryable: false,
  },
  "queue.enqueue_failed": {
    publicMessage: "The job could not be enqueued.",
    retryable: true,
  },
  "pipeline.step_failed": {
    publicMessage: "Pipeline step execution failed.",
    retryable: false,
  },
  "projection.definition_invalid": {
    publicMessage: "Projection definition is invalid.",
    retryable: false,
  },
  "projection.execution_failed": {
    publicMessage: "Projection execution failed.",
    retryable: false,
  },
  "projection.not_found": {
    publicMessage: "Projection not found.",
    retryable: false,
  },
  "projection.run_already_terminal": {
    publicMessage: "Projection run is already terminal.",
    retryable: false,
  },
  "projection.run_identity_mismatch": {
    publicMessage: "Projection run identity does not match the queued job.",
    retryable: false,
  },
  "runtime.cancelled": {
    publicMessage: "Execution was cancelled.",
    retryable: false,
  },
  "share.access_unavailable": {
    publicMessage: "Shared access is unavailable.",
    retryable: false,
  },
  "share.action_invalid": {
    publicMessage: "Shared action request is invalid.",
    retryable: false,
  },
  "share.action_unavailable": {
    publicMessage: "Shared action is unavailable.",
    retryable: false,
  },
  "share.grant_not_found": {
    publicMessage: "Shared access grant not found.",
    retryable: false,
  },
  "share.resource_not_found": {
    publicMessage: "Shared resource not found.",
    retryable: false,
  },
  "share.type_not_found": {
    publicMessage: "Share type not found.",
    retryable: false,
  },
  "sync.execution_failed": {
    publicMessage: "Sync execution failed.",
    retryable: false,
  },
  "webhook.delivery_failed": {
    publicMessage: "Webhook delivery failed.",
    retryable: true,
  },
  "workflow.node_failed": {
    publicMessage: "Workflow node execution failed.",
    retryable: false,
  },
} as const satisfies Readonly<Record<string, SixbErrorDefinition>>

type CatalogErrorCode = keyof typeof SIXB_ERROR_DEFINITIONS

/** Runtime counterpart of `SixbErrorCode` for internal schema boundaries. */
export const SIXB_ERROR_CODES = Object.freeze(Object.keys(SIXB_ERROR_DEFINITIONS)) as readonly [
  CatalogErrorCode,
  ...CatalogErrorCode[],
]
