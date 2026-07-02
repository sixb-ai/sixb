# Project Structure

A Sixb project is a set of convention folders plus one entry file. [`createSixb()`](../runtime/overview.md)
scans well-known directories under your project root, loads every module it finds, and
registers the definitions you export. There is no central manifest: you write a definition,
export it from the matching folder, and it is wired in.

## Directory tree

```txt
acme-corp/
├── sixb.config.ts
├── ontology/
│   ├── customer.ts
│   └── invoice.ts
├── actions/
│   └── markPaid.ts
├── functions/
│   └── check-overdue-invoices.ts
├── datasets/
│   └── erp.ts
├── connectors/
│   └── acme-erp.ts
├── syncs/
│   └── erp.ts
├── projections/
│   └── invoice-projection.ts
├── schedules/
│   └── erp.ts
├── pipelines/
│   └── project-reporting.ts
├── rules/
│   └── business-health.ts
├── workflows/
│   └── invoice-reminder.ts
├── agents/
│   └── invoice-assistant.ts
├── security/
│   ├── groups/
│   │   └── finance-admins.ts
│   ├── roles/
│   │   └── finance-access.ts
│   └── policies/
│       └── member-administration.ts
└── app/                    # custom UI — served separately, not discovered
    └── page.tsx
```

Every folder is optional — a missing folder is skipped, not an error. You can also pass any
of these definitions in-line to `createSixb()` instead of (or alongside) the folders.

## Discovered folders

`createSixb()` discovers exactly these folders. Each scan recurses into subdirectories and
loads `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files. The folder selects the *kind*:
a definition picked up depends on where it lives, not what the file is named.

| Folder | Holds | Related page |
| --- | --- | --- |
| `ontology/` | Object types and value types | [Ontology](../ontology/overview.md) |
| `actions/` | Action definitions | [Actions](../actions/overview.md) |
| `functions/` | Code that runs on an interval or cron | — |
| `datasets/` | Dataset definitions | [Datasets](../data/datasets.md) |
| `connectors/` | Connector definitions | [Connectors](../data/connectors.md) |
| `syncs/` | Sync definitions | [Syncs](../data/syncs.md) |
| `projections/` | Object, link, and telemetry projections | [Projections](../data/projections.md) |
| `schedules/` | Schedule definitions | [Schedules](../schedules/overview.md) |
| `pipelines/` | Pipeline definitions | [Pipelines](../data/pipelines.md) |
| `rules/` | Rule definitions | [Rules](../rules/overview.md) |
| `workflows/` | Workflow definitions | [Workflows](../workflows/overview.md) |
| `agents/` | Agent definitions | [Agents](../agents/overview.md) |
| `security/groups/` | Group definitions | [Authorization](../auth/authorization.md) |
| `security/roles/` | Role definitions | [Authorization](../auth/authorization.md) |
| `security/policies/` | Membership-policy definitions | [Authorization](../auth/authorization.md) |

Discovery matches exported *values*, not filenames. One file can export several definitions,
a definition can be split across files, and an array export is flattened — so
`export const all = [Customer, Invoice]` registers both. A `helpers.ts` next to your
definitions is harmless: its exports just fail the kind's type guard and are ignored.

```ts
// ontology/customer.ts — both exports are discovered
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Employee } from "./employee"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string", { required: true }),
    prop("tier", stringEnum(["bronze", "silver", "gold", "platinum"])),
  ],
  links: [link("accountManager", Employee, { cardinality: "one" })],
})

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})
```

## The entry file

`sixb.config.ts` is the entry. It exports a runtime as a named `sixb` export (preferred) or
as the `default` export. `createSixb()` runs discovery and returns the runtime, so the common
shape is a single export:

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

`createSixb()` is async, so the export is a promise here — the CLI awaits it. It accepts
three shapes, which lets you run async setup such as migrations or seeding before the runtime
is returned:

| Export shape | Example |
| --- | --- |
| A runtime promise | `export const sixb = createSixb({ ... })` |
| A function returning a runtime (sync or async) | `export const sixb = () => createSixb({ ... })` |
| A resolved runtime instance | `export const sixb = await createSixb({ ... })` |

```ts
// async entry: seed before returning the runtime
export const sixb = bootstrap()

async function bootstrap() {
  const runtime = await createSixb({ id: "acme-corp" /* ...providers */ })
  await seedCustomers(runtime)
  return runtime
}
```

If the export is none of these shapes, the CLI throws:

```txt
Could not load Sixb runtime from entry. Export `sixb` (or default) as a Sixb instance or Promise<Sixb>.
```

See [Runtime](../runtime/overview.md) for the full `createSixb()` options and provider list.

## app/ is not discovered

The `app/` folder holds your custom UI and is **not** part of `createSixb()` discovery.
`@sixb/app` (`createCustomApp`) builds and serves it separately, so nothing in `app/` is
treated as a backend definition. Route conventions and data access for `app/` are documented
under [Apps](../apps/overview.md).

## Related

- [Get started](../README.md) — scaffold and run a project end to end.
- [Manual install](manual-install.md) — set up the folders by hand.
- [Runtime](../runtime/overview.md) — what `createSixb()` accepts and returns.
