# @sixb/core

The ontology-first runtime for Sixb digital twins. Define your domain model in TypeScript, get a fully typed API for managing objects, links, telemetry, and actions.

## Install

```bash
bun add @sixb/core
```

## Key Concepts

**Ontology** -- Define your domain as object types with typed properties, links between types, and actions. Everything is expressed in TypeScript with full inference.

**Runtime** -- `Sixb` is the main entry point. It registers your ontology and exposes a typed SDK (`sixb.objects(MyType)`) for reads, writes, telemetry, and links.

**Storage** -- Pluggable backends for persistence and coordination. A Sixb runtime needs a `Broker`, `Storage`, `LakeStorage`, `BlobStorage`, and `Queues`. In-memory defaults are included for development and testing.

**Lake Storage** -- Versioned datasets for table-shaped batch assets such as raw sync outputs, projections, and pipeline inputs/outputs. Lake providers store `fileRef` values as row metadata; blob payload bytes live in `BlobStorage`.

**Blob Storage** -- Durable immutable binary objects referenced by dataset `fileRef` values. In-memory core support is included for development and tests; durable providers can be configured separately.

**Events** -- All mutations are emitted to a bounded, retained event stream for live coordination and short replay. The runtime emits object/link mutation events such as `object.created`, `object.updated`, `object.deleted`, `link.created`, `link.updated`, and `link.deleted`, plus topic events like `telemetry.appended` and `action.requested`.

**Actions** -- Typed audited commands. Actions can run external writeback, declare local object/link edits, and run post-commit effects.

**Connectors** -- Typed external system clients that you register with the runtime and resolve lazily with `sixb.connector(...)`.

**Syncs** -- Declarative batch sync definitions that read from one connector and write into one raw dataset. V1 supports `snapshot` and `append` modes with optional triggers and typed source checkpoints.

**Queues** -- Typed durable work lanes for executable jobs such as sync runs, pipeline runs, and projection runs. App setup passes one `Queues` provider, while workers claim from lanes like `sixb.queues.syncRuns`.

## Quick Start

```ts
import {
  Sixb,
  defineAction,
  defineObjectType,
  defineOntology,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  link,
  param,
  prop,
  stringEnum,
  InMemoryBroker,
  InMemoryQueues,
  InMemoryStorage,
} from "@sixb/core"

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
  links: [link.ref("hasThermostat", "Thermostat", { cardinality: "one" })],
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

const sixb = new Sixb({
  id: "building-a",
  ontology: [Buildings],
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
})

// 4. Use the typed SDK

const room = await sixb.objects(Room).upsert({
  properties: {
    id: "room:101",
    externalId: "RM-101",
    name: "Conference 101",
  },
})

const tstat = await sixb.objects(Thermostat).upsert({
  properties: {
    id: "tstat:abc",
    externalId: "device-123",
    name: "Tstat 101",
  },
})

// Link objects
await sixb.objects(Room).byId("room:101").link(Room.l.hasThermostat, tstat)

// Append telemetry (unit is required because of semanticType: "Temperature")
await sixb.objects(Room).byId("room:101").telemetry(Room.p.currentTemperature).append({
  value: 22.4,
  unit: "degreeCelsius",
  at: new Date(),
})

// Query
const found = await sixb
  .objects(Room)
  .query()
  .where((r) => r.p.externalId.eq("RM-101"))
  .first()
```

## Actions

Actions define typed commands that can be requested globally or for an object subject.
Local object/link mutations are declared in `.edits(...)` and committed by the action worker.

```ts
const renameRoom = defineAction("renameRoom")
  .on(Room)
  .params({
    name: param("string"),
  })
  .validate(({ params }) => {
    if (!params.name.trim()) {
      return { error: "Name is required" }
    }
  })
  .edits(({ objects, params, subject }) => {
    objects(Room).byId(subject.primaryId).update({
      name: params.name,
    })
  })

await sixb.actions.request({
  actionId: "renameRoom",
  subject: { kind: "object", objectTypeId: "Room", primaryId: "room:101" },
  params: { name: "Boardroom 101" },
})
```

## Connectors

Connectors are registered definitions. The runtime only creates the client when you resolve one with `sixb.connector(...)`.

```ts
import { defineConnector } from "@sixb/core"

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

const sixb = new Sixb({
  ontology: [Room],
  broker: myBroker,
  storage: myStorage,
  queues: myQueues,
  connectors: [erpDb],
})

const db = await sixb.connector(erpDb)
await db.query("select 1")
```

Connector adapters can also expose inbound webhooks. Webhooks are connector-scoped, discovered
with their connector from `connectors/`, and served by `@sixb/server` at
`POST /api/webhooks/:connectorId/:webhookId`.

```ts
import { defineConnector, defineWebhook, webhookConnector } from "@sixb/core"

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
        .handle(async ({ body, sixb, logger }) => {
          logger.info("Received device telemetry", { deviceId: body.deviceId })
          await sixb.upsertObject("Device", {
            id: body.deviceId,
            temperature: body.temperature,
          })
        }),
    ],
  })
)
```

Use `.json(schema)` for JSON bodies so payloads are validated at runtime. The `.verify(...)`,
`.idempotencyKey(...)`, and `.handle(...)` callbacks each receive a run-scoped `logger`. Omit
`.idempotencyKey(...)` for deterministic upserts where duplicate provider deliveries are harmless.

## Syncs

Syncs are declarative definitions in `@sixb/core` v1. They do not start background work on their own; they just declare how to read from a connector into a dataset.

```ts
import { col, defineDataset, defineSync } from "@sixb/core"

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

const syncOrderEvents = defineSync("sync-order-events", { mode: "append" })
  .checkpoint<{ cursor: string }>()
  .from(erpDb)
  .read(({ query }, context) => {
    const cursor = context.checkpoint?.cursor ?? "0"
    context.setCheckpoint({ cursor: String(Number(cursor) + 1) })
    return query(`select * from order_events where cursor > ${cursor}`)
  })
  .intoDataset(rawOrderEventsDataset)

const sixb = new Sixb({
  ontology: [Room],
  broker: myBroker,
  storage: myStorage,
  queues: myQueues,
  datasets: [rawOrdersDataset, rawOrderEventsDataset],
  connectors: [erpDb],
  syncs: [syncOrders, syncOrderEvents],
})

sixb.listSyncs()
sixb.getSyncById("sync-orders")
```

Call `.checkpoint<T>()` before `.from(...)` to type `context.checkpoint` and
`context.setCheckpoint(...)` in a sync read handler. The sync worker loads the checkpoint from the
latest successful run and stores the next checkpoint only after the dataset commit succeeds.

## Convention-based Setup

`createSixb` auto-discovers ontology from `./ontology/`, datasets from `./datasets/`, syncs from `./syncs/`, workflows from `./workflows/`, and connectors from `./connectors/` in your project directory. Webhooks are discovered through their connector definitions.

```ts
import { createSixb } from "@sixb/core"

const sixb = await createSixb({
  id: "building-a",
  broker: myBroker,
  storage: myStorage,
  lakeStorage: myLakeStorage,
  blobStorage: myBlobStorage,
  queues: myQueues,
})
```

## Migrations

`@sixb/core/storage` provides the storage-provider migration model used by the CLI and durable adapters (`migrateStorage` itself is also exported from the root):

```ts
import { migrateStorage } from "@sixb/core"
import { defineMigrations, runMigrationSet, step } from "@sixb/core/storage"

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
  sixb/            -- Sixb runtime, ObjectSet, ObjectByIdHandle, createSixb
  actions/          -- defineAction, param, optional, ActionRegistry
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
| `link(id, target, options?)` | Create a link to direct ObjectType target(s) |
| `link.ref(id, targetTypeId, options?)` | Create an id-only link reference |
| `link.self(id, options?)` | Create a self-link |
| `link.any(id, options?)` | Create a wildcard link |
| `stringEnum(values)` | Create a string enum schema |
| `integerEnum(values)` | Create an integer enum schema |
| `valueTypeRef(valueType)` | Reference a value type in a property schema |

### Action Builders

| Export | Description |
|---|---|
| `defineAction(id)` | Define a first-class phased action contract |
| `param(schema, options?)` | Define a required action parameter; `{ nullable: true }` accepts explicit `null` |
| `optional(param(...))` | Mark an action parameter as optional while preserving nullable/value semantics |

### Runtime

| Export | Description |
|---|---|
| `Sixb` | Main runtime class |
| `createSixb(options)` | Convention-based factory with auto-discovery |
| `InMemoryQueues` | In-memory `Queues` provider with typed sync and pipeline lanes |
| `InMemoryBlobStorage` | In-memory `BlobStorage` provider for `fileRef` payloads |
| `migrateStorage(storage)` | Run configured storage migrations when supported |
| `defineConnector(id, adapter)` | Define a connector for an external system |
| `defineWebhook(id)` | Define an inbound connector webhook |
| `webhookConnector(options)` | Define an inbound-only connector adapter |
| `defineSync(id, options?)` | Define a batch sync from a connector into a dataset |

### ObjectSet API (`sixb.objects(Type)`)

| Method | Description |
|---|---|
| `.upsert({ properties })` | Create or update an object (id derived from primary property) |
| `.get(id)` | Get an object by id |
| `.query().where(...).limit(...).list()` | Execute a typed object query |
| `.query().where(...).first()` | Return the first object from a typed query |
| `.list({ limit, offset, ... })` | List stored objects with storage-system filtering and pagination |
| `.byId(id)` | Get a handle for link/telemetry/action operations |
| `.appendTelemetryBatch(items)` | Batch append telemetry for multiple objects |
| `.requestAction({ actionId, params })` | Request an action on an object |

### ObjectByIdHandle API (`sixb.objects(Type).byId(id)`)

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
| `EventsRuntime` | Project-scoped domain event API with append, read, latest-cursor, and subscribe |
| `ObjectStorage` | Latest-state projection storage for objects and links |
| `TimeseriesStorage` | Time-series storage for telemetry history |
| `BlobStorage` | Content-addressed binary storage with streaming `put` and `open` operations |
| `MigrationSet<TContext>` | Ordered migration steps owned by one durable adapter |
| `MigrationHistoryStore` | Provider-owned persistence for migration history records |
| `StorageMigrator` | Plan and run one adapter's migration set |
| `MigrationCapableStorage` | Optional storage capability exposing adapter migrators |
| `Queues` | Queue provider with typed job lanes |
| `Queue<TQueueJob>` | One typed queue lane with lease-based claim/complete/retry/fail semantics |

In-memory implementations included: `InMemoryBroker`, `InMemoryObjectStorage`,
`InMemoryTimeseriesStorage`, `InMemoryBlobStorage`, `InMemoryQueues`.

### Events

Domain events include object/link mutations (`object.created`, `object.updated`, `object.deleted`, `link.created`, `link.updated`, `link.deleted`) and topic events such as `telemetry.appended`, `action.requested`, `schedule.triggered`, `sync.run.finished`, `pipeline.run.finished`, and `dataset.version.committed`.

### Units

Built-in quantitative type and unit registry. Use `semanticType` on properties to constrain valid units.

```ts
import { isValidUnit, getUnit, quantitativeTypes } from "@sixb/core"

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
