# Manual Install

Add sixb to an existing project without the `create-sixb` scaffold. You install
`@sixb/core`, pick provider packages for the five required infrastructure slots,
and wire them together with `createSixb()`.

If you are starting fresh, prefer the [Get started](../README.md) scaffold
instead — this page is for adding sixb to a project you already have.

## Install

`@sixb/core` ships the runtime, ontology builders, and in-memory providers. The
in-memory providers are enough to run locally and in tests; swap in durable
providers when you need persistence.

```bash
bun add @sixb/core
```

For durable infrastructure, add the provider packages you need:

```bash
bun add @sixb/sqlite @sixb/lake-local @sixb/blob-local
```

## Providers

`createSixb()` requires five infrastructure providers. Each is a separate slot
so you can mix in-memory, local-disk, and hosted backends independently.

| Option | Type | Required | Purpose |
| --- | --- | --- | --- |
| `broker` | `Broker` | yes | Domain-event pub/sub (`object.upserted`, `telemetry.appended`, …) |
| `storage` | `Storage` | yes | Objects, telemetry, links, and run history |
| `lakeStorage` | `LakeStorage` | yes | Dataset / pipeline lake tables |
| `blobStorage` | `BlobStorage` | yes | Binary blob storage |
| `queues` | `Queues` | yes | Background work queues |
| `sandboxes` | `SandboxFactory` | no | Sandboxed execution for functions/pipelines |
| `auth` | `SixbAuthConfig` | no | Authentication and authorization (see [Auth](../auth/overview.md)) |

`@sixb/core` exports an in-memory implementation for every required slot, so a
minimal runtime needs no extra packages:

| Provider | In-memory (from `@sixb/core`) | Durable packages |
| --- | --- | --- |
| `broker` | `InMemoryBroker` | `@sixb/broker-nats`, `@sixb/broker-redis` |
| `storage` | `InMemoryStorage` | `@sixb/sqlite`, `@sixb/pg` |
| `lakeStorage` | `InMemoryLakeStorage` | `@sixb/lake-local`, `@sixb/ducklake` |
| `blobStorage` | `InMemoryBlobStorage` | `@sixb/blob-local`, `@sixb/blob-s3` |
| `queues` | `InMemoryQueues` | — |

## Minimal config

`createSixb()` is **async** and returns a `Promise<Sixb>`, because it
auto-discovers `ontology/`, `datasets/`, `functions/`, and the other convention
folders from disk. Always `await` it (or export the promise and `await` it where
the runtime is consumed).

Create `sixb.config.ts` at your project root. This mirrors the in-memory setup
used by the example projects:

```ts
import {
  createSixb,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
} from "@sixb/core"

export const sixb = await createSixb({
  id: "my-app",
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
})
```

`createSixb()` requires at least one ontology source. Add an `ontology/` folder
(auto-discovered relative to `projectRoot`) or pass `ontologies` explicitly —
otherwise startup throws `No ontology found.` See [Object Types](../ontology/object-types.md).

### With durable providers

Swap the in-memory providers for durable ones. SQLite for objects/telemetry,
local disk for the lake and blobs:

```ts
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { SqliteStorage } from "@sixb/sqlite"

export const sixb = await createSixb({
  id: "my-app",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
})
```

## Top-level options

Beyond providers, `createSixb()` accepts an `id` and explicit definition arrays.
Explicit definitions are merged with — and ordered before — anything discovered
from the convention folders.

| Option | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Runtime identifier (a name, not a provider) |
| `ontologies` | `OntologySource[]` | Adds to discovered `ontology/` sources |
| `actions` | `ActionDefinition[]` | Overrides discovery when provided |
| `functions` | `FunctionDefinition[]` | Overrides discovery when provided |
| `projections` | `ProjectionDefinition[]` | Overrides discovery when provided |
| `datasets`, `connectors`, `schedules`, `syncs`, `pipelines`, `rules`, `workflows` | arrays | Merged with discovered definitions |
| `groups`, `roles`, `invitePolicies` | arrays | Merged with discovered security definitions |
| `auth` | `SixbAuthConfig` | See [Authentication](../auth/authentication.md) |
| `projectRoot` | `string` | Discovery root (defaults to `process.cwd()`) |

## Next steps

- [Project Structure](project-structure.md) — the convention folders `createSixb()` discovers.
- [Runtime](../runtime/overview.md) — what the `Sixb` instance gives you.
- [Server](../server/overview.md) — serve the runtime over HTTP/WebSocket.
- [Infrastructure](../infrastructure/overview.md) — choosing and configuring providers.
