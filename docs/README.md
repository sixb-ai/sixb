# Get started

Scaffold a Sixb project, run it, and define your first object type. By the end you will have a
running runtime, a live object in the built-in UI, and a feel for how the pieces fit together.

Sixb is Bun-only. Install [Bun](https://bun.sh) first.

## Scaffold a project

`create-sixb` writes a starter project from the basic template: an ontology, an action, and a
custom app.

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
| `actions/increment.ts` | An action that creates and increments the counter |
| `app/page.tsx` | A custom app page that reads the counter live |

## Start the dev server

```bash
bun sixb dev
```

`sixb dev` loads `sixb.config.ts`, starts the runtime (syncs and workers co-hosted),
and serves three things:

| Service | URL | Purpose |
| --- | --- | --- |
| Atlas UI | `http://localhost:3000` | Built-in UI to browse objects, telemetry, and events |
| Custom app | `http://localhost:3001` | Your `app/` pages (served only when `app/` has routes) |
| API | `http://localhost:3002` | HTTP/WebSocket API and OpenAPI docs |

Open `http://localhost:3001` and use the increment button. The action creates the `Counter` object
on its first run, then advances the shared value on every click.

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

Actions are the audited write boundary for commands from people, apps, and agents. A global action
can create a `Customer` without requiring an existing object subject.

File: `actions/create-customer.ts`

```ts
import { defineAction, param } from "@sixb/core"
import { Customer } from "../ontology/customer"

export const createCustomer = defineAction("create-customer")
  .params({
    id: param("string"),
    name: param("string"),
  })
  .edits(({ objects, params }) => {
    objects(Customer).create({
      id: params.id,
      name: params.name,
      tier: "bronze",
    })
  })
```

Request the action from your app, the runtime API, or Atlas. The resulting object is available to
typed queries, links, subsequent actions, and custom app pages.

## Next steps

- [Project structure](fundamentals/project-structure.md) — what each folder does and how discovery works
- [Ontology](ontology/overview.md) — model your domain
- [Objects](objects/overview.md) — read, write, and query object instances
- [Building apps](apps/overview.md) — put a typed UI on top
- [Running actions from apps](apps/actions.md) — wire action buttons with terminal state
- [Manual install](fundamentals/manual-install.md) — add Sixb to an existing project
