# Runtime errors

Sixb failures have two identities:

- `code` is stable and intended for programmatic decisions.
- `message` is written for humans and must not be parsed.

Unclassified errors use `internal.unexpected`.

## API errors

HTTP errors may include a `code`. The client exposes it as
`SixbApiError.code`.

Always tolerate unknown codes: a newer server may introduce one before the client is upgraded.

```ts
if (isSixbApiError(error) && error.code === "dataset.not_found") {
  // Recover without depending on the human-readable message.
}
```

## Failure records

Persisted failures and API responses use the same portable record:

```ts
interface SixbFailure<TCode extends SixbErrorCode = SixbErrorCode> {
  readonly code: TCode
  readonly message: string
  readonly retryable: boolean
  readonly at: string
  readonly details?: JsonValue
  readonly httpStatus?: number
  readonly redacted?: true
  readonly truncated?: true
}
```

Use `code` for programmatic decisions and `message` for display. `httpStatus` describes the
upstream response, not the status returned by Sixb. `retryable` indicates whether retrying may help;
it does not guarantee that a run can safely be replayed after external side effects.

`redacted` and `truncated` indicate filtered or shortened details. Never put credentials in
`details`. The original exception is available to `onError` for diagnostics.

## Failure notifications

Add `onError` to `sixb.config.ts` to send failures to your monitoring service:

```ts
export const sixb = createSixb({
  // ...providers
  onError(error, context) {
    console.error(context.type, context.failure.code, error)
  },
})
```

Without this callback, Sixb logs failures to `console.error`. The callback replaces that default.

| `context.type` | What failed |
| --- | --- |
| `run.failed` | An action, agent, sync, pipeline, projection, workflow, or webhook run |
| `action.phase.failed` | Post-commit action effects; the action's data remains committed |
| `event.delivery.failed` | Event delivery; persisted events remain queued for retry |
| `rule.evaluation.failed` | Rule evaluation; `source` identifies live evaluation or reconciliation |
| `vector.indexing.failed` | Automatic vector indexing; identifies the object and profile |

For `run.failed`, inspect `context.runKind` and `context.run.runId`. Use `context.notificationId`
as a deduplication key when forwarding alerts. A failed rule reconciliation deserves attention:
it is the recovery path for missed live evaluations.

Notifications are best-effort. A crash can prevent delivery; callbacks may be repeated and should
be idempotent. A failing callback cannot change a run's outcome. Successes, cancellations, recoverable
retries, and routine webhook 4xx responses do not trigger notifications. Synchronous connector
errors reach their caller; if they fail a run, that run produces the notification.

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
