# Runtime error codes

Sixb failures carry a stable `code` for programmatic decisions and a message for humans. Code can
branch on `failure.code`; it must never parse `failure.message`.

HTTP error responses expose the same identity as an optional `code` while endpoints migrate. The Sixb client copies it to `SixbApiError.code`; clients should handle unknown strings so an older client remains compatible with codes introduced by a newer server.

```ts
if (isSixbApiError(error) && error.code === "dataset.not_found") {
  // Recover without depending on the human-readable message.
}
```

The catalog starts deliberately small and grows with each primitive's vertical migration. Unknown
legacy exceptions use `internal.unexpected` until their call site receives a specific code.

## Failure records

Persisted run failures use the same portable record returned by their API:

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

Each primitive specializes `TCode` to the codes it can persist. Most migrated runs currently allow
`internal.unexpected | runtime.cancelled`. Action failures also allow the retryable
`queue.enqueue_failed` code and require `{ actionId, runId, phase }` in `details`.
Webhook runs allow `internal.unexpected | webhook.delivery_failed`; only retryable post-claim
failures use the delivery code. The idempotency journal and run reuse the same failure record.
Expected non-retryable outcomes remain represented by their HTTP status and claim result.
Workflow completion events reuse the exact failure stored on the run or node.
Pipeline step completion events reuse the exact failure stored on the step run.
The ontology outbox declares `event.delivery_failed`; its durable record is retained while publication
is retried.

Each storage and wire change remains independently reviewable even though every migrated primitive shares the same portable base record.

| Code | Retryable | What happened | What to do |
| --- | --- | --- | --- |
| `dataset.not_found` | No | The requested dataset is not registered or is not visible to the caller. | Check the dataset ID and the caller's access. |
| `dataset.version_incompatible` | No | The immutable dataset version does not match the dataset or schema required by the operation. | Materialize a compatible version and dispatch a new run. |
| `dataset.version_not_found` | No | The requested dataset version does not exist, or the dataset has no committed version yet. | Check the version ID or materialize the dataset before reading rows. |
| `dataset.version_read_inconsistent` | Yes | Read results conflict with immutable version metadata. | Retry, then inspect lake storage integrity. |
| `event.delivery_failed` | Yes | A persisted ontology event could not be published. | Let the outbox retry, then inspect the broker. |
| `internal.unexpected` | No | Sixb caught an exception that has not yet been assigned a more specific code. | Inspect internal logs. Do not retry automatically. |
| `queue.enqueue_failed` | Yes | A job could not be handed to its queue. | Retry the unchanged request while the durable run remains in its enqueue phase. |
| `projection.definition_invalid` | No | A projection definition is incompatible with its ontology or dataset mapping. | Fix the projection definition and dispatch a new run. |
| `projection.not_found` | No | The requested projection is not registered in the current runtime. | Check the projection ID and ensure its definition is deployed. |
| `projection.run_already_terminal` | No | A delivery targeted a projection run that had already failed or been cancelled. | Do not reuse the terminal run ID; dispatch a new semantic run if needed. |
| `projection.run_identity_mismatch` | No | A projection run or delivery does not match its pinned semantic identity. | Discard the stale delivery and dispatch from the current projection definition. |
| `runtime.cancelled` | No | An in-flight operation was cancelled before completion. | Confirm the cancellation was intentional before requesting another run. |
| `webhook.delivery_failed` | Yes | A webhook handler failed with a retryable outcome. | Let the provider retry, then inspect the handler. |
