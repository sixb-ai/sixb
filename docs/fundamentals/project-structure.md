# Project Structure

A Sixb project is a set of convention folders plus one entry file. [`createSixb()`](../runtime/overview.md)
scans definition directories under your project root, loads every module it finds, and registers the
definitions you export. Other runtime components can recognize their own folders too; for example,
the agent worker reads `skills/` as Agent Skills. There is no central manifest: you write the file in
the matching folder, and Sixb wires it in.

## Directory tree

```txt
my-sixb-app/
├── sixb.config.ts
├── ontology/
│   ├── customer.ts
│   └── invoice.ts
├── actions/
│   └── markPaid.ts
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
├── shares/
│   └── published-invoice.ts
├── skills/
│   └── acme-writing-style/
│       ├── SKILL.md
│       └── references/
│           └── examples.md
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

Sixb recognizes these convention folders. Most are `createSixb()` definition folders: each scan
recurses into subdirectories and loads `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files. The
folder selects the *kind*: a definition picked up depends on where it lives, not what the file is
named. `skills/` is different: the agent worker reads Agent Skill folders and materializes them into
agent sandboxes.

| Folder | Holds | Related page |
| --- | --- | --- |
| `ontology/` | Object types and value types | [Ontology](../ontology/overview.md) |
| `actions/` | Action definitions | [Actions](../actions/overview.md) |
| `datasets/` | Dataset definitions | [Datasets](../data/datasets.md) |
| `connectors/` | Connector definitions | [Connectors](../data/connectors.md) |
| `syncs/` | Sync definitions | [Syncs](../data/syncs.md) |
| `projections/` | Object, link, and telemetry projections | [Projections](../data/projections.md) |
| `schedules/` | Schedule definitions | [Schedules](../schedules/overview.md) |
| `pipelines/` | Pipeline definitions | [Pipelines](../data/pipelines.md) |
| `rules/` | Rule definitions | [Rules](../rules/overview.md) |
| `workflows/` | Workflow definitions | [Workflows](../workflows/overview.md) |
| `agents/` | Agent definitions | [Agents](../agents/overview.md) |
| `shares/` | Shared-access type definitions | [Authorization](../auth/authorization.md) |
| `skills/` | Agent Skills (`<name>/SKILL.md` plus references/assets/scripts) read by the agent worker | [Agents](../agents/overview.md) |
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

`sixb.config.ts` is the project entry. Export the host as `sixb`; the CLI loads this value when it
starts the project.

```ts
import { LocalBlobStorage } from "@sixb/blob-local"
import { createSixb, InMemoryBroker, InMemoryQueues } from "@sixb/core"
import { LocalLakeStorage } from "@sixb/lake-local"
import { SqliteStorage } from "@sixb/sqlite"

export const sixb = createSixb({
  id: "my-sixb-app",
  broker: new InMemoryBroker(),
  storage: new SqliteStorage({ path: ".sixb" }),
  lakeStorage: new LocalLakeStorage({ path: ".sixb/lake" }),
  blobStorage: new LocalBlobStorage({ basePath: ".sixb" }),
  queues: new InMemoryQueues(),
})
```

`createSixb()` returns a promise; the CLI awaits the exported `sixb` value before starting the project.

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
