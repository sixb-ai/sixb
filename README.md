<div align="center">

<!-- PNG on an absolute raw URL: npm renders neither SVG nor relative image paths. The nested <img>
     is the spec-required fallback for `<picture>`, so a renderer that ignores `<picture>` — npm —
     still shows the light wordmark, while GitHub switches on theme. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sixb-ai/sixb/main/docs/brand/sixb-wordmark-white.png">
  <img alt="Sixb" src="https://raw.githubusercontent.com/sixb-ai/sixb/main/docs/brand/sixb-wordmark-black.png" width="300">
</picture>

**An ontology-first backbone for operational systems.**

Model your domain once in TypeScript. Get a typed API, a UI, an HTTP surface, and the
primitives that read and write it — actions, workflows, agents, syncs, and projections.

[Documentation](https://docs.sixb.ai) ·
[Examples](https://docs.sixb.ai/examples) ·
[Deployment](https://docs.sixb.ai/deployment) ·
[Contributing](https://github.com/sixb-ai/sixb/blob/main/CONTRIBUTING.md)

[![CI](https://github.com/sixb-ai/sixb/actions/workflows/ci.yml/badge.svg)](https://github.com/sixb-ai/sixb/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)
[![License](https://img.shields.io/badge/license-MIT-black)](https://github.com/sixb-ai/sixb/blob/main/LICENSE)

</div>

---

## Quick start

```bash
bun create sixb my-app
cd my-app
bun run dev
```

A new project runs on SQLite and the local filesystem, with no infrastructure to start. Atlas — the
built-in operations UI — comes up alongside your app.

## What you write

Define a type. Everything else is derived from it.

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

```ts
// actions/settle-invoice.ts
import { defineAction } from "@sixb/core"
import { Invoice } from "../ontology/invoice"

export const settleInvoice = defineAction("settleInvoice")
  .params({ invoiceId: "string" })
  .edits(async ({ objects, params }) => {
    objects(Invoice).byId(params.invoiceId).update({ status: "paid" })
  })
```

`createSixb()` discovers the folders, so those two files are the whole registration. You now have a
typed runtime, a REST and WebSocket API, generated client hooks, and Atlas pages for `Invoice` — plus
an action people, apps, and agents can all request.

In an app, the typed query builder reads across links in one request:

```tsx
import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"

const openInvoices = objects(Invoice)
  .query()
  .where((invoice) => invoice.p.status.eq("sent"))
  .expand(Invoice.l.customer)
  .orderBy(Invoice.p.amount, "desc")

const { data } = useObjectsQuery(openInvoices, { limit: 50 })
```

On the server, the runtime API reads and writes the same objects, and requests actions:

```ts
const { objects: invoices } = await sixb.objects(Invoice).list({ limit: 500 })

// Nothing runs inline — the action is queued and the run is recorded.
await sixb.objects(Invoice).byId("inv_1").requestAction({ action: settleInvoice, params: {} })
```

## The primitives

```
                          ┌──────────────────────────────┐
   connectors ─▶ syncs ──▶│                              │
                          │           ONTOLOGY           │──▶ HTTP + WebSocket API
   datasets ─▶ pipelines ▶│  objects · links · props     │──▶ typed client + hooks
                          │  telemetry · value types     │──▶ Atlas UI + custom apps
   projections ──────────▶│                              │
                          └──────────────┬───────────────┘
                                         │ events
                          ┌──────────────▼───────────────┐
                          │  actions · workflows · rules │
                          │  schedules · agents          │
                          └──────────────────────────────┘
```

Storage, broker, queues, lake, blob, and sandbox are provider contracts. Swap SQLite for PostgreSQL,
the in-memory broker for Redis or NATS, the local filesystem for S3 or DuckLake — the code above does
not change.

## Status

**0.1.0 — first public release.** All packages ship on one version.

This is 0.x and carries no compatibility guarantee; public API will move between minor versions. The
database schema is one migration whose checksum is verified at startup, and before 1.0 a schema
change **replaces** it rather than adding another — so a 0.x upgrade can require recreating the
database. There is no downgrade path.

Bun 1.3 or newer is required. These packages import Bun APIs directly and do not run on Node.

See [CHANGELOG.md](https://github.com/sixb-ai/sixb/blob/main/CHANGELOG.md).

## Learn

- [Get started](https://docs.sixb.ai)
- [Project structure](https://docs.sixb.ai/fundamentals/project-structure)
- [Ontology](https://docs.sixb.ai/ontology) · [Objects](https://docs.sixb.ai/objects) · [Actions](https://docs.sixb.ai/actions)
- [Data integrations](https://docs.sixb.ai/data) · [Apps](https://docs.sixb.ai/apps) · [Deployment](https://docs.sixb.ai/deployment)

## Working on Sixb itself

```bash
git clone https://github.com/sixb-ai/sixb.git
cd sixb
bun install
bun --filter @sixb/example-acme-corp dev
```

Atlas on `http://localhost:3000`, the example app on `:3001`, API docs on `:3002/docs`.

```bash
bun run build       bun run typecheck
bun run test        bun run check
```

Bun is the only package manager and runtime this repository uses.

| | |
| --- | --- |
| `packages/core` | runtime, ontology builders, provider contracts |
| `packages/server` | HTTP/WebSocket API and OpenAPI generation |
| `packages/atlas` | Atlas, the built-in UI |
| `packages/client` | generated typed client |
| `packages/cli` | the `sixb` command |
| `packages/create-sixb` | project scaffolder and template |
| `connectors/` `storage/` `broker/` `queues/` `sandboxes/` | provider implementations |
| `docs/` | source for [docs.sixb.ai](https://docs.sixb.ai) |
| `examples/` | runnable sample projects |

Contributions are welcome — start with
[CONTRIBUTING.md](https://github.com/sixb-ai/sixb/blob/main/CONTRIBUTING.md).
