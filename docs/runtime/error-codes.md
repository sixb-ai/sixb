# Runtime error codes

Sixb failures carry a stable `code` for programmatic decisions and a message for humans. Code can
branch on `failure.code`; it must never parse `failure.message`.

The catalog starts deliberately small and grows with each primitive's vertical migration. Unknown
legacy exceptions use `internal.unexpected` until their call site receives a specific code.

| Code | Retryable | What happened | What to do |
| --- | --- | --- | --- |
| `internal.unexpected` | No | Sixb caught an exception that has not yet been assigned a more specific code. | Inspect the failure and its cause chain. Do not retry automatically. |
