# Project Structure

A Sixb project is a collection of convention folders plus one entry file. When you call
[`createSixb()`](../runtime/overview.md), it scans well-known directories relative to your
project root, loads every module it finds, and registers the definitions you exported.
There is no central manifest to keep in sync — you create the right kind of definition,
export it from the matching folder, and it is wired in.

## Directory tree

```txt
my-project/
├── sixb.config.ts
├── ontology/
│   └── customer.ts
├── actions/
│   └── send-reminder.ts
├── functions/
│   └── poll-devices.ts
├── datasets/
│   └── orders.ts
├── syncs/
│   └── orders.ts
├── projections/
│   └── customer.ts
├── connectors/
│   └── erp.ts
├── schedules/
│   └── hourly.ts
├── pipelines/
│   └── reporting.ts
├── rules/
│   └── business-health.ts
├── workflows/
│   └── invoice-reminder.ts
├── security/
│   ├── groups/
│   │   └── team-members.ts
│   ├── roles/
│   │   └── atlas-access.ts
│   └── invite-policies/
│       └── default-invites.ts
└── app/                    # custom UI — served separately, not discovered
    └── page.tsx
```

Every folder is optional. Missing folders are silently skipped — discovery returns an
empty list rather than erroring. You can also pass any of these in-line to `createSixb()`
instead of (or in addition to) using the folders.

## Discovered folders

`createSixb()` discovers exactly these folders. Each scan recurses into subdirectories and
loads `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files.

| Folder | Holds | Related page |
| --- | --- | --- |
| `ontology/` | Object types and value types | [Ontology](../ontology/overview.md) |
| `actions/` | Action definitions | [Actions](../actions/overview.md) |
| `functions/` | Code that runs on an interval or cron | — |
| `datasets/` | Dataset definitions | [Datasets](../data/datasets.md) |
| `syncs/` | Sync definitions | [Syncs](../data/syncs.md) |
| `projections/` | Object, link, and telemetry projections | [Projections](../data/projections.md) |
| `connectors/` | Connector definitions | [Connectors](../data/connectors.md) |
| `schedules/` | Schedule definitions | [Schedules](../schedules/overview.md) |
| `pipelines/` | Pipeline definitions | [Pipelines](../data/pipelines.md) |
| `rules/` | Rule definitions | [Rules](../rules/overview.md) |
| `workflows/` | Workflow definitions | [Workflows](../workflows/overview.md) |
| `security/groups/` | Group definitions | [Authorization](../auth/authorization.md) |
| `security/roles/` | Role definitions | [Authorization](../auth/authorization.md) |
| `security/invite-policies/` | Invite-policy definitions | [Authentication](../auth/authentication.md) |

## Discovery matches exported values, not filenames

Discovery does not care what your files are named or how many definitions live in one
file. It imports every module in a folder, walks each export (recursing into arrays), and
keeps the values that pass that kind's type guard. Anything that does not match is ignored.

This means:

- One file can export several definitions, and one definition can be split across files.
- A `helpers.ts` next to your definitions is harmless — its exports just fail the guard.
- An array export is flattened, so `export const all = [a, b, c]` registers all three.
- The folder is what selects the *kind*. A function definition placed in `datasets/` will
  not be picked up there.

```ts
// ontology/customer.ts — file name is irrelevant; both exports are discovered
import { defineObjectType, prop } from "@sixb/core/ontology"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("email", "string"),
  ],
})

export const Lead = defineObjectType({
  id: "Lead",
  name: "Lead",
  properties: [prop("id", "string", { required: true, primary: true })],
})
```

## The entry file

`sixb.config.ts` is the entry. It must export a runtime as a named `sixb` export (preferred)
or as the `default` export. `createSixb()` runs the discovery passes and returns the
runtime, so the common pattern is a single export:

```ts
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { SqliteStorage } from "@sixb/sqlite"

export const sixb = createSixb({
  id: "acme-corp",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
})
```

The CLI loads the entry, then reads `sixb` (falling back to `default`). It accepts three
shapes, so async setup is fine:

| Export shape | Example |
| --- | --- |
| A runtime instance | `export const sixb = createSixb({ ... })` |
| A function returning a runtime (sync or async) | `export const sixb = () => createSixb({ ... })` |
| A promise of a runtime | `export const sixb = createAndSeed()` where the function `await`s |

If the export is none of these, the CLI throws:

```txt
Could not load Sixb runtime from entry. Export `sixb` (or default) as a Sixb instance or Promise<Sixb>.
```

```ts
// async entry: migrate + seed before returning the runtime
export const sixb = createAuthExampleSixb()

async function createAuthExampleSixb() {
  const runtime = await createSixb({
    id: "auth-example",
    // ...providers
  })
  await seed(runtime)
  return runtime
}
```

See [Runtime](../runtime/overview.md) for the full `createSixb()` options and provider list.

## app/ is not discovered

The `app/` folder holds your custom UI and is **not** part of `createSixb()` discovery. It
is built and served separately by `@sixb/app` (`createCustomApp`), so nothing in `app/`
is treated as an ontology, function, or other backend definition. Route conventions and
data access for `app/` are documented under [Apps](../apps/overview.md).

## See also

- [Get started](../README.md) — scaffold and run a project end to end.
- [Manual install](manual-install.md) — set up the folders by hand.
- [Runtime](../runtime/overview.md) — what `createSixb()` accepts and returns.
