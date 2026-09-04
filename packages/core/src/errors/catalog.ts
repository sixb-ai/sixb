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
  "ai.usage_limit_exceeded": {
    publicMessage: "AI usage limit exceeded.",
    retryable: false,
  },
  "ai.usage_limit_unavailable": {
    publicMessage: "AI usage limit could not be evaluated.",
    retryable: true,
  },
  "connector.adapter_invalid": {
    publicMessage: "Connector adapter returned an invalid result.",
    retryable: false,
  },
  "connector.authorization_invalid": {
    publicMessage: "Connector authorization is invalid.",
    retryable: false,
  },
  "connector.authorization_required": {
    publicMessage: "Connector authorization is required.",
    retryable: false,
  },
  "connector.configuration_invalid": {
    publicMessage: "Connector configuration is invalid.",
    retryable: false,
  },
  "connector.credentials_unavailable": {
    publicMessage: "Connector credentials are unavailable.",
    retryable: false,
  },
  "connector.not_found": {
    publicMessage: "Connector resource not found.",
    retryable: false,
  },
  "connector.operation_conflict": {
    publicMessage: "Connector operation conflicts with the current state.",
    retryable: false,
  },
  "connector.operation_in_progress": {
    publicMessage: "Another connector credential operation is in progress.",
    retryable: true,
  },
  "connector.provider_failed": {
    publicMessage: "Connector provider operation failed.",
    retryable: false,
  },
  "connector.provider_unavailable": {
    publicMessage: "Connector provider is temporarily unavailable.",
    retryable: true,
  },
  "connector.replacement_required": {
    publicMessage: "Connector selection requires explicit replacement.",
    retryable: false,
  },
  "connector.revocation_pending": {
    publicMessage: "Connector revocation is pending.",
    retryable: true,
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
  "sync.execution_failed": {
    publicMessage: "Sync execution failed.",
    retryable: false,
  },
  "webhook.delivery_failed": {
    publicMessage: "Webhook delivery failed.",
    retryable: true,
  },
  "webhook.delivery_rejected": {
    publicMessage: "Webhook delivery was rejected.",
    retryable: false,
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
