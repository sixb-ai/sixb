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
  readonly causeChain?: readonly { readonly name: string; readonly message: string }[]
}
```

Each primitive specializes `TCode` to the codes it can actually persist and expose. Sync runs, pipeline runs, pipeline step runs, workflow runs, workflow node runs, agent executions (conversation or workflow-owned), and projection runs currently declare `internal.unexpected | runtime.cancelled`.

Other run primitives keep their legacy error shape until their own vertical migration. This keeps
each storage and wire change independently reviewable.

| Code | Retryable | What happened | What to do |
| --- | --- | --- | --- |
| `dataset.not_found` | No | The requested dataset is not registered or is not visible to the caller. | Check the dataset ID and the caller's access. |
| `dataset.version_not_found` | No | The requested dataset version does not exist, or the dataset has no committed version yet. | Check the version ID or materialize the dataset before reading rows. |
| `internal.unexpected` | No | Sixb caught an exception that has not yet been assigned a more specific code. | Inspect the failure and its cause chain. Do not retry automatically. |
| `runtime.cancelled` | No | An in-flight operation was cancelled before completion. | Confirm the cancellation was intentional before requesting another run. |
