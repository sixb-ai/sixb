# @sixb/sync-worker

Worker that runs Sixb syncs.

`SyncWorker` claims queued sync runs, reads each sync's source into one lake dataset version, and
records the run in `storage.syncRuns`. You normally do not import it: `sixb worker sync` and
`sixb worker-group` construct it for you.

## A run

- `RunWorker` claims the run: a job only says which run to look at. See
  [`packages/core/src/workers/README.md`](../core/src/workers/README.md).
- `runSyncJob` reads the source from the checkpoint of the last succeeded run, staging rows in a lake
  session, and validates them as they pass.
- Just before the commit, it stores what the commit will have read (`prepareCommit`). That write is
  fenced, so an execution that lost its run stops there.
- It commits one version, with the run as `producer`, against the latest version it just read, then
  finishes the run with the new checkpoint and announces the version and the finished run.

A failure before the commit finishes the run as `failed`. A failure at the commit asks the lake
first, because a commit can land and still answer with an error: if the version is there the run
succeeds, and if the lake cannot say the run stays open for the next delivery. Losing that guard to
another writer does not fail the run either: nothing was written, so it reads its source again, up to
its attempts.

One run of a sync runs at a time: a queued run waits for the one running, whose end wakes it, and
triggers join it.

## Recovery

Nothing of a partial run exists until its commit: rows stay in a session no reader sees, and a crash
during the commit leaves at most data files no version refers to, which retention removes. So a run
that resumes has two cases, and one that never prepared a commit has only the second:

- Its commit landed, which `findProducedVersion` finds by `producer.runId`. It finishes with the
  checkpoint and row count it prepared, without reading the source, and announces the version.
- It did not. It reads again from the same checkpoint, and nothing is written twice.

A stopped worker writes nothing: the run stays `running` and the next delivery takes it up.

## Development

```bash
bun --filter @sixb/sync-worker typecheck
bun test packages/sync-worker/tests/run-sync-job.test.ts
bun --filter @sixb/sync-worker build
```
