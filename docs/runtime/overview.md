# Runtime

Sixb has two public runtime surfaces:

- `SixbHost` is the configured project host. It owns providers, registered definitions, and process
  lifecycle.
- `Sixb` is the typed domain API for a request or run. It exposes objects, telemetry, links,
  actions, events, and the other domain primitives with the appropriate permissions.

`createSixb()` reads your project's conventions, validates everything against the ontology, and
returns a `SixbHost`.

## Create the host

Most projects create the host in `sixb.config.ts`. `createSixb()` returns a promise because it
discovers modules from disk; the CLI awaits the exported `sixb` value.

```ts
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { SqliteStorage } from "@sixb/sqlite"

export const sixb = createSixb({
  id: "northline",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
})
```

That single call discovers your ontology and definition folders, validates every definition against
the resolved ontology, and builds the host catalogs and providers. An unknown link target, a duplicate id, or a rule against a missing property fails during project startup.

## Required providers

Five providers are required, so the project cannot start when one is missing.
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

Definition catalogs consistently expose `list()` and `getById(id)`. The execution SDK may add
authorized operations and history below the matching primitive; it does not expose process
lifecycle. Execution code uses `sixb.blobs` and `sixb.connector(definition)`; connector client
resolution remains private to the host.

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
[Events](../events/overview.md) and [Schedules](../schedules/overview.md).

### Logs

`sixb.logs` reads the structured logs produced by your runs.

```ts
const page = await sixb.logs.read({ kinds: ["action"], levels: ["error"], limit: 50 })
```

Handlers write these lines through `ctx.logger`, and apps read them through the client `logs`
builder. See [Logging](../logging/overview.md).

### Lifecycle

Constructing the host starts no timers. The server owns ontology maintenance automatically; embedded hosts without a server acquire it explicitly.

| Method | Effect |
| --- | --- |
| `host.scheduler.start()` | Start the scheduler for discovered `schedules/` |
| `host.scheduler.stop()` | Stop the scheduler |
| `host.startOntologyMaintenance()` | Start outbox recovery and bounded retention; returns a stop handle |

```ts
const host = await createSixb({ /* providers */ })

await host.scheduler.start()
const maintenance = await host.startOntologyMaintenance()
// ... on shutdown
await host.scheduler.stop()
await maintenance.stop()
```

`OntologyMaintenance` recovers pending event publication and applies the configured retention policy. It runs once at startup, then every 60 seconds by default, and never removes pending work.

Release connector, blob, broker, and logger resources with `host.closeConnectors()`,
`host.closeBlobs()`, `host.closeBroker()`, and `host.closeLogger()`.

### Where `Sixb` is available

`Sixb` is provided where general domain access is part of the handler contract. Other handlers use
narrower, purpose-built contexts for their phase. In tests, `createTestSixb(host)` creates an
execution SDK explicitly.

See the documentation for each primitive for its handler context, [Testing](../testing/overview.md) for test setup, and [Authorization](../auth/authorization.md) for the grants enforced by the SDK.

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
export const sixb = createSixb({
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
- [Authorization](../auth/authorization.md) — grants enforced by the domain API
- [Infrastructure](../infrastructure/overview.md) — provider implementations
