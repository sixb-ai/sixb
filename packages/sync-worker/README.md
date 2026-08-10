# @sixb/sync-worker

Queue worker helpers for running Sixb sync jobs.

The sync worker turns one queued sync job into one sync run record and one lake dataset
version. It is intentionally small: queue polling, retries, scheduling, and run-id
generation belong to the caller.

## Responsibilities

- look up the sync definition for a queued job
- create and finalize the sync-run record
- resolve the sync connector client
- normalize rows returned by the sync read handler
- write rows into lake storage and commit the dataset version
- mark pre-commit failures as `failed` or `cancelled`

## Usage

```ts
import { runSyncJob, type SyncWorkerContext } from "@sixb/sync-worker"

const runtime: SyncWorkerContext = {
  id: sixb.id,
  syncRunsStorage,
  lakeStorage,
  blobs: sixb.blobs,
  datasets: sixb.datasets,
  syncs: sixb.syncs,
  connector: sixb.connector,
}

const result = await runSyncJob({
  runtime,
  job: {
    id: "run_123",
    syncId: "sync-orders",
    expectedLatestVersionId: "version_001",
    commitMessage: "sync orders from queue",
  },
  signal,
})
```

`runSyncJob` returns the finalized run id, sync id, dataset id, write mode, timing,
row count, and committed `DatasetVersion`.

## Notes

- `job.id` is the sync-run id supplied by the queue layer.
- `job.expectedLatestVersionId` is forwarded to the lake commit for optimistic
  concurrency checks.
- a failed sync-run finalization after a successful lake commit throws a
  `[SixbSyncWorker]` bookkeeping error so the durable dataset version can be
  repaired or reconciled.
- supported sync read results are a single row object, an iterable, or an async
  iterable.

## Development

```bash
bun --filter @sixb/sync-worker typecheck
bun test packages/sync-worker/tests/run-sync-job.test.ts
bun --filter @sixb/sync-worker build
```
