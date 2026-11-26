# Ontology migrations

`defineMigration(id, Type)` declares steps that move one object type's stored objects; discovery
loads them from `migrations/`. When the host loads, `validateMigrationsAtStartup` refuses only a
migration that can never be right (duplicate id, rename into itself, primary or telemetry target,
one subject twice). One the code has moved past is inert: `inertMigrations` names it for
`sixb check`, and it never stops a role. `run.ts` applies them; everything else here is pure.

## Pending by shape

`planPendingSteps` (`pending.ts`) decides, for one concrete type, which steps the shape its stored
objects fit still needs. There is no ledger: a step is pending exactly while its condition holds.

1. **Candidates.** Every step of every migration of the type or of an ancestor on its `extends`
   chain, kept when it concerns the type (`appliesTo`): a removed or renamed-from id the type
   doesn't declare, a `to`, fill or convert property it inherits unchanged.
2. **Fixpoint.** Each round takes the pending steps, refuses pairs that hold one subject, runs the
   first (renames, then values, then removals; then by migration id and index) on the shape, and
   repeats. Identical key steps of two migrations run once. The value steps of migrations in
   `settled` (see below) are left out, so an old convert doesn't re-arm on a second narrowing.
3. **Result.** The ordered steps, the shape they leave, the steps the stored shape blocks with
   why, the conflicts, and `storedKey`, which maps a property of the code back through renames.

Termination: removed and `from` ids are undeclared, `to`, fill and convert ids are declared, so no
step recreates what another consumes; each runs at most once.

`coverChanges` (`coverage.ts`) diffs the shape left with the code's. What is still not compatible
is missing a migration and is probed under its stored key; what the steps covered is probed as
before. A change is matched by its subject and what it asks of the data, so "added as required" and
"now required" are one. The gate (`storage/migrations/type-shapes.ts`) turns the missing changes
data holds into findings; a covered one runs, probed under its stored key, unless the storage
provider applies no migration. A value step resolves changes of the shape the renames leave
(`valueChanges`), not of the stored one: a convert of a renamed property's `to` has no change of
its own in the stored shape. Two such converts conflict on that change too, a finding in check
mode as in a deploy.

## Step kinds

`steps/` holds one `StepKind` per step: its phase, its conditions and effect on a shape, why it is
refused or inert, its subjects and the call `sixb check` suggests for the changes it resolves. The
algorithm, the validation and the messages only call these, so the steps that apply data add their
own members next to them.

| Subject role | Steps |
| --- | --- |
| `property` | `removeProperty`, the `from` of `renameProperty` |
| `renamedTo` | the `to` of `renameProperty` |
| `fill`, `convert` | `fillProperty`, `convertProperty`: one of each may be pending together |
| `link` | `removeLink` |

`convertProperty` is pending only on a narrowing, not on any schema difference: a convert kept in
the repo doesn't rewrite values again when its property later widens.

## The run

`migrateStorage` finishes an open run first, then checks the shapes; `applyTypeShapes` runs what
the check planned, between the unique preparation's dry run and its real run
(`storage/migrations/README.md` gives the whole order).

`applyOntologyMigrations` (`run.ts`):

1. **Plan.** Each type whose check has `run` steps and no finding: its stored (or baseline) shape,
   the code's, and the steps as `OntologyMigrationStoreStep`s. The plan is stored with the run;
   nothing reads the code again. The value steps' functions run here and stage their results
   (`plan-values.ts`, below); a failure discards the staging and throws.
2. **Point of no return**, in one transaction that takes the shapes' lock: the shapes the check
   read are still stored; the kernel execution `ontology.migrate`, which every batch commit cites;
   then `startRun` records the run `applying` with its lanes, marks the planned types' shapes
   `migrating` and drops the project's replacement plans (caches that may hold the keys).
3. **Lanes** until every one is done, then `finishRun`: shapes become `toShape`, `current`, the run
   `applied`, its migrations settled; pg then runs `ANALYZE` on what the run rewrote.

A failure stops every lane at its next batch and rethrows every lane's error with the resume
command. `resumeOntologyMigration` continues the open run's lanes from their cursors, whatever code
runs it.

**Telling the deploy.** `onStarted` (`StorageMigrationOptions.onMigrationRunStarted`) fires once a
run is past its point of no return: right after `startRun` commits, or before a resume. The CLI's
migrating commands (`sixb check --migrate`, `sixb db migrate`) write the run's id to the file
`SIXB_MIGRATION_RUN_MARKER` names (`cli/src/lib/storage-migration.ts`). The SSH target sets it,
removes the file before the command and reads it after, whatever the command's outcome: a run that
started leaves the previous release stopped for good, a storage migration pending beside it (exit 3)
or a failure after `finishRun` included. A deploy-internal contract, not a public option.

## Lanes and batches

`startRun` fixes the lanes (`migrationLanes` in `storage/ontology/migrations.ts`). They touch
disjoint rows, so a provider applies `parallelism` objects lanes side by side, plus the source
lanes beside them; each batch is one `applyBatch`, in one transaction, set-based:

| Lane | Batch | Stores |
| --- | --- | --- |
| `objects`, one per range of a type | up to `batchRows` objects and edits by primary id, ending at the lower of the two last keys | `objects` (`version + 1`, `last_commit_id`), edits (`create.properties`, `patch.set`, `unset`, edit times), vectors whose source held a key, links and link edits by source id; then the values the run staged |
| `sources`, one per root-key range of a type | up to `batchRows` source roots of one version, by root key, every version in turn | source row values and `absentSourcePropertyIds` |
| `derived`, per type | up to `batchRows` rows | unique values and their preparation, then the staged unique keys, then artifact refs, then source rows of removed links (with their versions' `assertion_count`) |

- **Ranges.** pg splits a type's objects into up to `parallelism` primary-id ranges, and its
  source roots into as many root-key ranges, from a `TABLESAMPLE` of the partition (or of
  `ontology_source_roots`) whose quantiles `percentile_disc` computes in SQL: at most
  `parallelism - 1` keys come back, even from a table never analyzed (sized from its pages then).
  `parallelism` is the pool size less one, at most `MAX_PARALLELISM` (6, from a 1/2/4/6/8
  sweep). SQLite has one writer: `parallelism` 1, one range per kind, lanes one after another.
  In memory, 2, so the suite runs several ranges.
- **Derived rows** go in batches too: unique values, then the properties' preparation, then
  artifact refs walked in key order, each batch bounded like the others. pg walks unique values by
  heap page (TID ranges up to the table's size at the first batch) when the properties hold at
  least a quarter as many values as the table has pages, and one property at a time by key
  otherwise. Values in `value_hash` order lie on random pages: a walk by key reads about one
  random page per value, so a large property would read every page many times over. Source rows
  of removed links go by source id after the cursor, every row of the last id a batch reaches with
  it: the link-source index also holds the links the type keeps, which a batch starting from the
  type's first entry would walk again each time.
- **No touches.** Only replacement plans read commit touches, and `startRun` drops them all; writes
  are paused, roles refuse a `migrating` shape and `sixb dev` starts its workers after migrating, so
  no plan opens before `finishRun`.
- One statement per store: `compileMigrationSteps` folds a type's steps into the keys rows are
  rewritten for (removed ids and renamed `from`s), the renames, and the removed links. The
  removed and `to` ids are disjoint (a `from` is undeclared, a `to` declared), so dropping every
  key then adding each `to` the row held is one expression (`moveKeys`, and in SQL `moved`).
- The batch commit (runtime origin, the run's start as its time, no change listed, as a
  snapshot's base commit) is named by (run, lane, batch) and written only when an object or an edit
  changed. No outbox row.
- Each lane's cursor, batch count and counts are saved last, in the batch's transaction, on the
  lane's row; `applyBatch` refuses a stale `batches`, so two appliers never both apply a batch. A
  crash rolls back the batches in flight and nothing else.
- Telemetry is never rewritten: a telemetry removal isn't pending (`steps/remove-property.ts`).
- `updated_at` stays: the migration changes the shape, not the business.

## Renames

A rename moves what already exists instead of rebuilding it:

- **Edit times** move with their values, so lineage still finds the edit. It finds it by its
  instant: when other edit commits share it and none names the new id, lineage names the instant.
- **Unique values.** Nothing is prepared before the run. The plan says per rename whether
  `from`'s values move (`unique: "move"`: they were prepared with the key kind and version `to`
  compares by) or go (`drop`). Either way the derived lane first deletes whatever `to` held, its
  preparation included: a release that once made `to` unique may have left one no object backs.
  It then moves `property_id` in the same walk that deletes a removed key's (by page or by key, as
  under "Lanes and batches"), and the preparation after the run finds them current. When they can't move and
  `to` is unique, the dry run before the run (`checkUniqueProperties`) builds `to`'s values from
  those under `from` and rolls back, so a duplicate fails before the point of no return; the
  preparation after the run builds them for real.
- **Vectors.** `source_fingerprint` hashes key names, so the objects lane recomputes it in JS for
  the batch's vectors of a moved profile (`OntologyMigrationRunType.vectors`: the code's profiles
  whose source names a `to`, with their configuration under the old keys), from the values the
  object holds before the batch. A vector that doesn't match them, or of another configuration,
  is deleted like a removed key's. The embedding is kept: it was computed from text that named the
  old key. Indexing queued for those profiles moves the same way (`request.configuration` and
  `sourceFingerprint`), so `prepare` doesn't discard it; it goes only when its object no longer
  holds the values it was asked for.
- **Query structures** (PostgreSQL). Only sort and text count indexes carry their definition, so
  `startRun` matches what `pg_get_indexdef`, `pg_get_statisticsobjdef` and `pg_get_expr` print
  (`properties -> '<key>'::text` or `->>`) on the type's partition and on the generated columns of
  `objects`, and drops it before any batch, so the rewrite doesn't maintain it. A text column
  filtered on the key is found by its count index's comment. The preparation record goes with
  them, and `applyTypeShapes` prepares queries again after the run. Adding or dropping a generated
  column changes `objects`' row type, which aborts a transaction that runs a statement cached
  with `*`: the reads unique preparation and lineage run in transactions name their columns.
  Tagging every query structure, as visibility indexes are (`visibility-indexes.ts`), would make
  the match exact.

## Fills and converts

A value step computes values in JavaScript, once, before the point of no return (`plan-values.ts`);
the run then applies them as it applies key steps, set-based, from storage.

1. **Read.** Per type, `migrations.values.listValueTargets` pages the ids whose edits the steps
   read, under their stored keys through the run's renames: every `create` edit and every patch
   that unsets the property for a fill, every edit giving the property a value (losing ones
   included) for a convert. `readState` reads pages of 1,000, as many side by side as the
   provider's `parallelism`; the next page is read while this one runs, and one staging write
   stays in flight.
2. **Per object, in step order.** Key steps move the edit, its times and the source row
   (`moveKeys`); a value step calls its function on the object they leave
   (`resolveEffectiveObject`):
   - a fill, for a `create` edit whose effective value is missing, unless a projection feeds the
     property: the object's source row holds it or names it absent, or one of the code's
     projections maps it (`computeProjectionOwnership`), whose next run would be masked. A
     `patch` that cleared the property, which the gate counts as missing, gets the value in
     `patch.set`, and the id leaves its `unset` (`restored`), unless a projection feeds it: then
     the object fails, since no fill may edit a projected property;
   - a convert, on each edit value, in place, keeping its edit time; not on a value a fill of this
     run gave, already in the new schema.
   Edit times are read as materialization reads them (`storedObjectEditedAt`: a legacy row's are
   its update's). The result is normalized as a commit normalizes it
   (`validateObjectAuthorityProperties`), may hold no file reference (attaching one needs the right
   to edit the file), and an object its edit created is validated whole (`validateEffectiveObject`).
   A projected object is checked on its edit values only: its source values are the projection's.
3. **Stage.** What changes goes to `stageValues` under the run's id (`StagedObjectValues`): edit
   values, a fill's edit time (the run's start), the effective values that change, per unique
   property the key the object releases (from its stored row, under the id it holds until the
   run) and the one it claims, and vector indexing requests for the profiles whose source
   fingerprint changes. Nothing is staged once one object failed; every
   failure is still collected, up to 100 named.
4. **Unique keys,** in storage, in place of `checkUniqueProperties`' dry run, which leaves the
   run's value properties out (`valued`): their stored values are not the ones the run leaves.
   The check: two staged objects taking one key, then a staged key an object
   outside the staging holds (only for the properties whose other values stay), looked up under
   the id the values are stored by until the run: a moving rename's `from`. A unique
   property whose keys change kind is `rebuild`: every object's key is staged to check it, and
   `prepareUniqueProperties` builds it after the run, as for a newly unique property; otherwise
   `update`.

Any failure throws `[Sixb] Migration 'x' cannot apply: N objects fail.` with the lines, and the
caller discards the staging: the deploy's failure path restarts the old release.

**Apply.** In each objects batch, after its key steps: edits take the staged values
(`create.properties` or `patch.set`, by their kind), objects the effective ones, at one version more
unless the key steps already bumped them in the batch (`last_commit_id` is the batch's commit), and
vector work is upserted pending, for the orchestrator's maintenance pass. A type with only value
steps sizes its batches by staged rows. The derived lane then updates `update` properties' unique
values from the staged keys, after a rename's moves: every staged key is released before any is
claimed, so two objects may swap values across batches.

The staging is a plain table in PostgreSQL, not unlogged: after the point of no return it is the
only copy of what the functions returned. `startRun` drops other runs' staging (a plan that never
started); `finishRun` drops the run's.

## Settled migrations

A migration's value steps run at most once per database, per type: a fill or a convert computes
values, and running it again on a later narrowing of its property would rewrite what was already
converted. Key steps are idempotent by shape: a removal is pending whenever a recorded shape holds
the key, so an old release that wrote the key back after a rollback just has it removed again.

A migration settles for a type when a run applies it there (`finishRun`), or when the code's shape
is recorded for the type, or found recorded, while the migration has a step that concerns it
(`recordTypeShapes`, from the check's `settles`): a new database, a role's first shapes, or a deploy
where no data needed it. A migration whose steps
the type declares again concerns a later version of the code and stays unsettled. Pending is still
decided by shape, so branches compose; the settled set only stops value steps re-arming.
