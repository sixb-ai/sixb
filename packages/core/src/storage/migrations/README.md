# Storage migrations

`migrateStorage` is what every path that prepares storage calls: `sixb db migrate`,
`sixb check --migrate`, a role at startup, `sixb dev`. In order:

1. **Provider migrators** bring each adapter's schema up to date (`migration-set.ts`).
2. **An open migration run** is finished, in every mode but `role`: it is past its point of no
   return (`migrations/run.ts`).
3. **The ontology step** (`type-shapes.ts`), when `ontologyShapes` names a mode, compares the shape
   the stored objects of each type fit with the code's.
4. **Query preparation**, which only adds indexes. When the check found steps to run, it waits
   for the run (7): every batch would otherwise maintain the indexes on a renamed key's new id.
5. **Unique preparation, first as a dry run** (`checkUniqueProperties`): each property preparation
   would build is built in a transaction that rolls back, so a duplicate fails the deploy while
   nothing is written and the old release can still start. A renamed property is read under its
   old id, unless the run moves its values as they are.
6. **Migration steps** the check found data for run (`deploy`, `dev`; `applyTypeShapes`): the
   point of no return.
7. **Unique preparation** for real (`prepare-unique-properties.ts`), from the objects the run
   left: the values a run moved are current, those it dropped are gone. It leaves alone the types
   whose data the code doesn't fit: their values rebuilt for the code's shape would drop what a
   migration has to move. Query preparation then builds what the code needs, the indexes on
   renamed keys' new ids included.
8. **Recording** the new shapes, last, so nothing that can fail runs after it, and settling the
   migrations past which they are recorded (`migrations/README.md`).

`check` stops after 4: `sixb check --migrate` calls `applyTypeShapes` once its own probes passed.
A deploy that fails before the point of no return therefore leaves no unique value prepared: the
old release, started again, would write such a property without keeping its values, and the next
deploy would trust them. One that fails after building them, before recording the shapes, still
can: a property the deploy makes unique, from the recorded shape to the code's, is built again
from the objects, its dry run included, whatever is prepared (`madeUnique`). So is a rename's,
unless the recorded shape has its old id unique (`uniqueValuesMove`). A run records the code's
shapes as it finishes, so a crash before the preparation would leave such values trusted: right
before the point of no return, those the recorded shape doesn't keep unique are dropped, and a
fill or a convert of one checks every object's key. A property made unique is a narrowing for the same
reason: it pauses writes, so the old release can't write a value another object holds while the
values are built.

## Stored type shapes

`ontology_type_shapes` holds one row per concrete type: its `TypeShape`
(`ontology/type-shapes.ts`, value types written in place, subtypes with their inherited
properties), the one recorded before it (`previous`), its state, and when it was written. A deploy
or `sixb dev` that records a new shape over a stored one keeps the stored one as `previous`; a
migration run leaves none, since the release before it can't serve what it rewrote; a role never
changes it. The state is `migrating` while a run is past its point of no return: every mode but
`check` then throws `OntologyMigrationApplyingError`, and `check` returns the types in `applying`
alone.

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
- **Migrations.** Given the project's migrations, `classifyTypeChanges` sorts the changes from the
  shapes alone, through `coverChanges` (`migrations/coverage.ts`): missing a migration, runnable,
  or blocked (no migration applied by this storage, or a fill or a convert on one without
  `migrations.values`). Each is read under the key a pending rename leaves. A missing one data
  holds gets the `defineMigration(...)` lines that would cover it; a runnable one goes to the type's
  `run` steps, on a probe alone, since the run counts what it rewrites; a blocked one names the
  migrations.

`next` says what recording writes: the code's shape, the baseline (`dev` only, when data doesn't
fit), the row's removal (a type gone from code that holds nothing), or nothing, when the stored
shape already is the code's.

## Modes

| Mode | Probes | Writes | On data the code doesn't fit |
|---|---|---|---|
| `check` | yes | nothing | returns the findings |
| `deploy` | yes | migration runs, then the code's shapes | throws `TypeShapeMismatchError`, writes nothing |
| `dev` | yes | migration runs and the types that fit, the baseline of a new one that doesn't | warns |
| `role` | no | compatible changes, and the previous release's own changes back; the code's shape of a type holding nothing | throws on anything else |

`check` returns `narrows`, any type's `pausesWrites`: `sixb db migrate --check` exits 3 on it so the
live release stops before the shape is recorded, since the old code would write what the new shape
refuses. It asks for `uniqueDuplicates` first, so two objects sharing a value of a property the
code makes unique exit 1 instead: the unique dry run, while the live release serves, builds only
the values no preparation holds yet. It exits 4 on `applying`, a run past its point of no return:
the deploy keeps the old release stopped and the migrating command finishes the run. A role
started with `--no-migrate` checks and records in `role` mode too.

Shapes alone can't tell newer code from older, so `roleCheck` goes by `previous`:

- **The code only adds or widens:** a compatible change, recorded.
- **The code is `previous`**, the release before a deploy, started again: it starts. Each property
  and link the deploy changed is decided alone: what the deploy narrowed goes back as the code
  defines it, so the next deploy probes it; what the deploy added or widened (a property, a link,
  an enum value, `nullable`, `required` dropped) stays recorded, since writing the old code's
  narrower definition would let the next deploy drop a key the data holds without probing it. A
  property the code makes unique, or one narrower both ways, is refused: a role can't build unique
  values, nor tell what the data fits. It records the merge only when it isn't the stored shape.
- **Anything else is refused**, newer code included: a role can't read what the data holds. After
  a migration run, `previous` is empty: the release before it is refused too.

A type only the stored shapes hold is a newer release's: the role neither reads nor writes it.
While a run is past its point of no return, every role refuses to start, whatever its code.

## Concurrency

`recordTypeShapes` takes no lock when there is nothing to write. Otherwise it runs in one
transaction that first takes `typeShapes.lock` (`LOCK TABLE … SHARE ROW EXCLUSIVE` in PostgreSQL;
SQLite and in-memory writers are already serial). It re-reads each row: one that changed since the
check fails the recording, unless it already holds the shape to write, which is what roles starting
together see.
