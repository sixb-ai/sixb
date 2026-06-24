# Get started

Scaffold a Sixb project, run it, and define your first object type. By the end you will have a
running runtime, a live object in the built-in UI, and a feel for how the pieces fit together.

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

`sixb dev` loads `sixb.config.ts`, starts the runtime (functions, syncs, and workers co-hosted),
and serves three things:

| Service | URL | Purpose |
| --- | --- | --- |
| Atlas UI | `http://localhost:3000` | Built-in UI to browse objects, telemetry, and events |
| Custom app | `http://localhost:3001` | Your `app/` pages (served only when `app/` has routes) |
| API | `http://localhost:3002` | HTTP/WebSocket API and OpenAPI docs |

Open `http://localhost:3000` and you will see the `Counter` object. The `tick` function writes
telemetry to it once per second, so its value climbs live.

## Define an object type

Object types live in `ontology/` and are auto-discovered — add a file and `sixb dev` picks it up
on the next save. Import ontology builders from `@sixb/core/ontology`.

File: `ontology/customer.ts`

```ts
import { defineObjectType, prop, stringEnum } from "@sixb/core/ontology"

export const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  description: "A company customer.",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("email", "string"),
    prop("company", "string"),
    prop("tier", stringEnum(["bronze", "silver", "gold", "platinum"])),
  ],
})
```

Every object type needs exactly one `primary: true` property as its key. See
[object types](ontology/object-types.md) and [properties](ontology/properties.md) for the full
options.

## Write some data

`sixb.objects(Type)` is the typed API for all object reads, writes, telemetry, links, and
actions. Seed a `Customer` from a function and the runtime writes it on the next tick. The
primary id goes inside `properties` — there is no separate key field.

File: `functions/seed.ts`

```ts
import { defineFunction } from "@sixb/core"
import { Customer } from "../ontology/customer"

export const seedCustomer = defineFunction("seed-customer")
  .interval(5000)
  .run(async ({ sixb }) => {
    await sixb.objects(Customer).upsert({
      properties: {
        id: "cust-001",
        name: "Dana Smith",
        email: "dana@globex.test",
        company: "Globex",
        tier: "gold",
      },
    })
  })
```

Save it under `functions/` and refresh Atlas to see `cust-001`. From here you can query it, link
it to an `Employee`, append telemetry, or render it in your app.

## Next steps

- [Project structure](fundamentals/project-structure.md) — what each folder does and how discovery works
- [Ontology](ontology/overview.md) — model your domain
- [Objects](objects/overview.md) — read, write, and query object instances
- [Building apps](apps/overview.md) — put a typed UI on top
- [Manual install](fundamentals/manual-install.md) — add Sixb to an existing project
