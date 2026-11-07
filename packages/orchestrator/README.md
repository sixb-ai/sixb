# @sixb/orchestrator

Routes runtime events to primitive dispatchers, and repairs what that path can lose. The process
also hosts all of a project's upkeep, on one [maintenance loop](#maintenance-loop).

## Delivery contract

Schedule, dataset, sync, pipeline, and workflow routes consume runtime events. Their delivery
guarantee follows the event source and route-specific retry policy.

Each routed primitive uses its Core-owned dispatcher to persist the execution and run before queue
publication. Automatic dispatch leaves a run queued when publication fails or its acknowledgement
is lost. Replaying the same dispatch republishes a queued run using the same job and execution
identities; it does not restart a running or terminal run. Queue providers must honor their stable
job-ID idempotency contract.

A Sync or Pipeline dispatch whose own run does not exist yet joins a run of the same Sync or
Pipeline that is still queued; it queues its own run only when none waits. A queued run reads the
latest inputs when it starts, so it covers the trigger. The joining trigger publishes a job of its
own for that run, `<joined run id>:join:<own run id>`, because the run's own job may be settled and
its id ignored by the provider; once a job has started the run, the others complete without work.
Replaying a joining trigger publishes the same job, but once the joined run has started the replay
finds no run of its own and queues one more. Workflow dispatch never joins: each run carries its
trigger's input.

The Sync and Pipeline workers keep `queued` meaning "a job will start it": a job that fails before
starting its run retries twice (250 ms, then 500 ms) and then fails the run, which has committed
nothing yet.

## Dispatching

The orchestrator returns its processing promise to the broker, and dispatches each job of a batch
on its own (`job-dispatch.ts`):

```text
bounded delivery → one attempt per job, in order → confirm → next delivery
                         failure → job leaves the line → retry beside it → dropped and reported
```

The unread backlog stays in the broker instead of a chain of pending application promises. A job
that fails costs the jobs behind it one attempt, or 30 seconds if the attempt hangs. What happens
next depends on the failure:

| Failure | Examples | Then |
| --- | --- | --- |
| About this event | A mapper that throws or returns no object, a workflow input that fails validation, a run that exists with another payload | Reported and dropped at once. The same event would fail the same way |
| Anything else | PostgreSQL, the queue, the broker, a hung call, `storage.unavailable` | Retries beside the line, from 250 ms doubling to 10 s, for as long as it takes |

The dispatchers decide what counts as the first kind: a framework error that is not retryable, or
their own validation errors. Mapper and selector code is wrapped so that whatever it throws counts
as a failure of the event. Everything else is unclassified, because a driver's error says nothing
about what it means, and an unclassified failure retries: a defect then keeps a job retrying where
an outage would, but it shows, and a dropped trigger would not. After five minutes a retrying job
is reported once as `orchestrator.dispatch.failed` with `dropped: false`.

Up to 64 jobs retry at once per subscription. Beyond that the subscription stops reading, so an
outage leaves the backlog in the broker rather than in memory, until a job gets through. Each event
type has its own subscription, so the types that can still dispatch keep flowing. Already admitted
jobs are safe to replay through their deterministic run/job identities.

| Subscription | While running | After process restart |
| --- | --- | --- |
| `schedule.triggered` | Retry each job | Live tail |
| `dataset.version.committed` to projections | Retry each job | Live tail: the `projections` pass reads the lake |
| Event schedules | Retry each job | Replay retained history |

A stop abandons the retries, and whatever the subscription had not read yet. Event schedules read
it again at the next start, and the `projections` pass covers a commit. Cron does not: a restart
starts at the live tail on purpose. Reading `schedule.triggered` from the start would scan two days
of the stream on every start, and start one run per retained occurrence for any consumer a deploy
adds to an existing schedule, because its run ids are new.

What can still be lost:

| Case | Lost | What repairs it |
| --- | --- | --- |
| A failure about one event | That trigger, reported with `dropped: true` | Nothing: it is a defect to fix. For an event schedule, a restart replays the event and reports it again |
| A stop while a cron job is retrying, or while the subscription is paused on a backlog | Those occurrences | The next occurrence |
| A stop while the broker refuses a cron occurrence | That occurrence | The next one |
| A broker outage that outlasts cron occurrences | All but the one in hand: the `cron` pass retries that one until the broker accepts it, then counts on from then | The next occurrence |
| A cron occurrence that falls while no orchestrator runs | That occurrence | The next one. It was never emitted |
| An outage, or a stop, longer than retention (two days by default) | What retention dropped | Projections and `dataset.updated()` pipelines: their passes. Otherwise nothing |

The cap of 64 is per event type, not per target: one target that always fails with an unclassified
error on a per-minute cron fills the slots in about an hour, and the other cron targets then wait
behind it. It shows as `orchestrator.dispatch.failed` with `dropped: false` long before that.

There is no durable consumer registry, definition signature, cursor table, or new application
configuration.

Lake retention is the one direct job with no durable run behind it. The host adds a built-in
cron schedule, `sixb:lake-retention`, beside the project's own schedules (never into
`definitions.schedules`) when lake maintenance is on. Its `schedule.triggered` events become
`lake.retention.requested` jobs on the `lake` lane, under the occurrence key as job ID, so a replayed
occurrence enqueues nothing more. SyncWorker runs them; the orchestrator never touches the lake,
since one slow catalog write there would stall every route's dispatch.

Projection admission has an event path and a recovery path:

```text
dataset.version.committed --> ProjectionRunDispatcher -> durable execution + run -> queue
lake change feed + startup lookup ---^
stuck-run sweep ---------------------^
```

All of them call the same `ProjectionRunDispatcher`, which derives the same deterministic run ID.
The queue carries only that `runId`; the durable run owns the pinned dataset version and Projection
identity.

The event is a separate write after the lake commit, so it is lost when the process stops between
the two, while no orchestrator runs, or when broker retention overtakes the consumer.
The `projections` pass repairs those losses. Its cost follows what changed, not the length of the
lake's history:

- On start it looks up the latest data-bearing version of every projected dataset. That covers
  commits made while no orchestrator ran and projections the deployment added or revised.
- Every 30 seconds after that, one pass:
  - reads the lake's change feed (`LakeStorage.listLatestVersionsSince`) and dispatches the newest
    data version of each changed dataset. Idle, that is one catalog query, shared with the
    `triggers` pass: both read through one `LakeChangeFeed`;
  - looks up directly each projection whose dispatch failed, until it succeeds;
  - dispatches again the runs `queued` for longer than one pass interval and the runs that failed
    with a retryable `queue.enqueue_failed`, which republishes them. Runs admitted under an
    earlier projection revision are left alone; the start-up lookup admits the current one.

The live event path, not the interval, sets normal projection latency. The interval bounds only
how long a lost event or publication waits for repair.

## Lost dataset triggers

`dataset.version.committed` is written after the commit, so a pipeline on
`events.dataset(x).updated()` can miss it the same ways a projection can. Pipelines admit no run per
version, so the `triggers` pass asks a different question: does
the dataset hold a change the pipeline's last run did not read? `pipeline_step_runs.inputs` holds
what a run read, so the answer needs no record of its own.

| Last run | Then |
| --- | --- |
| Queued or running | Nothing yet. The trigger stays unsettled, because the run may have read before the change |
| Failed | What it read counts as read, so a failure is not retried |
| Cancelled | Does not count: the run before it decides, and with none, it fires. Only a stopping worker cancels a run |
| None | Nothing: a first run stays the user's or the next event's call |

- A change is the newest version that would fire `updated()`. A later version that changed nothing
  does not hide it, so the check reads past such versions.
- A run that has no step on the dataset, because it failed first or because the dataset is no input,
  covers the versions that existed when it started.
- A commit younger than one interval is left to its event.
- A dispatch goes through `PipelineRunDispatcher`, so it joins a run that is still queued.

An idle pass reads the shared feed and looks at no pipeline. The triggers of a dataset that moved
cost one read of its latest version, one read of the latest runs and one of their steps, whatever
the number of pipelines. Every trigger starts unsettled, so a start pays one lookup per triggering
dataset, and the cursor stays in memory.

Syncs and workflows have no such pass. A sync records no input and a workflow's input comes from
the event itself, so neither keeps what the rule needs.

## Maintenance loop

`startOrchestratorRuntime` in the CLI runs one `MaintenanceLoop`, with or without routes: every
project commits events. Its passes never wait for each other, and each has its own budget and its
own failure count. See `packages/core/docs/runtime-lifecycle.md`.

| Pass | When | Does |
| --- | --- | --- |
| `ontology` | 60 s | Delivers outbox rows left undelivered by a crash or a failed publish, dispatches pending vector indexing, and purges expired outbox rows, superseded sources, abandoned uploads and expired grants |
| `cron` | Each occurrence, to the second | Appends `schedule.triggered`, which the direct route consumes like any other event. An occurrence the broker refuses fails the pass and is retried every 10 seconds |
| `projections` | 30 s, with projection routes | See above |
| `triggers` | 30 s, with dataset-triggered pipelines | See above |

Outbox rows are claimed under a lease, so passes in two processes never claim the same row together.
A second orchestrator is otherwise harmless too: both emit each cron occurrence, and `occurrenceKey`
as the idempotency key lets the broker store one, within its window of two minutes by default.
`sixb deploy` runs one.

The loop writes a heartbeat to storage, which is how `/api/status` in another process knows it runs.
Each owner has its own row: the orchestrator's decides whenever one exists, so a server embedded with
`createSixbServer` cannot speak for an orchestrator that died. A project that drops its orchestrator
for an embedded server keeps a stale row, and reads `degraded`, until that row is deleted.

## Usage (co-hosted in `sixb dev`)

When `cohostWorkers` is enabled, `sixb dev` automatically compiles routes from registered syncs,
pipelines, and projections, starts the orchestrator and co-hosts available workers. No manual wiring
is needed.

## Standalone deployment

In production the orchestrator runs as its own process via `sixb orchestrator`, pointed at shared
durable providers. In local development it is co-hosted within `sixb dev` alongside the workers, so
no manual wiring is needed there.

## Limitations (V1)

- The `projections` pass repairs a missed dataset event by admitting the latest data-bearing
  version. It is not an event replay log and does not materialize every intermediate version.
- Publication recovery requires a repeated dispatch. The projection run sweep supplies one;
  event schedules can replay retained events. A run left `queued` by cron has none until the next
  occurrence joins it.
- The change-feed cursor is process memory, so each start pays one latest-version lookup per
  projected dataset before it tails the feed.
- Broker progress is process-local. Retention can still overtake a slow consumer; backpressure
  does not extend retention or guarantee that every event survives an outage.
- Batches are bounded in record count, not a process-wide byte budget. Downstream queue growth
  and the memory used to execute jobs are separate from broker consumption.
- Workflow lifecycle notifications remain best-effort. Reconfirming a queued run does not emit
  another `workflow.run.queued` event; a crash or failed initial publication can leave that
  notification absent even when replay later repairs job delivery.
- **No dynamic routes**: adding syncs, pipelines, or projections after startup requires a restart.
- Event schedules use the registered event selectors (including object, link, rule and Action
  events); this change does not introduce new selector kinds.
