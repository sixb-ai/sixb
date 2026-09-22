# Errors

Sixb errors include a stable `code` for programmatic handling and a `message` for display. Do not parse message text; tolerate unknown codes when connecting to a newer server.

## API errors

Failed HTTP requests return an error message and, when available, a code. Browser client errors expose these as `SixbApiError`. Use `isSixbApiError` from `@sixb/client` to narrow an error before inspecting its `code`, `status`, or `body`.

Generated SDK functions reject when `throwOnError: true` is set; otherwise inspect their returned `error`. Typed query validation failures use `SixbQueryError` with an `issues` array.

## Run failures

Failed runs include a failure record:

| Field | Meaning |
| --- | --- |
| `code` | Stable error identifier. |
| `message` | Human-readable explanation. |
| `retryable` | Whether retrying may help. |
| `at` | Failure timestamp. |
| `details` | Optional context, which may be redacted or truncated. |
| `httpStatus` | Optional upstream HTTP status, not the status returned by Sixb. |

A retryable failure does not guarantee that an operation with external effects can be repeated safely. Check the run and external system before retrying. Unclassified failures use `internal.unexpected`.

Messages include safe validation explanations and recognized upstream failures. Arbitrary exception
messages and stacks stay private to `onError`; unclassified errors use a generic message.

To send failures to a monitoring service, configure [onError](../logging/overview.md#report-failures).

## Error catalog

| Code | Retryable | What happened | What to do |
| --- | --- | --- | --- |
| `action.phase_failed` | No | An Action phase could not complete successfully. | Inspect `details.phase` and the native error reported to `onError`. |
| `agent.execution_failed` | No | An active Agent execution failed. | Inspect the run identity and the native error reported to `onError`. |
| `ai.usage_limit_exceeded` | No | An applicable AI usage limit has no capacity for another model call. | Wait until `details.resetAt`, or raise or disable the applicable limit policy. |
| `ai.usage_limit_unavailable` | Yes | Sixb could not evaluate an applicable AI usage limit safely. | Restore complete accounting or the limit storage provider, then retry. |
| `connector.adapter_invalid` | No | A connector adapter returned data that violates its Sixb contract. | Fix or upgrade the adapter before retrying. |
| `connector.authorization_invalid` | No | An OAuth connection run or authorization transition is no longer valid. | Start a new connector connection run. |
| `connector.authorization_required` | No | The connection cannot provide credentials in its current state. | Reauthorize the connector and select an account when requested. |
| `connector.configuration_invalid` | No | Connector definitions, storage, or credential protection are misconfigured. | Fix the connector runtime configuration and restart Sixb. |
| `connector.credentials_unavailable` | No | Stored connector credentials failed validation or authenticated decryption. | Verify the encryption key and reauthorize affected connections. |
| `connector.not_found` | No | A connector definition, connection, authorization, or account was not found in the current project. | Check the identifier or reconnect the account. |
| `connector.operation_conflict` | No | Connector state changed incompatibly with the requested operation. | Reload current connection state and start a new operation explicitly. |
| `connector.operation_in_progress` | Yes | Another process is safely mutating the same authorization credentials. | Retry after the current credential operation finishes. |
| `connector.provider_failed` | No | A provider operation failed or ended with an ambiguous outcome. | Inspect the native cause; restart authorization when Sixb failed closed. |
| `connector.provider_unavailable` | Yes | The adapter guaranteed that a failed provider operation produced no external change. | Retry the unchanged operation later. |
| `connector.replacement_required` | No | Account selection would replace the connection currently assigned to the slot. | Confirm replacement, then retry selection with `replace: true`, or choose another slot. |
| `connector.revocation_pending` | Yes | Local access is disconnected, but provider revocation has not been durably confirmed. | Retry revocation; the operation is idempotent and local access remains closed. |
| `dataset.not_found` | No | Dataset is unavailable to the caller. | Check its ID and access policy. |
| `dataset.version_incompatible` | No | Version does not match the required dataset or schema. | Materialize a compatible version. |
| `dataset.version_not_found` | No | Version does not exist or nothing has been committed yet. | Check the ID or materialize the dataset. |
| `dataset.version_read_inconsistent` | Yes | Read results conflict with immutable version metadata. | Retry, then inspect lake storage integrity. |
| `event.delivery_failed` | Yes | A persisted event could not reach the event stream. | Let the outbox retry; inspect the broker if it persists. |
| `internal.unexpected` | No | The exception has no specific code yet. | Inspect its `onError` report and correlation details. |
| `pipeline.step_failed` | No | A step failed before committing its output. | Fix the cause and request a new pipeline run. |
| `projection.definition_invalid` | No | Projection definition is invalid for its ontology or dataset. | Fix the definition and request a new run. |
| `projection.execution_failed` | No | Projection materialization failed permanently. | Inspect the projection, pinned dataset version, and `onError` report. |
| `projection.not_found` | No | Projection is not registered. | Check its ID and deployment. |
| `projection.run_already_terminal` | No | Delivery targets a run that is already terminal. | Use a new run ID for new work. |
| `projection.run_identity_mismatch` | No | Delivery does not match the run's pinned identity. | Discard it and dispatch from the current definition. |
| `queue.enqueue_failed` | Yes | A job could not be handed to its queue. | Retry the unchanged request while the durable run remains in its enqueue phase. |
| `runtime.cancelled` | No | Work was cancelled before completion. | Confirm the cancellation before requesting another run. |
| `sync.execution_failed` | No | A Sync failed while reading, validating, or writing its dataset. | Inspect the `onError` report, fix the source or data, then request a new run. |
| `vector.model_unavailable` | No | The profile's embedding model is unavailable or incompatible. | Check model registration and dimensions, then index the profile again. |
| `vector.response_invalid` | No | The model returned unusable vectors. | Check the provider response and profile dimensions before indexing again. |
| `vector.outcome_unknown` | No | An interrupted call may already have been billed. | Inspect the provider outcome before explicitly indexing again. |
| `webhook.delivery_failed` | Yes | A claimed webhook delivery failed retryably. | Let the provider retry; inspect the handler if it persists. |
| `webhook.delivery_rejected` | No | A webhook handler returned a terminal non-success response. | Inspect the handler response and provider payload before sending a new delivery. |
| `workflow.node_failed` | No | A node failed during preparation or execution. | Inspect its identity and the native error reported to `onError`. |
