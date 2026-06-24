# Deployment

Sixb runs the same project in two shapes. In development one process co-hosts
everything on in-memory providers. In production you split the work into focused
role processes that all point at the same durable providers.

This page is the mental model and the canonical reference for the run/worker
execution model. The role commands and how a `sixb.config.ts` is wired live here;
the things that get scheduled and dispatched are documented under
[schedules](../schedules/overview.md), [data](../data/overview.md),
[rules](../rules/overview.md), and [workflows](../workflows/overview.md).

## Dev vs production

`sixb dev` boots one process that hosts the API, the [Atlas](#atlas-admin-ui) UI,
the custom app (if present), and every background runtime — orchestrator,
scheduler, functions, rules, and all queue workers. It runs in
`NODE_ENV=development` and is designed to run against in-memory providers
(`InMemoryQueues`, `InMemoryStorage`, etc.) so a single process owns all state.

Production splits those responsibilities across separate processes ("roles").
Every role loads the same `sixb.config.ts`, but each one starts only part of the
runtime. Because the roles are now separate processes, the in-memory providers no
longer work — there is no shared memory between them. Each role must point at
**durable, shared providers** (a real `storage`, `lakeStorage`, `blobStorage`,
`broker`, and a queue provider that can be shared across processes).

`sixb worker` and `sixb worker-group` refuse to start when `queues` is
`InMemoryQueues`:

```txt
[SixbWorker] `sixb worker` requires a queue provider that can be shared across
processes. `InMemoryQueues` is for `sixb dev` only.
```

|              | `sixb dev`                          | Production roles                       |
| ------------ | ----------------------------------- | -------------------------------------- |
| Processes    | one                                 | many, one per role                     |
| `NODE_ENV`   | `development`                       | `production`                           |
| Providers    | in-memory                           | durable + shared across processes      |
| Queues       | `InMemoryQueues`                    | shared queue provider                  |
| Use for      | local iteration, tests              | real workloads, scaling, isolation     |

## Role commands

Each role is a `sixb` subcommand. All of them accept `--entry <path>` to point at
a config other than `sixb.config.ts` and run in `NODE_ENV=production`.

| Command                            | Role                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| `sixb api`                         | HTTP/WebSocket API server (`@sixb/server`)                           |
| `sixb atlas`                       | Built-in admin UI server (`@sixb/atlas`)                             |
| `sixb app`                         | Custom app server (`@sixb/app`)                                      |
| `sixb orchestrator`                | Event-to-queue dispatcher                                            |
| `sixb scheduler`                   | Schedule event producer (emits `schedule.triggered`)                 |
| `sixb functions`                   | Runs registered functions               |
| `sixb rules`                       | Evaluates [rules](../rules/overview.md)                       |
| `sixb worker <type>`               | Runs one queue worker                                                 |
| `sixb worker-group [types...]`     | Runs several queue workers in one process                             |

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

A role process is **idle** rather than an error when it has nothing to do — an
orchestrator with no routes, a rules process with no rules, or a worker group with
no registered worker types prints a warning and stays running.

## Execution model

This is the core production data flow. Everything asynchronous in Sixb moves
through it:

```txt
event  ->  orchestrator  ->  queue  ->  worker  ->  event
```

1. Something produces a [domain event](../events/overview.md) — a sync finishes, a
   dataset version is committed, or a schedule triggers.
2. The **orchestrator** subscribes to events, matches each one against compiled
   routes, and enqueues a job onto the right queue.
3. A **worker** claims the job from the queue, runs it, and writes a run record.
4. The worker emits a finished event, which can drive the next step (e.g.
   `sync.run.finished` -> a projection job).

The orchestrator only subscribes to the event types its routes actually need, and
fan-out (one event -> several jobs) is best-effort: a failure enqueuing one job
never drops its siblings.

Two paths skip the orchestrator. Requesting an [action](../actions/overview.md)
enqueues onto `queues.actions` directly (the `action.requested` event is emitted as
an observation only, not routed), and the API can enqueue a sync, pipeline, or
workflow run on demand. Both still flow through the queue/worker half of the model.

### Queues and workers

There is one queue per worker type. Each worker claims from exactly one queue.

| Worker       | Queue                | Enqueued by                                         |
| ------------ | -------------------- | --------------------------------------------------- |
| `sync`       | `queues.syncRuns`    | orchestrator (sync triggers), or API run-request    |
| `pipeline`   | `queues.pipelines`   | orchestrator (pipeline triggers), or API run-request |
| `projection` | `queues.projections` | orchestrator, on `dataset.version.committed`        |
| `workflow`   | `queues.workflows`   | orchestrator (scheduled), or API run-request        |
| `action`     | `queues.actions`     | a requested action, enqueued directly (not routed)  |

### Run records and statuses

Every queued execution writes a durable **run record** to `storage` so progress
survives restarts and is visible in [Atlas](#atlas-admin-ui). A run moves through
the same status lifecycle across worker types:

| Status      | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `running`   | claimed and executing                            |
| `succeeded` | completed and committed                          |
| `failed`    | errored; recorded with the failure name/message  |
| `cancelled` | aborted (e.g. by shutdown or an explicit request) |

Run records carry the inputs, outputs, timing (`startedAt` / `finishedAt`), and
any error so a run is auditable after the fact.

### Retry and abort durability

Workers claim jobs with a **lease** (default 15 minutes). On the outcome:

- **success** — the job is completed and removed from the queue.
- **execution error** — the worker decides `retry` (with an optional `availableAt`
  delay) or `fail`. The default is `fail`.
- **abort** (shutdown mid-job) — the default is `retry`, so the job is released for
  another process to pick up. Workers with non-idempotent partial commits can
  override this to `fail` instead.

Because jobs and run records live in durable, shared providers, a crashed or
restarted worker does not lose work: an unfinished job's lease expires and another
worker reclaims it.

### Startup order: consumers before producers

Roles in the same process (and the order you should bring up separate processes)
follow a strict rule: **start consumers before producers**, and shut down
producers before consumers. This guarantees that by the time anything emits an
event or enqueues a job, the thing that handles it is already listening.

The co-hosted runtime starts in this order:

```txt
1. rules        (subscribe to ontology events)
2. functions
3. action worker (subscribe to events)
4. projection worker (claim from queue)
5. pipeline worker   (claim from queue)
6. workflow worker   (claim from queue)
7. sync worker       (claim from queue)
8. orchestrator      (subscribe to events, enqueue jobs)
9. scheduler         (emit schedule.triggered)
```

Shutdown runs in reverse: scheduler first (stop producing), then the orchestrator
drains pending dispatches, then workers, then functions, and finally the rules
worker drains pending evaluations.

## Atlas admin UI

Atlas is the built-in browser admin UI (`@sixb/atlas`). It serves the UI shell and
static assets and injects the API origin and auth audience at runtime; the browser
then authenticates against the API server. Atlas does **not** serve API routes —
`/api`, `/auth`, `/ws`, and `/docs` belong to the [API server](../server/overview.md).

In `sixb dev`, Atlas is co-hosted automatically. In production, run it as its own
role pointed at the API origin:

```bash
sixb atlas --api-public-origin https://api.example.com
```

## A minimal production topology

A typical deployment runs each role as a separate process, all loading the same
config against shared durable providers:

```bash
sixb api            # HTTP/WS API
sixb atlas          # admin UI
sixb orchestrator   # event -> queue dispatch
sixb scheduler      # cron/interval triggers
sixb rules          # rule evaluation
sixb functions      # registered functions
sixb worker-group   # all registered queue workers
```

Scale by running more copies of any role — extra `sixb worker` processes share the
queue and increase throughput, since each job is claimed by exactly one worker.

## See also

- [Runtime](../runtime/overview.md) — how `createSixb()` discovers and wires a project
- [Infrastructure](../infrastructure/overview.md) — provider choices for storage, queues, and the broker
- [Events](../events/overview.md) — the domain events that drive the execution model
- [Schedules](../schedules/overview.md) — cron triggers
- [Data](../data/overview.md) — syncs, pipelines, and projections
- [Rules](../rules/overview.md) — rule evaluation
- [Workflows](../workflows/overview.md) — workflow runs
