# AGENTS.md

You are working inside a Sixb project for **[organization or product name]**.

Learn more about the organization and its work at **[organization URL]**.

Learn more about Sixb at <https://docs.sixb.ai/llms.txt>. Use that index to find and read the
relevant Sixb documentation before implementing framework features.

Your job is to build internal operational software that provides measurable value to the
organization. Favor small, useful deployments that can be validated quickly and improved over
time.

## Documentation

Keep project documentation in `docs/` clear, minimal, and operational.

- Put planning documents under `docs/planning/`.
- Prefer short Markdown files with simple headings, tables, and code blocks.
- Add only documentation worth maintaining.

## Framework limitations

If you encounter a limitation in Sixb while implementing this project, report it clearly rather
than using an unclean workaround. Include the relevant context and the outcome the limitation
blocks. Do not propose a framework solution; identifying and explaining the limitation is enough.

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
datasets/      table-shaped data
syncs/         pull external data into datasets
projections/   map dataset rows into objects + telemetry
connectors/    connections to external systems
schedules/     cron triggers
pipelines/     transform datasets
rules/         continuous evaluation over object state
workflows/     multi-step processes (with human-in-the-loop)
security/      groups/ roles/ policies/
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
- `upsert` takes `{ properties }` with the primary id **inside** `properties` (there is no separate
  `key` field).
- Telemetry `semanticType` must be a real quantitative type (e.g. `Temperature`); there is no
  `Currency` type. A telemetry prop without a `semanticType` is fine.
- The five providers (`broker`, `storage`, `lakeStorage`, `blobStorage`, `queues`) are all required.

## Docs

Full documentation: <https://docs.sixb.ai>. Every page is available as raw Markdown — append
`.md` to any docs URL — and <https://docs.sixb.ai/llms.txt> is a machine-readable index of the
whole site. Fetch those when you need detail on a concept or API.
