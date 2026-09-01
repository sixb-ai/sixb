# Runtime error codes

Sixb failures have two identities:

- `code` is stable and intended for programmatic decisions.
- `message` is written for humans and must not be parsed.

Unknown legacy exceptions use `internal.unexpected` until their call site receives a specific code.

## API errors

HTTP errors expose an optional `code` while endpoints migrate. The client copies it to
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
  readonly truncated?: true
}
```

Messages are safe, bounded summaries owned by Sixb. Native errors, stacks, and causes stay on the
private `error` argument passed to `onError`; they are never copied into storage or API responses.
`truncated` indicates that optional context exceeded the durable failure size budget.

`retryable` is the policy attached to the code. It does not override a worker's safety rules; a
worker may still refuse to replay work that has already produced side effects.

## Contracts by boundary

Each boundary exposes only the codes it can persist.

| Boundary | Allowed codes |
| --- | --- |
| Action run or phase | `action.phase_failed`, `internal.unexpected`, `queue.enqueue_failed`, `runtime.cancelled` |
| Sync run | `internal.unexpected`, `queue.enqueue_failed`, `runtime.cancelled`, `sync.execution_failed` |
| Agent execution | `agent.execution_failed`, `ai.usage_limit_exceeded`, `ai.usage_limit_unavailable`, `internal.unexpected`, `runtime.cancelled` |
| Connector connection run | `connector.adapter_invalid`, `connector.authorization_invalid`, `connector.authorization_required`, `connector.credentials_unavailable`, `connector.not_found`, `connector.operation_conflict`, `connector.operation_in_progress`, `connector.provider_failed`, `connector.provider_unavailable`, `internal.unexpected` |
| Projection run | `internal.unexpected`, `projection.execution_failed`, `queue.enqueue_failed`, `runtime.cancelled` |
| Pipeline run or step | `internal.unexpected`, `pipeline.step_failed`, `queue.enqueue_failed`, `runtime.cancelled` |
| Workflow run or node | `ai.usage_limit_exceeded`, `ai.usage_limit_unavailable`, `internal.unexpected`, `runtime.cancelled`, `workflow.node_failed` |
| Webhook run | `internal.unexpected`, `webhook.delivery_failed`, `webhook.delivery_rejected` |
| Ontology outbox | `event.delivery_failed` |

Additional rules:

- Action failures require `{ actionId, runId, phase }` in `details`.
- Agent, Pipeline, Sync, and Workflow completion events reuse the failure stored on the run.
- `agent.run.finished.error` reuses the failure stored on the Agent run.
- Webhook retryability is carried by the persisted failure: retryable outcomes use
  `webhook.delivery_failed`; terminal handler responses use `webhook.delivery_rejected`.
- The outbox retains `event.delivery_failed` while publication is retried.

## Reporting

- `context.failure` is the same record written to durable storage when one exists.
- `error` remains the native error for stacks and monitoring integrations.
- Failures without durable storage are normalized once at the reporting boundary.

## Normalization

- Coded errors receive their `details` where they are created.
- Native or out-of-contract errors use one typed capture policy at the boundary.

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
| `webhook.delivery_failed` | Yes | A claimed webhook delivery failed retryably. | Let the provider retry; inspect the handler if it persists. |
| `webhook.delivery_rejected` | No | A webhook handler returned a terminal non-success response. | Inspect the handler response and provider payload before sending a new delivery. |
| `workflow.node_failed` | No | A node failed during preparation or execution. | Inspect its identity and the native error reported to `onError`. |
