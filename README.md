<div align="center">

<!-- Absolute `main` URLs rather than relative paths, so the file still renders when it is read
     outside a branch checkout. The cost is that a new image 404s until its commit reaches `main`.
     The alt text carries the name and the tagline, which live inside the image and are otherwise
     invisible to search engines and screen readers. -->
<img alt="Sixb — the open-source operational layer for enterprise AI" src="https://raw.githubusercontent.com/sixb-ai/sixb/main/docs/brand/sixb-banner.png" width="100%">

**Build internal apps shared by teams and AI agents.**

Sixb connects company data, rules, permissions, and workflows so teams and AI operate in the same
governed environment.

[Documentation](https://docs.sixb.ai) ·
[Quickstart](#quickstart) ·
[Example app](#northline-operations) ·
[Contributing](https://github.com/sixb-ai/sixb/blob/main/CONTRIBUTING.md)

[![npm](https://img.shields.io/npm/v/@sixb/core?color=black&label=version)](https://www.npmjs.com/package/@sixb/core)
[![CI](https://github.com/sixb-ai/sixb/actions/workflows/ci.yml/badge.svg)](https://github.com/sixb-ai/sixb/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-docs.sixb.ai-black)](https://docs.sixb.ai)
[![License](https://img.shields.io/badge/license-MIT-black)](https://github.com/sixb-ai/sixb/blob/main/LICENSE)

</div>

---

## See Sixb in action

<div align="center">
<img alt="People, tools, approvals, documents, knowledge, and data on the left become concepts, rules, processes, permissions, and actions in the Sixb operational layer, which becomes the Northline Operations app on the right" src="https://raw.githubusercontent.com/sixb-ai/sixb/main/docs/brand/sixb-in-action.gif" width="100%">
</div>

## Why Sixb

- AI assistants lack the context required to operate reliably.
- Tool access — MCP included — carries the tools, not the business rules, permissions, or processes
  around them.
- Sixb gives teams and agents the same operational context and the same controlled actions.

## What you can build

| | |
| --- | --- |
| **Internal operational applications** | Typed React apps on your own objects, with Atlas as the admin surface from the start |
| **Event-driven agent workflows** | Agents and workflows that react to data changes and run controlled actions |
| **Human approval interfaces** | Flows that pause for a person to decide, with every run recorded and inspectable |

## Quickstart

```bash
bun create sixb my-app
cd my-app
bun run dev
```

A new project runs on SQLite and local files — nothing to install, no service to start. Atlas, the
built-in operations UI, comes up alongside your app.

To run the reference example instead:

```bash
git clone https://github.com/sixb-ai/sixb.git
cd sixb
bun install
bun --filter @sixb/example-northline dev
```

| | |
| --- | --- |
| Northline Operations | <http://localhost:3001> |
| Atlas | <http://localhost:3000> |
| API documentation | <http://localhost:3002/docs> |

## Northline Operations

Northline is a fictional commercial building-services company that connects its business system,
its field-service platform, and its building-controls data through Sixb.

<div align="center">
<img alt="The Quotes page in Northline Operations: three repair quotes awaiting an internal review, a customer decision, and a recorded approval" src="https://raw.githubusercontent.com/sixb-ai/sixb/main/docs/brand/northline-operations.png" width="100%">
</div>

One service case carries the whole journey:

```text
alarm ─▶ coverage ─▶ dispatch ─▶ diagnosis ─▶ quote ─▶ repair ─▶ recovery ─▶ closure
```

Each step is a real action, rule, or workflow — and the objects, runs, rule state, datasets, and
projections behind it stay inspectable in Atlas.

```bash
bun run demo:reset          # recreate source and runtime state
bun run demo:sync           # reconcile every source through the data plane
bun run demo:alarm          # deliver the signed RTU-7 alarm webhook
bun run demo:approve-quote  # approve a pending source-system quote
```

Read it end to end: [`examples/northline`](https://github.com/sixb-ai/sixb/tree/main/examples/northline).

## How it works

```text
Connect ─▶ Store ─▶ Transform ─▶ Model ─▶ Govern ─▶ Execute
```

| | |
| --- | --- |
| **Connect** | Reach company systems through connectors |
| **Store** | Land raw rows in typed datasets |
| **Transform** | Shape them with SQL pipelines |
| **Model** | Project them onto business objects and links |
| **Govern** | Apply rules and permissions |
| **Execute** | Run actions and workflows from apps, people, and agents |

Modeling is where you start. Define a type, and the rest is derived from it.

```ts
// ontology/invoice.ts
import { defineObjectType, link, prop, stringEnum } from "@sixb/core/ontology"
import { Customer } from "./customer"

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "double", { required: true, query: { filterable: true, sortable: true } }),
    prop("status", stringEnum(["draft", "sent", "paid"]), { query: { facet: true } }),
  ],
  links: [link("customer", Customer, { cardinality: "one" })],
})
```

Changes go through actions, so there is one governed path to a write:

```ts
// actions/settle-invoice.ts
import { defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const settleInvoice = defineAction("settleInvoice")
  .on(Invoice)
  .params({})
  .edits(({ objects, subject }) => {
    objects(Invoice).byId(subject.primaryId).update({ status: "paid" })
  })
```

`createSixb()` discovers the folders, so those two files are the whole registration. You now have a
typed runtime, an HTTP and WebSocket API, generated client hooks, and Atlas pages for `Invoice` — plus
an action that people, apps, and agents all request the same way.

```ts
// In an app: the typed query builder reads across links in one request.
const openInvoices = objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("sent"))
  .expand(Invoice.l.customer)

// In a workflow or action step: nothing runs inline — the run is queued and recorded.
await sixb.objects(Invoice).byId("inv_1").requestAction({ action: settleInvoice, params: {} })
```

## Architecture

```text
   connectors            reach company systems
        │
        ▼
   syncs ─▶ datasets     typed tables, in DuckLake or local files
        │
        ▼
   pipelines             SQL transformations, executed in DuckDB
        │
        ▼
   projections           objects · links · telemetry, in PostgreSQL or SQLite
        │
        ▼
   rules · permissions · actions · workflows · agents
        │
        ▼
   Atlas · custom apps · HTTP + WebSocket API · typed client
```

Infrastructure is a set of slots you pass to `createSixb()`. Swapping one is a config change; nothing
above it moves.

| Slot | Ships with |
| --- | --- |
| `storage` | SQLite · PostgreSQL |
| `lakeStorage` | Local files · DuckLake |
| `blobStorage` | Local files · S3-compatible |
| `broker` | In-memory · Redis · NATS |
| `queues` | In-memory · BullMQ |
| `sandboxes` *(optional)* | Local · Apple Container · smolVM · Vercel |

## Core concepts

| | | |
| --- | --- | --- |
| **Concepts** | Business objects and their relationships | `defineObjectType` · `link` · `prop` |
| **Rules** | Business constraints and derived state | `defineRule` |
| **Processes** | Structured operational flows, including human approval | `defineWorkflow` · `defineIntervention` |
| **Permissions** | What each person and agent may see and do | `defineRole` · `defineGroup` · `defineMembershipPolicy` |
| **Actions** | The controlled ways data changes | `defineAction` |

## Repository structure

| | |
| --- | --- |
| `packages/` | Core runtime, server, CLI, Atlas, typed client, scaffolder |
| `storage/` `broker/` `queues/` `sandboxes/` `auth/` | Provider implementations for the slots above |
| `connectors/` | 13 first-party connectors — Google, GitHub, SQL, SFTP, REST, and more |
| `examples/` | Runnable projects, `northline` first |
| `docs/` | Source for [docs.sixb.ai](https://docs.sixb.ai) |

## Learn more

- [Documentation](https://docs.sixb.ai) · [Project structure](https://docs.sixb.ai/fundamentals/project-structure)
- [Ontology](https://docs.sixb.ai/ontology) · [Objects](https://docs.sixb.ai/objects) · [Actions](https://docs.sixb.ai/actions) · [Workflows](https://docs.sixb.ai/workflows) · [Agents](https://docs.sixb.ai/agents)
- [Data](https://docs.sixb.ai/data) · [Apps](https://docs.sixb.ai/apps) · [Server & API](https://docs.sixb.ai/server) · [Infrastructure](https://docs.sixb.ai/infrastructure)
- [Examples](https://docs.sixb.ai/examples) · [Deployment](https://docs.sixb.ai/deployment)

## Status

**0.1.0 — first public release.** All packages ship on one version.

This is 0.x and carries no compatibility guarantee; public API will move between minor versions. The
database schema is one migration whose checksum is verified at startup, and before 1.0 a schema
change **replaces** it rather than adding another — so a 0.x upgrade can require recreating the
database. There is no downgrade path.

Bun 1.3 or newer is required. These packages import Bun APIs directly and do not run on Node.

See [CHANGELOG.md](https://github.com/sixb-ai/sixb/blob/main/CHANGELOG.md).

## Contributing

Contributions are welcome — start with
[CONTRIBUTING.md](https://github.com/sixb-ai/sixb/blob/main/CONTRIBUTING.md).

Bun is the only package manager and runtime this repository uses.

```bash
bun run build
bun run typecheck
bun run test
bun run check
```

## License

[MIT](https://github.com/sixb-ai/sixb/blob/main/LICENSE)
