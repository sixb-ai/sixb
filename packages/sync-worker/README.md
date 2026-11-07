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
  datasets: sixb.definitions.datasets,
  syncs: sixb.definitions.syncs,
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

## Lake lane

`SyncWorker` also hosts a `LakeWorker` on the `lake` queue lane whenever the host schedules lake
retention (`lakeMaintenance` on, a lake provider with `maintenance`, and at least one dataset). It
starts then even when the project has no syncs, and runs beside the sync lane, so a sync never
delays lake work and lake work never takes a sync slot. It claims two jobs at a time.

A `lake.retention.requested` job runs one occurrence of the built-in schedule:

- An occurrence older than one `cleanupEvery` completes without work: a later one covers it, so a
  backlog left by a stopped worker runs once.
- Otherwise it runs retention passes while one reports more, rebuilding the protected versions
  (those projections applied) before each pass, with a 1 s pause between passes. It starts no
  pass after min(½ `cleanupEvery`, 10 min); the next occurrence continues.
- A failure retries through the queue a minute later. The third failure fails the job and is
  reported to `onError` as `lake.retention.failed`; shutdown releases the job instead.

## Development

```bash
bun --filter @sixb/sync-worker typecheck
bun test packages/sync-worker/tests/run-sync-job.test.ts
bun --filter @sixb/sync-worker build
```
