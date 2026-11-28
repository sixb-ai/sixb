# Storage migrations

`migrateStorage` is what every path that prepares storage calls: `sixb db migrate`,
`sixb check --migrate`, a role at startup, `sixb dev`. In order:

1. **Provider migrators** bring each adapter's schema up to date (`migration-set.ts`).
2. **The ontology step** (`type-shapes.ts`), when `ontologyShapes` names a mode, compares the shape
   the stored objects of each type fit with the code's.
3. **Query preparation**, which only adds indexes.
4. **Unique preparation** (`prepare-unique-properties.ts`), in every mode but `check`
   (`applyTypeShapes`): first a dry run that builds each property it would in a transaction that
   rolls back, so a duplicate fails while nothing is written; then the values for real. It leaves
   alone the types whose data the code doesn't fit: their values rebuilt for the code's shape would
   drop what a migration has to move. `sixb check --migrate` calls `applyTypeShapes` once its own
   probes passed.
5. **Recording** the new shapes, last, so nothing that can fail runs after it.

A deploy that fails therefore leaves no unique value prepared: the old release, started again,
would write such a property without keeping its values, and the next deploy would trust them. One
that fails after building them, before recording the shapes, still can: a property the deploy makes
unique, from the recorded shape to the code's, is built again from the objects, its dry run
included, whatever is prepared (`madeUnique`). A property made unique is a narrowing for the same
reason: it pauses writes, so the old release can't write a value another object holds while the
values are built.

## Stored type shapes

`ontology_type_shapes` holds one row per concrete type: its `TypeShape`
(`ontology/type-shapes.ts`, value types written in place, subtypes with their inherited
properties), the one recorded before it (`previous`), and when it was written. A deploy or `sixb
dev` that records a new shape over a stored one keeps the stored one as `previous`; a role never
changes it.

`checkTypeShapes` builds one `TypeShapeTypeCheck` per type in code or in storage:

- **Changes** come from `diffTypeShapes(stored, code)`, each `compatible`, `narrowing` or
  `refused`. Only the last two read data; a `refused` change with no data is recorded like a
  narrowing, since nothing is left to migrate.
- **Probes** (`OntologyTypeShapeStorage.holds` and `count`) are one `EXISTS` per store, joined by
  `OR`: objects, edits (`create`, `patch.set`, `unset`, edit times, losing edits included), live
  source rows (values, `absentSourcePropertyIds`, rows a delete hides), telemetry, links, link edits
  (`clear` and `legacy-conflict` included). `missingRequired` finds objects created by an edit with
  no live source row that lack the key, and edits whose `unset` cleared it: other projected values
  are the projection's.
- **A narrowed schema** is checked in JS, by `validatePropertyValue` over the edits that set the
  property (`listEdits` with `withValueOf`). Source values are left to the projection.
- **Counts** are read only for a change the probe found data for, to word the finding
  (`type-shape-messages.ts`).
- **Without a stored shape**, a type that holds nothing takes the code's shape. One that holds data
  gets a validation pass over every object and edit, plus `listHeldKeys` for links and series. It
  lists only the keys the data holds, and the primary property, so a renamed key diffs as removed
  and added; a held key the code declares takes the code's shape, then:
  - an undeclared key becomes `{ schema: "unknown", unknown: true }` (`mode: "telemetry"` for a
    series), an undeclared link `{ targets: [], cardinality: "many", unknown: true }`;
  - a value an edit's schema refuses makes the schema `"unknown"`;
  - a required property `missingRequired` finds data for is not required.

  The diff with the code then shows what needs a migration like any other change, and the type
  pauses writes: the old release may still write keys the code drops.

`next` says what recording writes: the code's shape, the baseline (`dev` only, when data doesn't
fit), the row's removal (a type gone from code that holds nothing), or nothing, when the stored
shape already is the code's.

## Modes

| Mode | Probes | Writes | On data the code doesn't fit |
|---|---|---|---|
| `check` | yes | nothing | returns the findings |
| `deploy` | yes | the code's shapes | throws `TypeShapeMismatchError`, writes nothing |
| `dev` | yes | the types that fit, the baseline of a new one that doesn't | warns |
| `role` | no | compatible changes, and the previous release's own changes back; the code's shape of a type holding nothing | throws on anything else |

`check` returns `narrows`, any type's `pausesWrites`: `sixb db migrate --check` exits 3 on it so the
live release stops before the shape is recorded, since the old code would write what the new shape
refuses. It asks for `uniqueDuplicates` first, so two objects sharing a value of a property the
code makes unique exit 1 instead: the unique dry run, while the live release serves, builds only
the values no preparation holds yet. A role started with `--no-migrate` checks and records in
`role` mode too.

Shapes alone can't tell newer code from older, so `roleCheck` goes by `previous`:

- **The code only adds or widens:** a compatible change, recorded.
- **The code is `previous`**, the release before a deploy, started again: it starts. Each property
  and link the deploy changed is decided alone: what the deploy narrowed goes back as the code
  defines it, so the next deploy probes it; what the deploy added or widened (a property, a link,
  an enum value, `nullable`, `required` dropped) stays recorded, since writing the old code's
  narrower definition would let the next deploy drop a key the data holds without probing it. A
  property the code makes unique, or one narrower both ways, is refused: a role can't build unique
  values, nor tell what the data fits. It records the merge only when it isn't the stored shape.
- **Anything else is refused**, newer code included: a role can't read what the data holds.

A type only the stored shapes hold is a newer release's: the role neither reads nor writes it.

## Concurrency

`recordTypeShapes` takes no lock when there is nothing to write. Otherwise it runs in one
transaction that first takes `typeShapes.lock` (`LOCK TABLE … SHARE ROW EXCLUSIVE` in PostgreSQL;
SQLite and in-memory writers are already serial). It re-reads each row: one that changed since the
check fails the recording, unless it already holds the shape to write, which is what roles starting
together see.
