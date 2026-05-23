# @sixb/projection-worker

Queue worker helpers for materializing committed dataset versions into Sixb objects and links.

The projection worker turns one queued `projection.run.requested` job into one projection run
record and latest-state object/link writes through the core object service.

## Responsibilities

- look up the projection definition for a queued job
- create, update, and finalize the projection-run record
- read the exact committed dataset version from lake storage
- validate the committed version against the registered dataset definition
- upsert projected objects and links through `objectService`
- mark failed or cancelled runs in `ProjectionRunStorage`

## Usage

`sixb dev` starts this worker automatically when projections are registered in the loaded runtime.

For custom hosts or focused tests, start it explicitly:

```ts
import { ProjectionWorker } from "@sixb/projection-worker"

const worker = new ProjectionWorker(sixb)
await worker.start()
```

For lower-level tests, use the function form:

```ts
import { runProjectionJob } from "@sixb/projection-worker"

await runProjectionJob({
  runtime,
  job: {
    id: "run_123",
    projectionId: "room-proj",
    projectionKind: "object",
    datasetId: "canonical.rooms",
    versionId: "ver_123",
  },
})
```

## Notes

- The worker executes the projection named by the job. It does not resolve projection dependencies.
- V1 materialization is set-only: projected rows upsert state, missing rows do not delete state.
- V1 traceability lives in dataset versions and projection run records; object writes do not carry
  projection-specific metadata.

## Development

```bash
bun --filter @sixb/projection-worker typecheck
bun test packages/projection-worker/tests/run-projection-job.test.ts
bun test packages/projection-worker/tests/worker.test.ts
bun --filter @sixb/projection-worker build
```
