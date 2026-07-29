# @sixb/projection-worker

Queue worker for materializing committed dataset versions into the Sixb ontology.

One deterministic `projection.run.requested` job pins the dataset version and complete projection
identity. The worker validates that identity, then routes replacement or telemetry input through the
internal ontology mutation runtime.

## Responsibilities

- replay an existing terminal run before reading registry or lake state
- validate the pinned projection and dataset-version identity
- claim and fence projection execution through the projection-run record
- read the exact committed dataset version from lake storage
- stage and atomically activate object/link replacement snapshots through the Materializer
- append telemetry in resumable fixed physical batches
- leave transient failures running for queue redelivery; terminalize only confirmed outcomes

## Usage

`sixb dev` starts this worker automatically when projections are registered in the loaded runtime.

For custom hosts or focused tests, start it explicitly:

```ts
import { ProjectionWorker } from "@sixb/projection-worker"

const worker = new ProjectionWorker(sixb)
await worker.start()
```

## Notes

- Object/link projections are authoritative replacement snapshots: missing source assertions are
  withdrawn when the candidate activates.
- Replacement staging remains invisible until one atomic activation commit succeeds.
- Telemetry resumes from its durable physical row offset and batch ordinal; terminal success
  requires a separately persisted EOF observation.
- `QueueDelivery` owns liveness; the opaque execution token fences every durable write.
- Retryable failures use capped exponential backoff and remain retryable without an attempt limit.
- Semantic outcomes live in `ontology_commits`; run records contain lifecycle and physical progress.

## Development

```bash
bun --filter @sixb/projection-worker typecheck
bun test packages/projection-worker/tests/run-projection-job.test.ts
bun test packages/projection-worker/tests/worker.test.ts
bun --filter @sixb/projection-worker build
```
