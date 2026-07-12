# Runtime

The runtime is the single object that wires your whole project together. Reach for this page when
you're bootstrapping a project and need to know what `createSixb()` requires and what the instance
gives you.

`createSixb()` reads your project's conventions, validates everything against the ontology, and
returns one typed `Sixb` instance. That instance is your entry point for objects, telemetry, links,
actions, events, and the lifecycle of background functions and schedules.

## Bootstrap

`createSixb()` is **async** — it discovers modules from disk, so always `await` it. Most projects
keep the call in a single config module (`sixb.config.ts`) and export the instance.

```ts
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
`LoggerProvider` for process-level log output) and `observability` (broker log-capture controls) —
both covered in [Logging](../logging/overview.md) — and `projectRoot` (discovery root, defaults to
`process.cwd()`).

## The Sixb instance

The instance is the API you use everywhere — in functions, syncs, server routes, and tests.

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

`sixb.events` is the read/append surface for domain events — `object.upserted`,
`telemetry.appended`, `link.upserted`, `link.removed`, and `action.requested`. It is how the runtime
records and replays change.

```ts
const recent = await sixb.events.read({
  types: ["object.upserted"],
  limit: 50,
})
```

Domain events do **not** trigger functions — functions run on `cron`/`interval` schedules. See
[Events](../events/overview.md).

### Logs

`sixb.logs` reads the structured logs your runs produce, captured to a bounded broker stream.

```ts
const page = await sixb.logs.read({ kinds: ["action"], levels: ["error"], limit: 50 })
```

Handlers write these lines through `ctx.logger`, and apps read them through the client `logs`
builder. See [Logging](../logging/overview.md).

### Lifecycle

Background functions and the scheduler are started explicitly — constructing the runtime does not
start them. Each pair is idempotent and a no-op when there is nothing to run.

| Method | Effect |
| --- | --- |
| `sixb.startFunctions()` | Start the functions runtime (interval/cron triggers) |
| `sixb.stopFunctions()` | Stop the functions runtime |
| `sixb.startScheduler()` | Start the scheduler for discovered `schedules/` |
| `sixb.stopScheduler()` | Stop the scheduler |

```ts
await sixb.startFunctions()
await sixb.startScheduler()
// ... on shutdown
await sixb.stopScheduler()
await sixb.stopFunctions()
```

Release connector, broker, and logger resources with `sixb.disconnectConnectors()`,
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
| `functions/` | Scheduled functions |
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
  functions: [checkOverdueInvoices],
})
```

## Related

- [Project structure](../fundamentals/project-structure.md) — folder layout and discovery
- [Objects](../objects/overview.md) — the typed `sixb.objects(Type)` surface
- [Events](../events/overview.md) — domain events and `sixb.events`
- [Authorization](../auth/authorization.md) — `sixb.as(context)` and grant kinds
- [Infrastructure](../infrastructure/overview.md) — provider implementations
