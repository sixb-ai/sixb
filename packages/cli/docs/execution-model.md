# Execution model

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## Execution model

This is the core production data flow. Everything asynchronous in Sixb moves
through it:

```txt
event  ->  orchestrator  ->  dispatcher  ->  execution + run  ->  queue  ->  worker  ->  event
```

1. Something produces a [domain event](../../../docs/websockets/overview.md#domain-events) — a sync finishes,
   a dataset version is committed, or a schedule triggers.
2. The **orchestrator** subscribes to events, matches each against compiled
   routes, and delegates to the primitive's Core dispatcher.
3. The **dispatcher** atomically persists the immutable execution and queued run, then publishes a queue job containing the run identity.
4. A **worker** claims the job, restores the stored execution, and advances the durable run lifecycle.
5. The worker emits a finished event, which can drive the next step (for example
   `sync.run.finished` -> a projection job).

The orchestrator subscribes only to the event types its routes need, and fan-out
(one event -> several jobs) is best-effort: a failure enqueuing one job never
drops its siblings.

Requesting an [action](../../../docs/actions/overview.md) skips the whole model: the
requesting process creates the run's execution, executes the run, records it once when it
ends, and returns that record. A run emits no event of its own.
A run that commits edits is recorded in the same transaction as its edits. Its effects run
after the record is returned. A process that stops gracefully refuses new action requests and
waits up to 65 seconds for those it runs and their effects; one that crashes leaves no record
of the runs it was executing, with nothing to resume them.

Posting a message to an [agent](../../../docs/models/built-in-agent.md) thread skips the
orchestrator and enqueues onto `queues.agents` directly, while the API can enqueue a
sync, pipeline, or workflow run on demand. These still flow through the queue/worker
half of the model.

### Queues and workers

There is one queue per worker type, and each worker claims from exactly one
queue.

| Worker       | Queue                | Enqueued by                                          |
| ------------ | -------------------- | ---------------------------------------------------- |
| `sync`       | `queues.syncRuns`    | orchestrator (sync triggers), or API run-request     |
| `pipeline`   | `queues.pipelines`   | orchestrator (pipeline triggers), or API run-request |
| `projection` | `queues.projections` | orchestrator, on `dataset.version.committed`         |
| `workflow`   | `queues.workflows`   | orchestrator (scheduled), or API run-request         |
| `agent`      | `queues.agents`      | a posted agent-thread message, enqueued directly     |

Actions have no queue and no worker.

### Run records

Every queued execution writes a durable **run record** to `storage`, so progress
survives restarts and is visible in the app's [Observability](../../../docs/apps/overview.md#observability) pages. A
run moves through the same lifecycle across primitives:

| Status      | Meaning                                         |
| ----------- | ----------------------------------------------- |
| `running`   | claimed by a worker                             |
| `succeeded` | completed and committed                         |
| `failed`    | errored; recorded with the failure name/message |
| `cancelled` | ended by a decision, never by a worker stopping |

An action run has no lifecycle in storage: the request that runs it is its only state while it
executes, and its record is written once, `succeeded` or `failed`, when it ends. Only the outcome
of its effects is recorded later, on that record.

Run records carry the inputs, outputs, timing (`startedAt` / `finishedAt`), and
any error, so a run stays auditable after the fact.

### Durability under failure

Workers claim jobs with a **lease** of one minute, renewed while the job runs, so a worker that
dies gives its job back within about a minute. On each outcome:

- **success** — the job is completed and removed from the queue.
- **execution error** — the run records its failure and the job fails. An error
  that kept the run from recording its outcome retries instead, up to five
  attempts.
- **abort** (shutdown mid-job) — the job goes back to the queue, the run stays
  `running`, and the next delivery resumes it at once.

The orchestrator owns upkeep: immediate post-commit publication still runs in the process that
committed, while its maintenance loop performs durable outbox catch-up and retention every 60
seconds, fires cron schedules, and repairs lost triggers. Queue workers do not poll the outbox, and
no dedicated outbox process is required. Deployments with separate roles must run one orchestrator
per project, or none of that runs. An API embedded with `createSixbServer` runs the outbox catch-up
and retention itself.

Because jobs and run records live in durable, shared providers, a crashed worker
loses no work: the unfinished job's lease expires and another worker claims the run
under a new execution token, so the old one can no longer write to it. What it
picks up depends on the primitive:

| Primitive | After a crash or a shutdown |
| --- | --- |
| Sync | Records a commit that landed, otherwise reads again from the last checkpoint |
| Pipeline | Runs the steps that did not commit; nothing is written twice |
| Projection, workflow | Resumes where its records say it stopped |
| Run of an older version | Left to its old worker for 24 h, then ends `cancelled` |
| Agent turn | Ends as interrupted: running it again would repeat its tools |
| Webhook | Runs again on the provider's next retry, if it failed |

Actions are the exception: with no job to reclaim, an action whose process crashes
mid-run leaves no record, and requesting its `runId` again runs it again.

How this works is in [`packages/core/src/workers/README.md`](../../core/src/workers/README.md).
