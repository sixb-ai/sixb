# @sixb/lake-worker

Queue worker for lake upkeep that must not run in the process that asks for it. It consumes the
`lake` queue, so lake work never takes a slot from the syncs and pipelines that write the lake, and
the orchestrator never touches the catalog.

You normally do not import it. `sixb worker lake` and `sixb worker-group` construct it for you, and
`sixb dev` starts it when lake retention runs on its own.

## What it runs

`lake.retention.requested`: the retention of replaced dataset versions and the files only they
read. The orchestrator's `lake-retention` pass requests it once per `cleanupEvery` interval. The job
id names the interval, so a restart or a second orchestrator requests nothing more while the queue
remembers the job.

One run:

- Does nothing when its interval is over: the next request covers it, so a backlog left by a stopped
  worker runs once.
- Runs passes while one reports more to do, reading the versions projections applied before each
  pass. It starts no pass after min(½ `cleanupEvery`, 10 minutes); the next run continues.
- Records how it ended in `storage.lakeRetentionRuns`, the only proof that a worker consumes the
  requests: Console › Lake health reads it from the API.
- Is not retried when it fails. It reports `lake.retention.failed` to `onError` once, and the next
  interval's request tries again.
- Returns to the queue on shutdown, without a failure.

## Usage

For custom hosts or focused tests, start it explicitly:

```ts
import { LakeWorker } from "@sixb/lake-worker"

const worker = new LakeWorker(sixb)
await worker.start()
```

It refuses to start when retention does not run on its own: `lakeMaintenance.enabled` is false, the
lake storage provider has no maintenance, or the project has no datasets.

Two jobs run at once by default, so lake work behind a long retention run does not wait for it. Set
`--concurrency` on `sixb worker lake`, or `SIXB_LAKE_WORKER_CONCURRENCY`.

## Verification

```bash
bun --filter @sixb/lake-worker typecheck
bun test packages/lake-worker/tests/worker.test.ts
bun --filter @sixb/lake-worker build
```
