# @sixb/lake-worker

Queue worker for lake upkeep that must not run in the process that asks for it. It consumes the
`lake` queue, so lake work never takes a slot from the syncs and pipelines that write the lake, and
the orchestrator never touches the catalog.

You normally do not import it. `sixb worker lake` and `sixb worker-group` construct it for you, and
`sixb dev` starts it when lake retention runs on its own or a dataset can be ingested.

## What it runs

`lake.retention.requested`: the retention of replaced dataset versions and the files only they
read. The orchestrator's `lake-retention` pass requests it once per `cleanupEvery` interval. The job
id names the interval, so a restart or a second orchestrator requests nothing more while the queue
remembers the job.

One run:

- Does nothing when its interval is over: the next request covers it, so a backlog left by a stopped
  worker runs once. It also does nothing when retention was turned off since.
- Runs passes while one reports more to do, reading the versions projections applied before each
  pass. It starts no pass after min(½ `cleanupEvery`, 10 minutes); the next run continues.
- Records when it starts and ends in `storage.lakeRetentionRuns`, the only proof that a worker
  consumes the requests: Console › Lake health reads it from the API.
- Is not retried when it fails. It reports `lake.retention.failed` to `onError` once, and the next
  interval's request tries again.
- Returns to the queue on shutdown, without a failure. Shutdown stops a pass that is waiting; one
  that is deleting finishes first.
- Never waits for long on the reads of its own process. DuckLake's file deletion gives reads about
  half a minute to end, then leaves the files to the next pass with `hasMore`.

`dataset.ingest.flush.requested`: writes one dataset's ingested changes through
`getDatasetIngestRuntime(host).flush` (see `packages/core/src/datasets/ingest-flush.ts`).

- Its id names the flush request (`ingest-flush:<dataset>:<request>`), so the deliveries of one
  request queue one job.
- When another flush holds the dataset, the job tries again a second later, until that flush
  releases it.
- A failure retries after 1, 2, 5, 15 and 30 s, then every minute, and the job never fails: the
  changes stay in the inbox, and the next attempt resumes the batch in flight. The flush reports
  the fifth failure in a row as `dataset.ingest.flush.failed`.

## Usage

For custom hosts or focused tests, start it explicitly:

```ts
import { LakeWorker } from "@sixb/lake-worker"

const worker = new LakeWorker(sixb)
await worker.start()
```

When retention does not run on its own and no dataset can be ingested, nothing requests any work
and the worker idles, so a deployment can always list it.

Four jobs run at once by default, so the flushes of several datasets run together and beside a long
retention run, of which there is one at a time. Set `--concurrency` on `sixb worker lake`, or
`SIXB_LAKE_WORKER_CONCURRENCY`.

## Verification

```bash
bun --filter @sixb/lake-worker typecheck
bun test packages/lake-worker/tests/worker.test.ts
bun --filter @sixb/lake-worker build
```
