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
| Sync run | `internal.unexpected`, `runtime.cancelled`, `sync.execution_failed` |
| Agent execution | `agent.execution_failed`, `internal.unexpected`, `runtime.cancelled` |
| Projection run | `internal.unexpected`, `projection.execution_failed`, `runtime.cancelled` |
| Pipeline run or step | `internal.unexpected`, `runtime.cancelled`, `pipeline.step_failed` |
| Workflow run or node | `internal.unexpected`, `runtime.cancelled`, `workflow.node_failed` |
| Webhook run | `internal.unexpected`, `webhook.delivery_failed` |
| Ontology outbox | `event.delivery_failed` |

Additional rules:

- Action failures require `{ actionId, runId, phase }` in `details`.
- Agent, Pipeline, Sync, and Workflow completion events reuse the failure stored on the run.
- `agent.run.finished.error` reuses the failure stored on the Agent run.
- Webhook non-retryable outcomes remain HTTP outcomes; only retryable post-claim failures use
  `webhook.delivery_failed`.
- The outbox retains `event.delivery_failed` while publication is retried.

## Reporting

- `context.failure` is the same record written to durable storage when one exists.
- `error` remains the native error for stacks and monitoring integrations.
- Failures without durable storage are normalized once at the reporting boundary.

## Normalization

- Coded errors receive their `details` where they are created.
- Fallback details are reserved for native, infrastructure, and cancellation errors at a boundary.

## Error catalog

| Code | Retryable | What happened | What to do |
| --- | --- | --- | --- |
| `action.phase_failed` | No | An Action phase could not complete successfully. | Inspect `phase` and the `onError` report; retry only when its side-effect boundary makes that safe. |
| `agent.execution_failed` | No | An active Agent execution failed. | Inspect the run identity and `onError` report before requesting another run. |
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
| `queue.enqueue_failed` | Yes | A job could not be handed to its queue. | Retry while the run remains in its enqueue phase. |
| `runtime.cancelled` | No | Work was cancelled before completion. | Confirm the cancellation before requesting another run. |
| `sync.execution_failed` | No | A Sync failed while reading, validating, or writing its dataset. | Inspect the `onError` report, fix the source or data, then request a new run. |
| `webhook.delivery_failed` | Yes | A claimed webhook delivery failed retryably. | Let the provider retry; inspect the handler if it persists. |
| `workflow.node_failed` | No | A node failed during preparation or execution. | Inspect its identity and `onError` report. |
