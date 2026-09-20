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
[Events](../../../docs/events/overview.md) and [Schedules](../../../docs/schedules/overview.md).

### Logs

`sixb.logs` reads the structured logs produced by your runs.

```ts
const page = await sixb.logs.read({ kinds: ["action"], levels: ["error"], limit: 50 })
```

Handlers write these lines through `ctx.logger`, and apps read them through the client `logs`
builder. See [Logging](../../../docs/logging/overview.md).

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

See the documentation for each primitive for its handler context, [Testing](../../../docs/testing/overview.md) for test setup, and [Authorization](../../../docs/auth/authorization.md) for the grants enforced by the SDK.
