# Deployment

Sixb runs the same project in two shapes. In development one process co-hosts
everything on in-memory providers. In production you split the work into focused
role processes that all load the same config and point at the same durable
providers.

This page is the operator's mental model: dev vs production, the role commands,
and the execution model that moves every async job. What gets scheduled and
dispatched is documented under [schedules](../schedules/overview.md),
[data](../data/overview.md), [rules](../rules/overview.md), and
[workflows](../workflows/overview.md).

## Dev vs production

`sixb dev` boots one process that hosts the API, the [Atlas](#atlas-admin-ui)
admin UI, the custom app (if present), and every background runtime —
orchestrator, scheduler, rules, and all queue workers. It runs in
`NODE_ENV=development` against in-memory providers, so a single process owns all
state:

```ts
// sixb.config.ts — local development
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { SqliteStorage } from "@sixb/sqlite"

export const sixb = await createSixb({
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
})
```

Production splits those responsibilities across separate processes ("roles").
Every role loads the same config, but each starts only part of the runtime.
Because the roles are now separate processes, in-memory providers no longer work
— there is no shared memory between them. Each role must point at **durable,
shared providers**: a real `storage`, `lakeStorage`, `blobStorage`, `broker`, and
a queue provider that can be shared across processes.

```ts
// sixb.config.ts — production
import { S3BlobStorage } from "@sixb/blob-s3"
import { NatsBroker } from "@sixb/broker-nats"
import { createSixb } from "@sixb/core"
import { DuckLakeStorage } from "@sixb/ducklake"
import { PostgresStorage } from "@sixb/pg"
import { BullMqQueues } from "@sixb/queues-bullmq"

export const sixb = await createSixb({
  id: "acme-corp",
  broker: new NatsBroker({ connection: { servers: process.env.NATS_URL } }),
  storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL }),
  lakeStorage: new DuckLakeStorage({ /* ... */ }),
  blobStorage: new S3BlobStorage({ bucket: process.env.BLOB_BUCKET }),
  queues: new BullMqQueues({ connection: process.env.REDIS_URL }),
})
```

`sixb worker` and `sixb worker-group` refuse to start when `queues` is
`InMemoryQueues`:

```txt
[SixbWorker] `sixb worker` requires a queue provider that can be shared across
processes. `InMemoryQueues` is for `sixb dev` only.
```

|            | `sixb dev`              | Production roles                   |
| ---------- | ----------------------- | ---------------------------------- |
| Processes  | one                     | many, one per role                 |
| `NODE_ENV` | `development`           | `production`                       |
| Providers  | in-memory               | durable + shared across processes  |
| Queues     | `InMemoryQueues`        | shared queue provider              |
| Use for    | local iteration, tests  | real workloads, scaling, isolation |

## Role commands

Each role is a `sixb` subcommand that runs in `NODE_ENV=production`. All accept
`--entry <path>` to load a config other than `sixb.config.ts`.

| Command                        | Role                                                  |
| ------------------------------ | ---------------------------------------------------- |
| `sixb api`                     | HTTP/WebSocket API server                            |
| `sixb atlas`                   | Built-in admin UI server                             |
| `sixb app`                     | Custom app server                                    |
| `sixb orchestrator`            | Event-to-queue dispatcher                            |
| `sixb scheduler`               | Schedule producer (emits `schedule.triggered`)       |
| `sixb rules`                   | Evaluates [rules](../rules/overview.md)              |
| `sixb worker <type>`           | Runs one queue worker                                 |
| `sixb worker-group [types...]` | Runs several queue workers in one process            |

The worker `<type>` is one of `sync`, `action`, `pipeline`, `projection`, or
`workflow`:

```bash
sixb worker sync
sixb worker projection
```

`sixb worker-group` runs several in one process. With no types it starts every
worker type that has registered work in the config:

```bash
# explicit
sixb worker-group sync pipeline projection

# auto: every worker type with registered definitions
sixb worker-group
```

A role process is **idle**, not an error, when it has nothing to do — an
orchestrator with no routes, a rules process with no rules, or a worker group
with no registered worker types prints a warning and stays running.

## Execution model

This is the core production data flow. Everything asynchronous in Sixb moves
through it:

```txt
event  ->  orchestrator  ->  queue  ->  worker  ->  event
```

1. Something produces a [domain event](../events/overview.md) — a sync finishes,
   a dataset version is committed, or a schedule triggers.
2. The **orchestrator** subscribes to events, matches each against compiled
   routes, and enqueues a job onto the right queue.
3. A **worker** claims the job, runs it, and writes a run record.
4. The worker emits a finished event, which can drive the next step (for example
   `sync.run.finished` -> a projection job).

The orchestrator subscribes only to the event types its routes need, and fan-out
(one event -> several jobs) is best-effort: a failure enqueuing one job never
drops its siblings.

Two paths skip the orchestrator. Requesting an [action](../actions/overview.md)
enqueues onto `queues.actions` directly (the `action.requested` event is an
observation, not a route) and posting a message to an [agent](../agents/overview.md)
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
survives restarts and is visible in [Atlas](#atlas-admin-ui). A run moves through
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

Because jobs and run records live in durable, shared providers, a crashed worker
loses no work: the unfinished job's lease expires and another worker reclaims it.

## Startup order

Roles start **consumers before producers** and shut down in reverse. This
guarantees that by the time anything emits an event or enqueues a job, the role
that handles it is already listening. The co-hosted dev runtime applies this
automatically; when bringing up separate processes, follow the same order:

1. **Consumers first** — rules, then the action, agent, projection,
   pipeline, workflow, and sync workers.
2. **Producers last** — the orchestrator (subscribes and enqueues), then the
   scheduler (emits triggers).

On shutdown the order reverses: the scheduler stops producing first, the
orchestrator drains pending dispatches, then workers and rules drain
in turn.

## Atlas admin UI

Atlas is the built-in browser admin UI. It serves the UI shell and static assets
and injects the API origin and auth audience at runtime; the browser then
authenticates against the API server. Atlas does **not** serve API routes —
`/api`, `/auth`, `/ws`, and `/docs` belong to the
[API server](../server/overview.md).

In `sixb dev`, Atlas is co-hosted automatically. In production, run it as its own
role pointed at the API origin:

```bash
sixb atlas --api-public-origin https://api.acme.example.com
```

## A minimal production topology

A typical deployment runs each role as a separate process, all loading the same
config against shared durable providers:

```bash
sixb api            # HTTP/WS API
sixb atlas          # admin UI
sixb orchestrator   # event -> queue dispatch
sixb scheduler      # cron schedule triggers
sixb rules          # rule evaluation
sixb worker-group   # all registered queue workers
```

Scale queue-worker roles horizontally: extra `sixb worker` processes share the queue and increase
throughput because each job is claimed by one worker. V0.1.0 runs one API maintenance owner and one
Rules worker per project; Rules reconciliation has no cross-process lease yet.

## Related

- [Runtime](../runtime/overview.md) — how `createSixb()` discovers and wires a project
- [Infrastructure](../infrastructure/overview.md) — provider choices for storage, queues, and the broker
- [Events](../events/overview.md) — the domain events that drive the execution model
- [Schedules](../schedules/overview.md) — cron and event triggers
- [Data](../data/overview.md) — syncs, pipelines, and projections
- [Workflows](../workflows/overview.md) — workflow runs and interventions
