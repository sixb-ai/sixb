# Pario

Build software for business operations.

Pario is a TypeScript framework for building apps around the data, workflows, and decisions that
run a business.

It gives teams a unified operational layer: business logic in code, connected to the tools they
already use, shaped around how the company actually works.

[Docs](./docs) · [Examples](./examples) · [Contributing](./CONTRIBUTING.md)

## What It Is

Pario gives operational software a shared backbone:

- `ontology/` describes your domain as typed objects, links, properties, and telemetry
- `actions/` defines commands people or agents can request on those objects
- `connectors/` connects Pario to outside systems
- `datasets/`, `syncs/`, `pipelines/`, and `projections/` move external data into the model
- `schedules/` and `workflows/` orchestrate ongoing work
- `app/` adds a custom React UI on top of the same runtime

## The Mental Model

The ontology is the center. Everything else either changes the model, reads from it, or exposes it.

Syncs and pipelines bring in source data. Projections materialize that data as objects and links.
Actions make the model operational. Events record what happened. The server exposes REST,
WebSocket, OpenAPI, and a built-in UI. Custom apps and generated clients use the same API.

`createPario()` wires the project together with convention-based discovery and gives you a typed
runtime API like `pario.objects(Invoice)`.

## Example

```ts
// ontology/invoice.ts
import { defineObjectType, prop, stringEnum } from "@pario/core"

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("customerId", "string", { required: true }),
    prop("amount", "double", { required: true }),
    prop("status", stringEnum(["draft", "approved", "paid"])),
  ],
})
```

```ts
// actions/approve-invoice.ts
import { defineAction } from "@pario/core"
import { Invoice } from "../ontology/invoice"

export const approveInvoice = defineAction("approve")
  .target(Invoice)
  .params({})
  .run(async ({ target, pario }) => {
    await pario.objects(Invoice).upsert({
      properties: {
        id: target.primaryId,
        status: "approved",
      },
    })
  })
```

From there, Pario can expose the same model through a typed runtime API, durable events, and
the built-in server and UI.

Add `pario.config.ts` with `createPario()`, and Pario auto-discovers your project folders.

## Quick Start

Pario uses [Bun](https://bun.sh) for package management and runtime.

```bash
git clone https://github.com/demattosanthony/pario
cd pario
bun install
bun run link-cli
pario create my-pario-app
cd my-pario-app
bun install
pario dev
```

Open `http://localhost:3000` to see the starter app, built-in UI, and local runtime. Generated
API docs are available at `http://localhost:3000/docs`.

## Production

Use `pario dev` for local all-in-one development. For production, build once and run each role as a
separate process so scaling and failure boundaries stay explicit:

```bash
pario build
pario api
pario atlas
pario sentinel
pario app
pario scheduler
pario orchestrator
pario functions
pario rules
pario worker sync
pario worker pipeline
pario worker projection
pario worker action
pario worker workflow
```

The split commands are the production layout for Docker, Kubernetes, systemd, and other process
managers. `pario atlas`, `pario sentinel`, and `pario app` serve only assets prepared by
`pario build`.

## Where To Go Next

- [`docs/`](./docs) for the simplified framework overview and concepts
- [`examples/roku-tv`](./examples/roku-tv) for a device-control example
- [`examples/panasonic-ac`](./examples/panasonic-ac) for a live system integration example
- [`packages/core`](./packages/core) for the runtime and ontology builders
- [`packages/server`](./packages/server) for the HTTP/WebSocket API and built-in UI
- [`packages/cli`](./packages/cli) for `pario` and `create-pario`
- [`packages/client`](./packages/client) for the generated typed client
