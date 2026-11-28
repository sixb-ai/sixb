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
- A migration runs at most once per database. Delete it once every database has applied it;
  `sixb check` says when the code has moved past one, which then does nothing.

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

This release declares migrations and knows which are pending. It doesn't run them yet: a change a
pending migration covers still stops the deploy while objects hold it.

```text
✗ Job: 'gate' was removed, and 2,140 objects hold it.
  Migration 'job-gate' is pending; this build can't apply it yet.
```
