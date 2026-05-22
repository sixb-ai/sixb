# @pario/core

The ontology-first runtime for Pario digital twins. Define your domain model in TypeScript, get a fully typed API for managing objects, links, telemetry, and actions.

## Install

```bash
bun add @pario/core
```

## Key Concepts

**Ontology** -- Define your domain as object types with typed properties, links between types, and actions. Everything is expressed in TypeScript with full inference.

**Runtime** -- `Pario` is the main entry point. It registers your ontology and exposes a typed SDK (`pario.objects(MyType)`) for reads, writes, telemetry, and links.

**Storage** -- Pluggable backends for persistence and coordination. A Pario runtime needs a `Broker`, `Storage`, `LakeStorage`, `BlobStorage`, and `Queues`. In-memory defaults are included for development and testing.

**Lake Storage** -- Versioned datasets for table-shaped batch assets such as raw sync outputs, projections, and pipeline inputs/outputs. Lake providers store `fileRef` values as row metadata; blob payload bytes live in `BlobStorage`.

**Blob Storage** -- Durable immutable binary objects referenced by dataset `fileRef` values. In-memory core support is included for development and tests; durable providers can be configured separately.

**Events** -- All mutations are emitted to a bounded, retained event stream for live coordination and short replay. The runtime emits `object.upserted`, `telemetry.appended`, `link.upserted`, `link.removed`, and `action.requested` events.

**Functions** -- Scheduled and reactive logic that runs against the twin graph. Triggered by cron expressions, intervals, or action requests.

**Connectors** -- Typed external system clients that you register with the runtime and resolve lazily with `pario.connector(...)`.

**Syncs** -- Declarative batch sync definitions that read from one connector and write into one raw dataset. V1 supports `snapshot` and `append` modes with optional cron metadata.

**Queues** -- Typed durable work lanes for executable jobs such as sync runs, pipeline runs, and projection runs. App setup passes one `Queues` provider, while workers claim from lanes like `pario.queues.syncRuns`.

## Quick Start

```ts
import {
  Pario,
  defineObjectType,
  defineOntology,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  link,
  prop,
  stringEnum,
  InMemoryBroker,
  InMemoryQueues,
  InMemoryStorage,
} from "@pario/core"

// 1. Define object types

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
    prop("currentTemperature", "double", {
      mode: "telemetry",
      semanticType: "Temperature",
    }),
  ],
  links: [link("hasThermostat", "Thermostat", { cardinality: "one" })],
})

const Thermostat = defineObjectType({
  id: "Thermostat",
  name: "Thermostat",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
    prop("mode", stringEnum(["off", "heat", "cool", "auto"])),
  ],
})

// 2. Group into an ontology (optional -- you can pass object types directly)

const Buildings = defineOntology({
  id: "buildings",
  version: "1.0.0",
  objectTypes: [Room, Thermostat],
})

// 3. Create the runtime

const pario = new Pario({
  id: "building-a",
  ontology: [Buildings],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
})

// 4. Use the typed SDK

const room = await pario.objects(Room).upsert({
  properties: {
    id: "room:101",
    externalId: "RM-101",
    name: "Conference 101",
  },
})

const tstat = await pario.objects(Thermostat).upsert({
  properties: {
    id: "tstat:abc",
    externalId: "device-123",
    name: "Tstat 101",
  },
})

// Link objects
await pario.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

// Append telemetry (unit is required because of semanticType: "Temperature")
await pario.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
  value: 22.4,
  unit: "degreeCelsius",
  at: new Date(),
})

// Query
const found = await pario.objects(Room).findFirst({
  where: (r) => r.p.externalId.eq("RM-101"),
})
```

## Functions

Functions define scheduled and reactive logic that operates on the twin graph.

```ts
const pollWeather = defineFunction("poll-weather")
  .cron("*/5 * * * *")
  .run(async ({ pario }) => {
    const res = await fetch("https://api.weather.example/current")
    const data = (await res.json()) as { tempF: number }
    await pario.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
      value: data.tempF,
      unit: "degreeFahrenheit",
      at: new Date(),
    })
  })

const pario = new Pario({
  ontology: [Room],
  broker: myBroker,
  storage: myStorage,
  queues: myQueues,
  functions: [pollWeather],
})

await pario.startFunctions()
```

Trigger types: `cron(expression)`, `interval(ms)`.

## Actions

Actions define typed commands that can be requested on object instances.
They live outside ontology definitions and are auto-discovered from `actions/`.

```ts
const setTemperature = defineAction("setTemperature")
  .target(Room)
  .params({
    value: actionParam("double", { required: true, semanticType: "Temperature" }),
  })
  .validate(({ params }) => {
    if (params.value < 10) {
      return { error: "Temperature is too low" }
    }
  })
  .run(async ({ params, target, pario }) => {
    await pario.objects(Room).appendTelemetryBatch([
      { id: target.primaryId, properties: { currentTemperature: params.value }, at: new Date() },
    ])
  })
```

`requestAction(...)` validates the action id, params, and target object, then emits
`action.requested`. V1 stores handlers on the action definition but does not execute them.

## Connectors

Connectors are registered definitions. The runtime only creates the client when you resolve one with `pario.connector(...)`.

```ts
import { defineConnector } from "@pario/core"

const erpDb = defineConnector("erpDb", {
  type: "sql",
  connect() {
    return {
      query(sql: string) {
        return sql
      },
    }
  },
})

const pario = new Pario({
  ontology: [Room],
  broker: myBroker,
  storage: myStorage,
  queues: myQueues,
  connectors: [erpDb],
})

const db = await pario.connector(erpDb)
await db.query("select 1")
```

Connector adapters can also expose inbound webhooks. Webhooks are connector-scoped, discovered
with their connector from `connectors/`, and served by `@pario/server` at
`POST /api/webhooks/:connectorId/:webhookId`.

```ts
import { defineConnector, defineWebhook, webhookConnector } from "@pario/core"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const edgeGateway = defineConnector(
  "edgeGateway",
  webhookConnector({
    webhooks: [
      defineWebhook("telemetry")
        .post()
        .json({
          parse(value: unknown) {
            if (!isRecord(value) || typeof value.deviceId !== "string") {
              throw new Error("deviceId is required")
            }

            if (value.temperature !== undefined && typeof value.temperature !== "number") {
              throw new Error("temperature must be a number")
            }

            return {
              deviceId: value.deviceId,
              temperature: value.temperature,
            }
          },
        })
        .idempotencyKey(({ request }) => request.headers.get("x-delivery-id"))
        .handle(async ({ body, pario }) => {
          await pario.upsertObject("Device", {
            id: body.deviceId,
            temperature: body.temperature,
          })
        }),
    ],
  })
)
```

Use `.json(schema)` for JSON bodies so payloads are validated at runtime. Omit
`.idempotencyKey(...)` for deterministic upserts where duplicate provider deliveries are harmless.

## Syncs

Syncs are declarative definitions in `@pario/core` v1. They do not start background work on their own; they just declare how to read from a connector into a dataset.

```ts
import { col, defineDataset, defineSync } from "@pario/core"

const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [
    col("orderId", "string"),
    col("customerId", "string", { nullable: true }),
  ],
})

const rawOrderEventsDataset = defineDataset("raw.erp.order-events", {
  schema: [col("eventId", "string")],
})

const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(({ query }) => query("select * from orders"))
  .intoDataset(rawOrdersDataset)

const syncOrderEvents = defineSync("sync-order-events", {
  mode: "append",
  cron: "0 * * * *",
})
  .from(erpDb)
  .read(({ query }) => query("select * from order_events"))
  .intoDataset(rawOrderEventsDataset)

const pario = new Pario({
  ontology: [Room],
  broker: myBroker,
  storage: myStorage,
  queues: myQueues,
  datasets: [rawOrdersDataset, rawOrderEventsDataset],
  connectors: [erpDb],
  syncs: [syncOrders, syncOrderEvents],
})

pario.getSyncDefinitions()
pario.getSyncById("sync-orders")
```

## Convention-based Setup

`createPario` auto-discovers ontology from `./ontology/`, datasets from `./datasets/`, functions from `./functions/`, syncs from `./syncs/`, and connectors from `./connectors/` in your project directory. Webhooks are discovered through their connector definitions.

```ts
import { createPario } from "@pario/core"

const pario = await createPario({
  id: "building-a",
  broker: myBroker,
  storage: myStorage,
  lakeStorage: myLakeStorage,
  blobStorage: myBlobStorage,
  queues: myQueues,
})
```

## Migrations

`@pario/core` provides the storage-provider migration model used by the CLI and durable adapters:

```ts
import { defineMigrations, migrateStorage, runMigrationSet, step } from "@pario/core"

export const objectStorageMigrations = defineMigrations({
  adapterId: "MyObjectStorage",
  steps: [
    step("001-initial-schema", async (db) => {
      await db.exec("CREATE TABLE objects (...)")
    }),
  ],
})
```

- `defineMigrations(...)` validates ordered migration sets and derives versions from ids like `001-initial-schema`.
- `runMigrationSet(...)` plans pending work from migration history, blocks dirty or mismatched history, and returns a report.
- `migrateStorage(storage)` runs a storage provider's exposed `migrators` when available.

## Package Structure

```
src/
  ontology/         -- type builders, schema, tokens, validation, units, inference
  events/           -- domain event runtime, types, and helpers
  broker/           -- retained stream provider contract and in-memory implementation
  storage/          -- ObjectStorage and TimeseriesStorage interfaces
    migrations/     -- shared migration runner types/utilities
    objects/        -- object/link storage types and in-memory implementation
    timeseries/     -- timeseries storage types and in-memory implementation
  blob-storage/     -- BlobStorage types and in-memory implementation
  lake-storage/     -- LakeStorage types and in-memory implementation
  queues/           -- Queues, typed queue lanes, and in-memory implementation
  connectors/       -- defineConnector, connector types, connector runtime
  syncs/            -- defineSync and sync types
  pario/            -- Pario runtime, ObjectSet, ObjectByIdHandle, createPario
  actions/          -- defineAction, actionParam, ActionRegistry
  functions/        -- defineFunction, FunctionRuntime, cron matcher
```

## API Overview

### Ontology Builders

| Export | Description |
|---|---|
| `defineObjectType(input)` | Define an object type with properties and links |
| `defineOntology(input)` | Group object types and value types into a versioned document |
| `defineValueType(input)` | Define a reusable value type |
| `defineInterface(input)` | Define a reusable interface contract |
| `prop(id, schema, options?)` | Shorthand for creating a property |
| `link(id, targetTypeId, options?)` | Shorthand for creating a link |
| `stringEnum(values)` | Create a string enum schema |
| `integerEnum(values)` | Create an integer enum schema |
| `valueTypeRef(valueType)` | Reference a value type in a property schema |

### Action Builders

| Export | Description |
|---|---|
| `defineAction(id)` | Define a first-class action contract and handler |
| `actionParam(schema, options?)` | Define an action parameter inside `.params({...})` |

### Runtime

| Export | Description |
|---|---|
| `Pario` | Main runtime class |
| `createPario(options)` | Convention-based factory with auto-discovery |
| `InMemoryQueues` | In-memory `Queues` provider with typed sync and pipeline lanes |
| `InMemoryBlobStorage` | In-memory `BlobStorage` provider for `fileRef` payloads |
| `migrateStorage(storage)` | Run configured storage migrations when supported |
| `defineFunction(id)` | Define a function with trigger and handler |
| `defineConnector(id, adapter)` | Define a connector for an external system |
| `defineWebhook(id)` | Define an inbound connector webhook |
| `webhookConnector(options)` | Define an inbound-only connector adapter |
| `defineSync(id, options?)` | Define a batch sync from a connector into a dataset |

### ObjectSet API (`pario.objects(Type)`)

| Method | Description |
|---|---|
| `.upsert({ properties })` | Create or update an object (id derived from primary property) |
| `.get(id)` | Get an object by id |
| `.findFirst({ where })` | Find first matching object |
| `.list({ where, limit, ... })` | List objects with filtering and pagination |
| `.byId(id)` | Get a handle for link/telemetry/action operations |
| `.appendTelemetryBatch(items)` | Batch append telemetry for multiple objects |
| `.requestAction({ id, actionId, params })` | Request an action on an object |

### ObjectByIdHandle API (`pario.objects(Type).byId(id)`)

| Method | Description |
|---|---|
| `.get()` | Get the object |
| `.link(token, target)` | Create or update a link |
| `.unlink(token, target)` | Remove a link |
| `.listLinks(token?)` | List links from this object |
| `.telemetry(token)` | Get a telemetry appender for a property |
| `.requestAction({ actionId, params })` | Request an action |

### Storage And Queue Interfaces

| Interface | Description |
|---|---|
| `Broker` | Retained stream provider used by runtime services |
| `EventsRuntime` | Project-scoped domain event API with append, read, and subscribe |
| `ObjectStorage` | Latest-state projection storage for objects and links |
| `TimeseriesStorage` | Time-series storage for telemetry history |
| `MigrationSet<TContext>` | Ordered migration steps owned by one durable adapter |
| `MigrationHistoryStore` | Provider-owned persistence for migration history records |
| `StorageMigrator` | Plan and run one adapter's migration set |
| `MigrationCapableStorage` | Optional storage capability exposing adapter migrators |
| `Queues` | Queue provider with typed job lanes |
| `Queue<TQueueJob>` | One typed queue lane with lease-based claim/complete/retry/fail semantics |

In-memory implementations included: `InMemoryBroker`, `InMemoryObjectStorage`, `InMemoryTimeseriesStorage`, `InMemoryQueues`.

### Events

All domain events: `object.upserted`, `telemetry.appended`, `link.upserted`, `link.removed`, `action.requested`, `schedule.triggered`, `sync.run.finished`, `pipeline.run.finished`, `dataset.version.committed`.

### Units

Built-in quantitative type and unit registry. Use `semanticType` on properties to constrain valid units.

```ts
import { isValidUnit, getUnit, quantitativeTypes } from "@pario/core"

isValidUnit("Temperature", "degreeCelsius") // true
getUnit("degreeCelsius")?.symbol            // "°C"
```

## Runtime Validation

The runtime validates all writes at runtime even if TypeScript checks are bypassed:

- Every object type must have exactly one `primary` property (required, string schema)
- Unknown properties are rejected
- Required properties are enforced
- Property values are validated against their schema
- Telemetry values and units are validated against `semanticType`
- Link target types and cardinality are validated
- Action params are validated against the action definition

## Notes

- `ontology` accepts either object types directly or ontology documents
- Object types support `extends` for single-inheritance and `parents` for multi-parent classification
- This package is under active development; API may evolve
