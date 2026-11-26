# Migrations

A migration says what happens to stored objects when their object type changes in a way they no
longer fit: a property removed, renamed, made required or narrowed, or a link removed. It lives in
`migrations/`, next to the type it migrates, and is reviewed with the change.

```ts
// migrations/job-gate-code.ts
import { defineMigration } from "@sixb/core"
import { Job } from "../ontology/jobs"

export const jobGateCode = defineMigration("job-gate-code", Job)
  .renameProperty("gate", "gateCode")
  .removeProperty("legacyNote")
  .fillProperty("crewLead", ({ object }) => String(object.assignedTo ?? "unassigned"))
  .convertProperty("hours", ({ value }) => Number(value))
```

## The steps

| Step | Does | Runs while the stored objects… |
| --- | --- | --- |
| `removeProperty(id)` | Deletes a property's values and edits | still hold `id` |
| `removeLink(id)` | Deletes a link's links and link edits | still hold the link |
| `renameProperty(from, to)` | Moves a property's values and edits to `to` | hold `from` and not `to` |
| `fillProperty(id, fn)` | Gives a value to objects created by actions that lack one | don't have `id` as required, and the code does |
| `convertProperty(id, fn)` | Rewrites each edit's value into the new schema | have a schema for `id` the code's no longer accepts |

- `from` and removed ids are ones the type no longer declares; `to`, filled and converted ids are
  ones it declares. `to` and each function's return value are typed against the type.
- `fn` receives the object as stored, after the earlier steps, and returns plain values.
- A migration of a type also applies to each subtype that inherits what it touches.
- Values a projection writes are the projection's: it rebuilds them under the new definition.

## When a migration runs

A migration has no version number and no ledger. Each step runs only while the stored objects still
need it, so:

- A new database never runs the migrations already in the repo: its objects start in the current
  shape.
- Steps run in the order their conditions allow: renames first, then fills and converts, then
  removals, so a fill can read a property its migration removes.
- Two branches that migrate different properties of one type merge without conflict.
- One fill and one convert of a property may be pending together. Two of the same kind can't.
- Fills and converts run at most once per database. A removal or a rename runs again only if the
  stored objects hold the old key again, say after a rollback. Delete a migration once every
  database has applied it; `sixb check` says when the code has moved past one, which then does
  nothing.

## What a deploy says

A deploy checks every change the stored objects don't fit
([Changing object types](../deployment/object-type-changes.md)). For each one no migration covers,
it writes the line to add:

```text
✗ Job: 'gate' was removed, and 2,140 objects hold it.
  Rename or remove it in a migration:
    defineMigration("job-gate", Job).renameProperty("gate", "<new id>")
    defineMigration("job-gate", Job).removeProperty("gate")
```

`sixb check` also loads every migration without reading storage, and refuses one that can never be
right: a duplicate id, a rename into itself, a value given to the primary property or to telemetry,
or one property changed twice.

## Running one

`sixb check --migrate` (the deploy step) and `sixb db migrate` run the pending migrations before
the new code serves. `removeProperty`, `renameProperty` and `removeLink` run in this release; a
change a fill or a convert covers still stops the deploy while objects hold it:

```text
✗ Job: 'hours' is now required, and 2,140 objects lack it: created without it or cleared by an edit.
  Migration 'job-hours' is pending; this build can't apply it yet.
```

A run goes in this order:

1. **Pause.** A deploy that runs one stops the live release first (`sixb db migrate --check` exits
   `3`), so the old code doesn't write the keys being removed.
2. **Checks.** Everything that can fail runs before anything is written: the stored objects again,
   markings, the lake with `--lake`, and duplicates of properties the new code makes unique. A
   failure leaves storage as it was, and the old release starts again.
3. **Apply.** From the first batch, the deploy only goes forward
   ([During a deploy](../deployment/object-type-changes.md#during-a-deploy)). Each batch rewrites
   only the objects, edits, source rows, links, unique values, file references and vectors that
   hold a removed or renamed key, in one transaction, and saves where the next one starts. On
   PostgreSQL, ranges of a type's objects and its source rows run side by side.
4. **Record.** The type's new shape is recorded, and the migration doesn't run again on that
   database.

A migration changes the shape, not the business: rewritten objects get a new version, but no
`object.updated` event, rule or workflow fires.

## What a rename moves

Everything that holds the old key moves to the new one, without being rebuilt:

| Store | After `renameProperty("gate", "gateCode")` |
| --- | --- |
| Values and edits | Under `gateCode`, losing edits and unsets included, each with its edit time |
| Source rows | Under `gateCode`, and so are the properties a row names absent |
| Unique values | Moved as they are; built after the run if `gate` wasn't unique the same way |
| File references | Held by `gateCode` |
| Vectors | Still found by search: the embedding stays, and was computed from text that named `gate` |
| Query indexes | Those on `gate` are dropped before the run; those on `gateCode` are prepared |

- `removeLink` deletes the links of that kind, their edits (edges and slots, cleared ones
  included) and the links a projection asserted.
- Lineage still names the edit that set a renamed value. When other edits share its instant, it
  names that instant instead of the commit.

## When a run stops

A run that stops midway (a crash, a lost connection) says how to finish it:

```text
[Sixb] Migration run migration_… stopped after 12 more batches:
  …
Nothing of a batch in flight was written. Run `sixb db migrate` to resume it.
```

- `sixb db migrate`, `sixb check --migrate` and `sixb dev` resume it at the next batch, from the
  steps it started with, whatever the code now declares.
- Until it ends, roles refuse to start, and a deploy keeps the previous release stopped
  ([During a deploy](../deployment/object-type-changes.md#during-a-deploy)).

## What it doesn't rewrite

- Events already in the outbox, workflow runs in flight and event history keep the old keys.
- Telemetry series: removing a telemetry property isn't supported yet.

## `sixb dev`

`sixb dev` runs the pending migrations on local data at startup. A change no migration covers is a
warning: the recorded shape stays as it was, so the migration runs once you add it.
