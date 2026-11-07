# Runtime lifecycle

For contributors working on Sixb internals. Application setup and usage are documented in the
[public documentation](../../../docs/README.md).

## Host and execution SDK

`SixbHost` configures and runs the project. Workflows and webhooks receive `sixb`, while other
primitives receive a context tailored to their handler. These APIs enforce the permissions of the
current request or run; protected domain operations are not exposed directly by the host.

The two surfaces use distinct namespaces:

| Surface | Responsibility | Example |
| --- | --- | --- |
| `host.definitions` | Validated project definitions, without caller-specific filtering | `host.definitions.workflows.getById(id)` |
| `host.storage`, `host.blobStorage`, … | Configured process providers | `host.blobStorage.stat(blobId)` |
| `host.logging` | Process logging, capture, and lifecycle | `host.logging.startExecution(run)` |
| `host.scheduler`, `host.close*()` | Process lifecycle | `host.scheduler.start()` |
| `sixb` | Execution-bound domain operations and visible definitions | `sixb.workflows.requestById(input)` |

Definition catalogs expose `list()` and `getById(id)`. The model catalog uses `list()` and
`getByRef({ provider, modelId })` because a model binding has a structured identity rather than a
Sixb definition id. The execution SDK may add authorized operations and history below the matching
primitive; it does not expose process lifecycle. Execution code uses `sixb.blobs` and
`sixb.connector(definition)`; connector client resolution remains private to the host.

### Typed objects

`sixb.objects(Type)` returns a fully typed `ObjectSet` for one object type, with compile-time
inference over its properties, links, telemetry, and actions. The primary id goes **inside**
`properties` — there is no separate `key` field.

```ts
import { Invoice } from "./ontology/invoice"

const invoices = sixb.objects(Invoice)

await invoices.upsert({
  properties: {
    id: "inv-1001",
    number: "2026-0042",
    amount: 4800,
    currency: "EUR",
    status: "sent",
  },
})

const invoice = await invoices.byId("inv-1001").get()
```

For CRUD, querying, telemetry, links, and actions see [Objects](../../../docs/objects/overview.md). For
cross-type listing (dashboards, search), use `sixb.objects.list({ ... })`.

### Events

`sixb.events` is the domain API for reading, appending, and subscribing to events. Events produced
by object, link, and telemetry changes are read-only through this surface.

```ts
const recent = await sixb.events.read({
  types: ["object.created", "object.updated"],
  limit: 50,
})
```

Schedules can react to typed domain events and drive syncs, pipelines, or workflows. See
[Events](../../../docs/websockets/overview.md#domain-events) and [Schedules](../../../docs/schedules/overview.md).

### Logs

`sixb.logs` reads the structured logs produced by your runs.

```ts
const page = await sixb.logs.read({ kinds: ["action"], levels: ["error"], limit: 50 })
```

Handlers write these lines through `ctx.logger`, and apps read them through the client `logs`
builder. See [Logging](../../../docs/logging/overview.md).

### Lifecycle

Constructing the host starts no timers. All of a project's upkeep runs as passes on one `MaintenanceLoop`, and `sixb orchestrator` hosts that loop. A host embedded without an orchestrator starts what it needs on its own; `createSixbServer` does so for ontology maintenance unless told not to.

| Method | Effect |
| --- | --- |
| `host.startMaintenance(passes)` | Run ontology maintenance, cron and `passes` on one loop that beats to storage; returns a stop handle. The orchestrator calls it |
| `host.scheduler.start()` | Run cron alone on a loop of its own. Beside an orchestrator, every occurrence fires twice |
| `host.scheduler.stop()` | Stop it |
| `host.startOntologyMaintenance()` | Run outbox recovery and bounded retention alone on a loop of its own; returns a stop handle |
| `host.getOntologyOperationalStatus()` | Read the last heartbeat and the outbox from storage. Works in a process that runs no pass |

```ts
const host = await createSixb({ /* providers */ })

await host.scheduler.start()
const maintenance = await host.startOntologyMaintenance()
// ... on shutdown
await host.scheduler.stop()
await maintenance.stop()
```

`OntologyMaintenance` recovers pending event publication and applies the configured retention policy. It runs once at startup, then every 60 seconds by default, and never removes pending work.

#### The maintenance loop

One timer wakes for whatever comes next: a pass that is due, a run's budget, or a beat. A pass is an id, a budget, a due time and a run:

```ts
const pass = everyMs({
  id: "ingest",
  intervalMs: 30_000,
  budgetMs: 60_000,
  run: (signal) => reconcile(signal),
})
```

`everyMs` covers an interval. A pass with a due time of its own, like `cron`, implements `MaintenancePass` and answers `nextRunAt(now, lastFinishedAt)`. To add one to the orchestrator, return it from `createReconciliationPasses` in `@sixb/orchestrator`.

- **Passes never wait for each other.** Each has at most one run in flight, and a run that hangs costs the others nothing.
- **A run has a budget.** Past it the run's signal aborts and the run counts as a failure, then as one more per further budget. It keeps its slot until it ends: starting another beside it would break "one run at a time". A run that stops on the abort should throw, or return having done nothing it needs recorded.
- **A failure is the pass's own.** Throw from `run`. The loop counts it, reports it as `maintenance.pass.failed` and runs the pass again when it is next due. A pass that wants to do all it can collects its failures and throws an `AggregateError` at the end.
- **Nothing durable but the heartbeat.** The loop rewrites one row per project: when it beat, how often it promises to, and each pass's last success and consecutive failures. Whatever a pass remembers, such as a change-feed cursor, stays in memory, and its first run after a restart rebuilds it.

`/api/status` turns the row into `ok`, `degraded` (the beat is older than two intervals, or a pass failed twice in a row, or the outbox is stuck) or `unknown` (no loop ever beat).

Release connector, blob, broker, and logger resources with `host.closeConnectors()`,
`host.closeBlobs()`, `host.closeBroker()`, and `host.closeLogger()`.

### Where `Sixb` is available

`Sixb` is provided where general domain access is part of the handler contract. Other handlers use
narrower, purpose-built contexts for their phase. In tests, `createTestSixb(host)` creates an
execution SDK explicitly.

See the documentation for each primitive for its handler context, [Testing](../../../docs/testing/overview.md) for test setup, and [Authorization](../../../docs/auth/authorization.md) for the grants enforced by the SDK.
