# @sixb/orchestrator

Routes runtime events to primitive dispatchers and recovers missed Projection admissions from lake
state.

## Delivery contract

Schedule, dataset, sync, pipeline, and workflow routes consume runtime events. Their delivery
guarantee follows the event source and route-specific retry policy.

Each routed primitive uses its Core-owned dispatcher to persist the execution and run before queue
publication. Automatic dispatch leaves a run queued when publication fails or its acknowledgement
is lost. Replaying the same dispatch republishes a queued run using the same job and execution
identities; it does not restart a running or terminal run. Queue providers must honor their stable
job-ID idempotency contract.

The orchestrator returns its processing promise to the broker:

```text
bounded delivery → dispatch the current batch → confirm → next delivery
                         failure → backoff → retry the same batch
```

The unread backlog stays in the broker instead of a chain of pending application promises.
Direct fan-out attempts all siblings before retrying failures. Already admitted siblings are safe
to replay through their deterministic run/job identities. Retry stops when the worker is stopped;
shutdown drains the dispatch already in flight. A hung dispatcher still needs its own I/O timeout.

| Subscription | While running | After process restart |
| --- | --- | --- |
| Direct jobs (cron, projection notifications) | Retry current batch | Live-only, as before |
| Event schedules | Retry current batch without replaying the whole log | Replay retained history, as before |

There is no durable consumer registry, definition signature, cursor table, or new application
configuration. Permanent errors are logged and remain on retry; this slice adds no quarantine or
automatic skip policy. A persistent error can block other routes sharing that subscription.

Projection admission has an event path and a reconciliation path:

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
Reconciliation repairs those losses. Its cost follows what changed, not the length of the lake's
history:

- On start it looks up the latest data-bearing version of every projected dataset. That covers
  commits made while no orchestrator ran and projections the deployment added or revised.
- Every 30 seconds after that, one pass:
  - reads the lake's change feed (`LakeStorage.listLatestVersionsSince`) from an in-memory cursor
    and dispatches the newest data version of each changed dataset. Idle, that is one catalog
    query;
  - looks up directly each projection whose dispatch failed, until it succeeds;
  - dispatches again the runs `queued` for longer than one pass interval and the runs that failed
    with a retryable `queue.enqueue_failed`, which republishes them. Runs admitted under an
    earlier projection revision are left alone; the start-up lookup admits the current one.

The live event path, not the interval, sets normal projection latency. The interval bounds only
how long a lost event or publication waits for repair.

## Usage (co-hosted in `sixb dev`)

When `cohostWorkers` is enabled, `sixb dev` automatically compiles routes from registered syncs,
pipelines, and projections, starts the orchestrator, co-hosts available workers, and starts the
scheduler. No manual wiring is needed.

## Standalone deployment

In production the orchestrator runs as its own process via `sixb orchestrator` (the event-to-queue
dispatcher role) pointed at shared durable providers. In local development it is co-hosted within
`sixb dev` alongside the scheduler and workers, so no manual wiring is needed there.

## Limitations (V1)

- Projection reconciliation repairs a missed dataset event by admitting the latest data-bearing
  version. It is not an event replay log and does not materialize every intermediate version.
- Publication recovery requires a repeated dispatch. The projection run sweep supplies one;
  event schedules can replay retained events. Direct cron dispatch has no restart catch-up.
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
