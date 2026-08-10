# Runtime

The runtime is the single object that wires your whole project together. Reach for this page when
you're bootstrapping a project and need to know what `createSixb()` requires and what the instance
gives you.

`createSixb()` reads your project's conventions, validates everything against the ontology, and
returns one typed `Sixb` instance. That instance is your entry point for objects, telemetry, links,
actions, events, and the scheduler lifecycle.

## Bootstrap

`createSixb()` is **async** — it discovers modules from disk, so always `await` it. Most projects
keep the call in a single config module (`sixb.config.ts`) and export the instance.

```ts
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { SqliteStorage } from "@sixb/sqlite"

export const sixb = await createSixb({
  id: "northline",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
})
```

That single call discovers your ontology and definition folders, validates every definition against
the resolved ontology, and builds the typed object surface plus the events, actions, and security
registries. Misconfiguration fails fast: an unknown link target, a duplicate id, or a rule against a
missing property throws when you `await createSixb()`, not at runtime.

## Required providers

Five providers are required — the runtime wires each registry against them, so none can be omitted.
See [Infrastructure](../infrastructure/overview.md) for the available implementations (in-memory and
local for dev, hosted backends for production).

| Option | Type | Purpose |
| --- | --- | --- |
| `broker` | `Broker` | Domain-event transport (object, telemetry, link, action events) |
| `storage` | `Storage` | Object, link, and telemetry persistence |
| `lakeStorage` | `LakeStorage` | Dataset (table-shaped) storage for syncs and pipelines |
| `blobStorage` | `BlobStorage` | Binary blob storage |
| `queues` | `Queues` | Queued and background work |

Optional: `id` (project id), `auth` (a `SixbAuthConfig`, see
[Authentication](../auth/authentication.md)), `sandboxes` (a `SandboxFactory`), `logger` (a
`LoggerProvider` for process-level log output), `observability` (broker log-capture controls),
`onError` ([runtime failure notifications](error-handling.md)), `ontologyMaintenance` (recovery and
retention intervals), and `projectRoot` (discovery root, defaults to `process.cwd()`). Logging options are covered in
[Logging](../logging/overview.md).

## The Sixb instance

The instance is the API you use everywhere — in workflow steps, syncs, server routes, and tests.

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

For CRUD, querying, telemetry, links, and actions see [Objects](../objects/overview.md). For
cross-type listing (dashboards, search) the instance also exposes a global `sixb.list({ ... })`.

### Events

`sixb.events` is the author-facing read, append, and subscribe facade. Object/link/telemetry facts
are emitted from the durable ontology outbox and cannot be authored or republished through this
surface.

```ts
const recent = await sixb.events.read({
  types: ["object.created", "object.updated"],
  limit: 50,
})
```

Schedules can react to typed domain events and drive syncs, pipelines, or workflows. See
[Events](../events/overview.md) and [Schedules](../schedules/overview.md).

### Logs

`sixb.logs` reads the structured logs your runs produce, captured to a bounded broker stream.

```ts
const page = await sixb.logs.read({ kinds: ["action"], levels: ["error"], limit: 50 })
```

Handlers write these lines through `ctx.logger`, and apps read them through the client `logs`
builder. See [Logging](../logging/overview.md).

### Lifecycle

Constructing the runtime starts no timers. The server owns ontology maintenance automatically;
embedded runtimes without a server acquire it explicitly.

| Method | Effect |
| --- | --- |
| `sixb.schedules.start()` | Start the scheduler for discovered `schedules/` |
| `sixb.schedules.stop()` | Stop the scheduler |
| `sixb.startOntologyMaintenance()` | Start outbox recovery and bounded retention; returns a stop handle |

```ts
await sixb.schedules.start()
const maintenance = await sixb.startOntologyMaintenance()
// ... on shutdown
await sixb.schedules.stop()
await maintenance.stop()
```

`OntologyMaintenance` runs once at startup, then every 60 seconds by default. It drains due
`ontology_outbox` rows, purges old published rows, and cleans only source materializations already
marked `superseded` or `abandoned`. It never age-deletes pending outbox rows, active candidates, or
the durable `ontology_commits` ledger.

Release connector, broker, and logger resources with `sixb.connectors.disconnectAll()`,
`sixb.closeBroker()`, and `sixb.closeLogger()`.

### Scoped views

`sixb.as(context)` derives a principal-scoped SDK from the runtime. The scoped surface is
**default-deny**: an operation runs only when the authorization context's grants cover it. The raw
`sixb` instance stays privileged and is meant for trusted system code (startup, syncs, projections,
workers, tests).

```ts
const scoped = sixb.as(authContext)
const visible = await scoped.objects(Invoice).query().list()
```

See [Authorization](../auth/authorization.md) for grant kinds and context shape.

## Discovery

`createSixb()` auto-discovers exported definitions from well-known folders relative to
`projectRoot`. Any exported definition (or array of definitions) of the matching kind is collected,
so you rarely register anything by hand. A project with no ontology throws — at least one object
type is required.

| Folder | Discovers |
| --- | --- |
| `ontology/` | Object types and value types |
| `actions/` | Action definitions |
| `schedules/` | Scheduler entries |
| `datasets/`, `connectors/`, `syncs/`, `pipelines/`, `projections/` | Data integration |
| `rules/`, `workflows/` | Business logic |
| `agents/` | Agent definitions |
| `security/groups/`, `security/roles/`, `security/policies/` | Authorization |

`app/` is **not** discovered — the app is served separately. See
[Project structure](../fundamentals/project-structure.md) for the full layout.

### Passing definitions explicitly

You can also pass definitions through `createSixb()` options instead of (or alongside) discovery —
handy for tests and for fully programmatic setups. Use the plural `ontologies` option to supply
object types directly. The constructor rejects duplicate ids regardless of source.

```ts
export const sixb = await createSixb({
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
  ontologies: [Customer, Invoice, Project],
  schedules: [dailyInvoices],
  workflows: [checkOverdueInvoices],
})
```

## Related

- [Failed run notifications](error-handling.md) — route terminal run failures to project code
- [Project structure](../fundamentals/project-structure.md) — folder layout and discovery
- [Objects](../objects/overview.md) — the typed `sixb.objects(Type)` surface
- [Events](../events/overview.md) — domain events and `sixb.events`
- [Authorization](../auth/authorization.md) — `sixb.as(context)` and grant kinds
- [Infrastructure](../infrastructure/overview.md) — provider implementations
