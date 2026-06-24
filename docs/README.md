# Get started

Scaffold a sixb project, start it, and define your first object type. By the end you will
have a running runtime, a live object in the built-in UI, and a sense of how the pieces fit.

Sixb is Bun-only. Install [Bun](https://bun.sh) first.

## Scaffold a project

`create-sixb` writes a starter project from the basic template: an ontology, a function, an
action, and a custom app.

```bash
bun create-sixb my-app
cd my-app
bun install
```

The template gives you:

| Path | What it is |
| --- | --- |
| `sixb.config.ts` | Runtime entry — calls `createSixb()` with local providers |
| `ontology/counter.ts` | A `Counter` object type |
| `functions/tick.ts` | A function that increments the counter every second |
| `actions/reset.ts` | An action that resets the counter |
| `app/page.tsx` | A custom app page that reads the counter live |

## Start the dev server

```bash
bun sixb dev
```

`sixb dev` loads `sixb.config.ts`, starts the runtime (functions, syncs, and workers
co-hosted), and serves three things. Default ports:

| Service | URL | Purpose |
| --- | --- | --- |
| Atlas UI | `http://localhost:3000` | Built-in UI to browse objects, telemetry, and events |
| Custom app | `http://localhost:3001` | Your `app/` pages (only served if `app/` has routes) |
| API | `http://localhost:3002` | HTTP/WebSocket API and OpenAPI docs |

Open `http://localhost:3000` and you will see the `Counter` object. The `tick` function is
writing telemetry to it once per second, so its value climbs live.

## Define an object type

Object types live in `ontology/` and are auto-discovered. Add a file and `sixb dev` picks it
up on the next save.

File: `ontology/customer.ts`

```ts
import { defineObjectType, prop, stringEnum } from "@sixb/core"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string"),
    prop("tier", stringEnum(["free", "pro", "team"])),
  ],
})
```

Every object type needs exactly one `primary: true` property as its key. See
[object types](ontology/object-types.md) and [properties](ontology/properties.md) for the
full options.

## Write some data

`sixb.objects(Type)` is the typed API for all object reads, writes, telemetry, links, and
actions. Seed a `Customer` from a function and the runtime writes it on the next tick.

File: `functions/seed.ts`

```ts
import { defineFunction } from "@sixb/core"
import { Customer } from "../ontology/customer"

export const seedCustomer = defineFunction("seedCustomer")
  .interval(5000)
  .run(async ({ sixb }) => {
    await sixb.objects(Customer).upsert({
      properties: {
        id: "cust-001",
        name: "Acme Corp",
        email: "ops@acme.test",
        tier: "team",
      },
    })
  })
```

Save it under `functions/` and refresh Atlas to see `cust-001`. From here, query it, link it,
append telemetry, or render it in your app.

## Next steps

- [Project structure](fundamentals/project-structure.md) — what each folder does and how discovery works
- [Ontology](ontology/overview.md) — model your domain
- [Objects](objects/overview.md) — read, write, and query object instances
- [Building apps](apps/overview.md) — put a typed UI on top
- [Manual install](fundamentals/manual-install.md) — add sixb to an existing project
