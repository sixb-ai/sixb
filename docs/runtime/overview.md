# Runtime

The runtime is the single object that wires your whole project together.

`createSixb()` reads your project's conventions, validates everything against the ontology, and
returns one `Sixb` instance. That instance is the typed entry point for objects, telemetry,
links, actions, events, and the lifecycle of background functions and schedules.

## Mental model

A Sixb runtime has three layers:

| Layer | What it is |
| --- | --- |
| Providers | The infrastructure you pass in (broker, storage, lake, blob, queues) |
| Definitions | Your ontology, actions, datasets, functions, syncs, etc. — discovered or passed explicitly |
| Surface | The methods you call: `sixb.objects(Type)`, `sixb.events`, lifecycle start/stop, `sixb.as(...)` |

You construct the runtime once and reuse it. Definitions are validated at construction time, so
a misconfigured reference (an unknown dataset, a duplicate id, a rule against a missing property)
fails fast when you call `createSixb()`.

## Bootstrap

`createSixb()` is **async** — it discovers modules from disk, so always `await` it. Most projects
keep the call in a single config module and export the instance.

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

That single call:

- discovers your ontology and definition folders relative to `projectRoot` (defaults to `process.cwd()`)
- validates every definition against the resolved ontology
- builds the typed object surface and the events, actions, and security registries

## Required providers

These five providers are required. The runtime constructor wires each registry against them, so
they cannot be omitted. See [Infrastructure](../infrastructure/overview.md) for the available
implementations.

| Option | Type | Purpose |
| --- | --- | --- |
| `broker` | `Broker` | Domain-event transport (object, telemetry, link, and action events) |
| `storage` | `Storage` | Object, link, and telemetry persistence |
| `lakeStorage` | `LakeStorage` | Dataset (table-shaped) storage for syncs and pipelines |
| `blobStorage` | `BlobStorage` | Binary blob storage |
| `queues` | `Queues` | Queued/background work |

Optional providers include `sandboxes` (a `SandboxFactory`) and `auth` (a `SixbAuthConfig`, see
[Authentication](../auth/authentication.md)).

## The Sixb instance

The instance is the API you use everywhere — in functions, syncs, server routes, and tests.

### Typed objects

`sixb.objects(Type)` returns a fully typed `ObjectSet` for one object type, with compile-time
inference over its properties, links, telemetry, and actions.

```ts
import { Device } from "./ontology/device"

const devices = sixb.objects(Device)

await devices.upsert({ id: "dev-1", name: "Lobby TV" })
const device = await devices.byId("dev-1").get()
```

For CRUD and querying details see [Objects](../objects/overview.md). For cross-type listing the
instance also exposes a global `sixb.list({ ... })`.

### Events

`sixb.events` is the read/append surface for domain events (`object.upserted`,
`telemetry.appended`, `link.upserted`, `link.removed`, `action.requested`). It is how the runtime
reacts to change. See [Events](../events/overview.md).

### Lifecycle

Background functions and the scheduler are started explicitly — constructing the runtime does not
start them. Each pair is idempotent and a no-op when there is nothing to run.

| Method | Effect |
| --- | --- |
| `sixb.startFunctions()` | Start the functions runtime (event/interval/cron triggers) |
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

Connector and broker resources are released with `sixb.disconnectConnectors()` and
`sixb.closeBroker()`.

### Scoped views

`sixb.as(context)` derives a principal-scoped SDK from the runtime. The scoped surface is
**default-deny**: an operation runs only when the authorization context's grants cover it. The raw
`sixb` instance stays privileged and is meant for trusted system code (startup, syncs,
projections, workers, tests). See [Authorization](../auth/authorization.md).

```ts
const scoped = sixb.as(authContext)
const visible = await scoped.objects(Device).query().list()
```

## Convention discovery

`createSixb()` auto-discovers exported definitions from well-known folders relative to
`projectRoot`: `ontology/`, `actions/`, `datasets/`, `functions/`, `syncs/`, `schedules/`,
`pipelines/`, `projections/`, `connectors/`, `rules/`, `workflows/`, and the `security/`
subfolders `security/groups/`, `security/roles/`, and `security/invite-policies/`. Any exported
definition (or array of definitions) of the matching kind is collected, so you rarely pass
definitions by hand. An empty project with no ontology throws — at least one object type is
required. See [Project structure](../fundamentals/project-structure.md) for the full folder layout.

## Explicit options: merge vs replace

You can also pass definitions directly. Whether an explicit array **merges** with or **replaces**
discovery depends on the option:

| Behavior | Options |
| --- | --- |
| **Replace** discovery when provided | `ontologies`, `actions`, `functions`, `projections` |
| **Merge** with discovery (explicit first) | `datasets`, `connectors`, `schedules`, `syncs`, `pipelines`, `rules`, `workflows`, `groups`, `roles`, `invitePolicies` |

Replace-style options are special: `ontologies` are concatenated with discovered sources, while
`actions`, `functions`, and `projections` skip discovery entirely when you pass them. For merged
options the explicit entries come first, and the constructor still rejects duplicate ids in either
case.

```ts
export const sixb = await createSixb({
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
  // skips functions/ discovery and uses only these
  functions: [heartbeatFunction],
  // merged with anything exported from datasets/
  datasets: [rawOrdersDataset],
})
```
