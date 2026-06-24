# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, and others) working in this project.

## What this is

A [Sixb](https://docs.sixb.ai) project. Sixb is a TypeScript framework for operational
software: you model a domain as a typed **ontology**, then sync data, run automation, and expose
a typed API, client, and app from one runtime. **Bun only** — do not use npm, pnpm, or yarn.

## Commands

- `bun dev` — start the runtime, the built-in Atlas UI, and the app (ports 3000 / 3001 / 3002)
- `bun run build` — production build
- `bun run typecheck` — `tsc --noEmit`
- `bun run check` — format and lint

## Project layout

`createSixb()` in `sixb.config.ts` auto-discovers exported definitions from these folders:

```
ontology/      object types + value types
actions/       typed commands against objects
functions/     code that runs on an interval or cron
datasets/      table-shaped data
syncs/         pull external data into datasets
projections/   map dataset rows into objects + telemetry
connectors/    connections to external systems
schedules/     cron triggers
pipelines/     transform datasets
rules/         continuous evaluation over object state
workflows/     multi-step processes (with human-in-the-loop)
security/      groups/ roles/ invite-policies/
app/           custom React UI — NOT discovered (served separately)
```

Discovery matches **exported values by type**, not filenames. One file can export several
definitions.

## Core APIs

- **Ontology** — `defineObjectType({ id, name, properties, links })` with `prop(id, schema, opts)`
  and `link(id, Target, opts)`. Exactly one property must be `{ primary: true }`. Code imported by
  the browser/`app/` must import builders from `@sixb/core/ontology`, not `@sixb/core`.
- **Objects (runtime)** — `sixb.objects(Type)`: `.upsert({ properties })`, `.get(id)`,
  `.query().where((c) => c.p.field.eq(...)).list()`, `.byId(id).telemetry(...).append(...)`,
  `.byId(id).requestAction(...)`.
- **Actions** — `defineAction(...)`: typed, validated commands; the sanctioned way to mutate state.
- **Schedules** — `defineSchedule(id).cron(expr, { timezone })`, attached to a sync/pipeline/workflow
  via `.when(...)`.
- **Workflows** — `defineWorkflow(id).input(...).then(step)`; pause for approvals with interventions.
- **Apps & client** — import your ontology types and `objects(Type).query()` from
  `@sixb/client/query`, then feed the query to `useObjectsQuery` / `useObjectsFacets` from
  `@sixb/client/hooks` for fully typed, live data. Rows are typed `TwinObject`s.

## Gotchas

- `createSixb()` is **async** — `await` it (or export the promise and await it where consumed).
- Functions run on a clock only: `defineFunction(id).cron(expr).run(fn)` or `.interval(ms).run(fn)`.
  There is no `.broker()` or `.onAction()`. Domain events do **not** trigger functions — react with
  rules or workflows instead.
- `upsert` takes `{ properties }` with the primary id **inside** `properties` (there is no separate
  `key` field).
- Telemetry `semanticType` must be a real quantitative type (e.g. `Temperature`); there is no
  `Currency` type. A telemetry prop without a `semanticType` is fine.
- The five providers (`broker`, `storage`, `lakeStorage`, `blobStorage`, `queues`) are all required.

## Docs

Full documentation: <https://docs.sixb.ai>. Every page is available as raw Markdown — append
`.md` to any docs URL — and <https://docs.sixb.ai/llms.txt> is a machine-readable index of the
whole site. Fetch those when you need detail on a concept or API.
