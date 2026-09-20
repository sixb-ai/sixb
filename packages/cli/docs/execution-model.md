# Execution model

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## Execution model

This is the core production data flow. Everything asynchronous in Sixb moves
through it:

```txt
event  ->  orchestrator  ->  dispatcher  ->  execution + run  ->  queue  ->  worker  ->  event
```

1. Something produces a [domain event](../../../docs/events/overview.md) — a sync finishes,
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

Two paths skip the orchestrator. Requesting an [action](../../../docs/actions/overview.md)
enqueues onto `queues.actions` directly (the `action.requested` event is an
observation, not a route) and posting a message to an [agent](../../../docs/models/built-in-agent.md)
thread enqueues onto `queues.agents`, while the API can enqueue a sync, pipeline,
or workflow run on demand. All still flow through the queue/worker half of the model.

### Queues and workers

There is one queue per worker type, and each worker claims from exactly one
queue.

| Worker       | Queue                | Enqueued by                                          |
| ------------ | -------------------- | ---------------------------------------------------- |
| `sync`       | `queues.syncRuns`    | orchestrator (sync triggers), or API run-request     |
| `pipeline`   | `queues.pipelines`   | orchestrator (pipeline triggers), or API run-request |
| `projection` | `queues.projections` | orchestrator, on `dataset.version.committed`         |
| `workflow`   | `queues.workflows`   | orchestrator (scheduled), or API run-request         |
| `action`     | `queues.actions`     | a requested action, enqueued directly                |
| `agent`      | `queues.agents`      | a posted agent-thread message, enqueued directly     |

### Run records

Every queued execution writes a durable **run record** to `storage`, so progress
survives restarts and is visible in [Atlas](../../../docs/deployment/overview.md#atlas-admin-ui). A run moves through
the same lifecycle across worker types:

| Status      | Meaning                                            |
| ----------- | -------------------------------------------------- |
| `running`   | claimed and executing                              |
| `succeeded` | completed and committed                            |
| `failed`    | errored; recorded with the failure name/message    |
| `cancelled` | aborted (by shutdown or an explicit request)       |

Run records carry the inputs, outputs, timing (`startedAt` / `finishedAt`), and
any error, so a run stays auditable after the fact.

### Durability under failure

Workers claim jobs with a **lease** (default 15 minutes). On each outcome:

- **success** — the job is completed and removed from the queue.
- **execution error** — the job is failed (the default) or retried with an
  optional delay.
- **abort** (shutdown mid-job) — the job is released by default so another
  process can reclaim it.

The API role owns `OntologyMaintenance`: immediate post-commit publication still runs in the
process that committed, while the API performs durable outbox catch-up and retention every 60
seconds. Queue workers do not poll the outbox, and no dedicated outbox process is required.
Deployments with separate roles must run at least one API role per project, or durable outbox
catch-up and retention never run.

Because jobs and run records live in durable, shared providers, a crashed worker
loses no work: the unfinished job's lease expires and another worker reclaims it.
