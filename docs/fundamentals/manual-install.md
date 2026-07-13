# Manual Install

Add Sixb to a project you already have, without the `create-sixb` scaffold. You
install `@sixb/core`, pick providers for the five required infrastructure slots,
and wire them together with `createSixb()`.

Starting from scratch? Prefer the [Get started](../README.md) scaffold instead —
this page is for an existing project.

## Install

`@sixb/core` ships the runtime, ontology builders, and an in-memory provider for
every required slot. That's enough to run locally and in tests — add durable
provider packages when you need persistence.

```bash
bun add @sixb/core
```

## Providers

`createSixb()` requires five infrastructure providers. Each slot is independent,
so you can mix in-memory, local-disk, and hosted backends freely.

| Option | Required | Purpose | In-memory (from `@sixb/core`) |
| --- | --- | --- | --- |
| `broker` | yes | Domain-event pub/sub (`object.created`, `object.updated`, `telemetry.appended`, …) | `InMemoryBroker` |
| `storage` | yes | Objects, telemetry, links, run history | `InMemoryStorage` |
| `lakeStorage` | yes | Dataset and pipeline lake tables | `InMemoryLakeStorage` |
| `blobStorage` | yes | Binary blob storage | `InMemoryBlobStorage` |
| `queues` | yes | Background work queues | `InMemoryQueues` |
| `sandboxes` | no | Sandboxed execution for functions and pipelines | — |
| `auth` | no | Authentication and authorization | — |

For the durable provider packages (`@sixb/sqlite`, `@sixb/pg`,
`@sixb/lake-local`, `@sixb/blob-s3`, and others) and their config options, see
[Infrastructure](../infrastructure/overview.md).

## Minimal config

Create `sixb.config.ts` at your project root. The in-memory setup needs no extra
packages:

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
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new InMemoryStorage(),
  lakeStorage: new InMemoryLakeStorage(),
  blobStorage: new InMemoryBlobStorage(),
  queues: new InMemoryQueues(),
})
```

`createSixb()` is **async** — it scans the convention folders from disk, so
always `await` it (or export the promise and `await` it where you consume the
runtime).

It also requires at least one ontology source. Add an [`ontology/`](project-structure.md)
folder (auto-discovered) or pass `ontologies` explicitly — otherwise startup
throws `No ontology found.`

### With durable providers

Swap in-memory for durable providers per slot. This is the setup the
[acme-corp example](../examples/overview.md) uses — SQLite for objects and
telemetry, local disk for the lake and blobs:

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

## Top-level options

Beyond providers, `createSixb()` accepts an `id` and explicit definition arrays.
Explicit definitions are merged with — and ordered before — anything discovered
from the convention folders.

| Option | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Runtime identifier (a name, not a provider) |
| `ontologies` | `OntologySource[]` | Added to discovered `ontology/` sources |
| `actions`, `functions`, `projections` | arrays | Override discovery when provided |
| `datasets`, `connectors`, `schedules`, `syncs`, `pipelines`, `rules`, `workflows`, `agents` | arrays | Merged with discovered definitions |
| `groups`, `roles`, `membershipPolicies` | arrays | Merged with discovered security definitions |
| `auth` | `SixbAuthConfig` | See [Authentication](../auth/authentication.md) |
| `projectRoot` | `string` | Discovery root (defaults to `process.cwd()`) |

## Next steps

- [Project Structure](project-structure.md) — the convention folders `createSixb()` discovers.
- [Runtime](../runtime/overview.md) — what the `Sixb` instance gives you.
- [Server](../server/overview.md) — serve the runtime over HTTP/WebSocket.
- [Infrastructure](../infrastructure/overview.md) — choosing and configuring providers.
